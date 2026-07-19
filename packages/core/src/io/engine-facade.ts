// io/engine-facade — the sole controlled proxy for engine World mutation
//
// feat-20260707-editor-trace-ioc M2 t9/t10:
// EngineFacade is the only legal path for engine world writes outside of
// document appliers (gateway A, plan-strategy §2 D-6). It is hand-written
// (not Proxy — OOS-3) and covers the full world-mutation surface needed by
// appliers + viewport scaffolding.
//
// M2 t9 (executor + ctx): provided the basic pass-through facade. t10 adds
// leaf interface name recording (AC-09): each write method records its
// engine interface name (e.g. 'world.set') into the current active span's
// attributes.engineCalls list. When no active span exists (e.g., per-frame
// scaffolding writes outside dispatch), no root span is created — this is
// the natural harmonization point between AC-05 ("via ctx therefore trace")
// and OOS-5 ("camera writes not required to enter spans").
//
// Anchors:
//   plan-strategy §2 D-2: facade instantiated with world handle at boot
//   plan-strategy §2 D-6: facade is the gate definition — lint-unique-mutator's sole allowed file
//   requirements AC-01: ApplierCtx type has no world field
//   requirements AC-05: scaffolding writes go through ctx.engine (trace only)
//   requirements AC-09: leaf engine interface names in span attributes
//   requirements OOS-3: no runtime Proxy interception

import type {
  Component,
  ComponentData,
  ComponentSchema,
  EcsError,
  EntityHandle,
  Handle,
  InputShapeOf,
  Result,
  ShapeOf,
  World,
} from '@forgeax/engine-ecs';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { PackError } from '@forgeax/engine-pack/errors';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { AssetError, SceneAsset } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { activeSpan, type EngineInterfaceName } from './trace';

// feat-20260708-editor-io-layer-enrich M2 (w7): the SINGLE editor-side
// "engine interface name -> side-effect hint" table (SSOT, AC-07 / D-4). It
// lives HERE, next to _recordLeaf (the sole fill point), so the fill is
// single-point and every leaf hint is traceable to a literal in this table.
// There must be NO second Record<EngineInterfaceName, ...> anywhere (the AC-07
// falsification point — grep-asserted by trace-side-effect-hints.test.ts).
//
// Each entry is an editor-side DECLARATIVE contract description — worded "by
// contract may trigger ...", NOT "actually triggers ...". This is a seam
// declaration, not engine real runtime causality: the real side-effect SSOT
// belongs at the engine interface definition (North-Star §7), which is
// cross-repo and OOS-1 (explicitly excluded). Hard-coding real causality here
// would be AGENTS.md anti-pattern #1 (hand-rolling engine behavior); we do NOT.
//
// Anchors:
//   requirements AC-07: single mapping table (SSOT), fill traceable to entry
//   plan-strategy §2 D-4: table SSOT in engine-facade.ts, single-point fill
//   plan-strategy §2 D-5: contract-description wording, not real causality
const ENGINE_SIDE_EFFECT_HINTS: Partial<Record<EngineInterfaceName, string>> = {
  'world.set':
    'by contract may mark affected render/spatial systems dirty for the next frame',
  'world.spawn':
    'by contract may insert the entity into archetype storage and spatial indices',
  'world.despawn':
    'by contract may remove the entity from archetype storage and trigger spatial index rebuild',
  'world.allocSharedRef':
    'by contract may pin a shared asset payload until the last handle is released',
  'world.addComponent':
    'by contract may migrate the entity to a new archetype and mark dependent systems dirty',
  'world.removeComponent':
    'by contract may migrate the entity to a new archetype and mark dependent systems dirty',
  'registry.instantiateFlat':
    'by contract may spawn a collected SceneAsset subtree as live world entities, re-acquiring shared asset (material/mesh) handles from their GUIDs',
};

// M3 t16 (CI-typecheck fix feat-20260707): the facade's write methods forward the
// engine World's OWN branded types (EntityHandle / Result<T, EcsError> / Handle) so
// (a) view-scaffold callers that consumed `world.spawn(...).unwrap()` keep working
// verbatim after swapping their `world` receiver for the injected `engine` facade,
// and (b) the structure is a genuine `Pick<World, …>` — appliers get a real
// EntityHandle-in / Result-out surface, not a loose `number`/`unknown` approximation
// that only passed under the editor's shim d.ts and broke under engine's real .d.ts.
// The facade is a pure forwarding proxy (plan-strategy §4 AC-06: same-name same-shape
// methods) that adds only trace-leaf recording; each method mirrors the matching
// World method signature exactly, so `Pick<World, …>` and the facade stay structurally
// interchangeable and no `as any` transport lies leak through the seam.

/** Record a leaf engine interface name onto the current active span's
 *  attributes, if an active span exists. No-op when outside any span
 *  (e.g., per-frame scaffolding writes — OOS-5 / D-2 harmonization).
 *
 *  After pushing engineCalls (unchanged, D-3), it also derives a declarative
 *  side-effect hint from the SSOT table (w7, AC-06/07): if the table has an
 *  entry AND this interface has not already been pushed onto sideEffects (dedup
 *  key = engineInterface, D-8), push {engineInterface, hint}. A missing table
 *  entry is silently skipped (requirements boundary: sideEffects may be shorter
 *  than engineCalls, never throws). */
function _recordLeaf(name: EngineInterfaceName): void {
  const span = activeSpan();
  if (!span) return;
  span.attributes.engineCalls.push(name);
  const hint = ENGINE_SIDE_EFFECT_HINTS[name];
  if (hint === undefined) return;
  const already = span.attributes.sideEffects.some((h) => h.engineInterface === name);
  if (!already) {
    span.attributes.sideEffects.push({ engineInterface: name, hint });
  }
}

/**
 * The sole controlled proxy for engine World writes.
 *
 * Every world.set / world.spawn / world.despawn / world.allocSharedRef call
 * outside of this file is a lint violation (gateway A, plan-strategy §2 D-6).
 *
 * Each method mirrors the matching `World` method signature verbatim (branded
 * `EntityHandle` in, `Result<T, EcsError>` out) — the facade is structurally a
 * `Pick<World, …>`, which is exactly what `EngineWriteProxy` casts it to.
 */
export class EngineFacade {
  /** The underlying engine world. Read-only access through the facade only. */
  private _world: World;

  /** The engine AssetRegistry, injected at boot alongside the world (doc.registry).
   *  Needed by instantiateSceneAssetFlat to run GUID→live-handle resolution
   *  (registry.instantiateFlat). Optional: headless / pre-boot facades (e.g. the
   *  world-manager editorWorld facade) have no registry and cannot instantiate
   *  scene assets — the method returns a structured NO_REGISTRY error there. */
  private _registry: AssetRegistry | undefined;

  constructor(world: World, registry?: AssetRegistry) {
    this._world = world;
    this._registry = registry;
  }

  /** Read a component value from an entity. Does NOT record a leaf — reads
   *  are not writes and do not belong in trace attributes (AC-09). */
  get<S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
  ): Result<ShapeOf<S>, EcsError> {
    return this._world.get(entity, component);
  }

  /** Set a component field on an entity. Records 'world.set' leaf when an
   *  active span exists (AC-09). */
  set<S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
    value: Partial<InputShapeOf<S>>,
  ): Result<void, EcsError> {
    _recordLeaf('world.set');
    return this._world.set(entity, component, value);
  }

  /** Spawn a new entity with initial components. Records 'world.spawn' leaf.
   *  Forwards the engine's Result<EntityHandle> so callers keep `.unwrap()`. */
  spawn<const SArr extends readonly ComponentSchema[]>(
    ...componentDatas: {
      [K in keyof SArr]: {
        component: Component<string, SArr[K]>;
        data: Partial<InputShapeOf<SArr[K]>>;
      };
    }
  ): Result<EntityHandle, EcsError> {
    _recordLeaf('world.spawn');
    return this._world.spawn(...componentDatas);
  }

  /** Despawn an entity and its components. Records 'world.despawn' leaf.
   *  Forwards the engine's Result<void>. */
  despawn(entity: EntityHandle): Result<void, EcsError> {
    _recordLeaf('world.despawn');
    return this._world.despawn(entity);
  }

  /** Allocate a shared reference to an asset (chrome casting, not an op).
   *  Records 'world.allocSharedRef' leaf. Forwards the engine's opaque
   *  `Handle<Target, 'shared'>`. */
  allocSharedRef<Target extends string, T>(
    target: Target,
    payload: T,
    onLastRelease?: (payload: T) => void,
  ): Handle<Target, 'shared'> {
    _recordLeaf('world.allocSharedRef');
    return this._world.allocSharedRef(target, payload, onLastRelease);
  }

  /** Resolve a catalogued asset GUID string to a live shared<T> handle
   *  SYNCHRONOUSLY (feat-20260713 M7 / AC-10, D-5 editor front-door clip binder).
   *
   *  This is the synchronous half of `loadByGuid`: it reads the registry's
   *  `assetCatalog` fast-path (already-catalogued payload) and mints a shared
   *  handle via `allocSharedRef` — the SAME loadByGuid→allocSharedRef spine the
   *  drag-spawn resolver (drag-spawn-resolve.ts) and preview closure
   *  (host-session.ts) use, but sync so it can run INSIDE a synchronous document
   *  applier (applyAddComponent / applySetComponent). The async fetch-from-pack
   *  path is intentionally NOT used here: the front-door binder always operates
   *  on an already-imported (catalogued) asset, and the async fire-and-forget
   *  door already exists (`bindAssetRef` session op). A GUID that is not
   *  catalogued returns a structured miss so the applier fails fast (charter P3 /
   *  Fail Fast) rather than passing the string through — which the engine's M2 P3
   *  gate now rejects with `shared-field-invalid-value`.
   *
   *  Lives here (not in the applier) because minting a handle needs both the raw
   *  world (`allocSharedRef`, gated to this file by lint-unique-mutator) and the
   *  AssetRegistry (catalog read). Records the same 'world.allocSharedRef' leaf as
   *  a direct alloc. `target` is the shared<T> tag (e.g. 'AnimationClip'). */
  resolveSharedGuid(
    target: string,
    guid: string,
  ): Result<number, { code: 'NO_REGISTRY' | 'BAD_GUID' | 'ASSET_NOT_CATALOGUED'; hint: string }> {
    if (!this._registry) {
      return err({
        code: 'NO_REGISTRY' as const,
        hint: 'this facade has no AssetRegistry (headless / pre-boot world); GUID resolution is unavailable',
      });
    }
    const parsed = AssetGuid.parse(guid);
    if (!parsed.ok) {
      return err({ code: 'BAD_GUID' as const, hint: `not a valid asset GUID: ${guid}` });
    }
    const key = AssetGuid.format(parsed.value).toLowerCase();
    const envelope = this._registry.assetCatalog.get(key);
    if (envelope === undefined) {
      return err({
        code: 'ASSET_NOT_CATALOGUED' as const,
        hint: `GUID ${guid} is not catalogued; import the asset (or use the async bindAssetRef op) before binding`,
      });
    }
    _recordLeaf('world.allocSharedRef');
    const handle = this._world.allocSharedRef(target, envelope.payload) as unknown as number;
    return ok(handle);
  }

  /** Instantiate a collected `SceneAsset` (from `rootsToSceneAsset`) as live
   *  world entities, preserving authored `ChildOf` (flat — no synthetic
   *  SceneInstance root). This is the write-gated re-instantiate half of the
   *  scene-asset round-trip used by the `duplicateEntity` / paste appliers.
   *
   *  Why it MUST live here (not in an applier): the sequence touches the raw
   *  world (`allocSharedRef`) and needs the AssetRegistry to run GUID→live-handle
   *  resolution (`registry.instantiateFlat` calls `_resolveSceneGuids`). Passing
   *  a raw SceneAsset to `world.instantiateScene` directly skips that resolution
   *  and crashes with `SharedRefReleasedError` on the material handles — the
   *  registry entrypoint is the ONLY path that re-acquires them. Records a
   *  'registry.instantiateFlat' leaf. Returns the new top-level roots. */
  instantiateSceneAssetFlat(
    asset: SceneAsset,
  ): Result<EntityHandle[], AssetError | PackError | EcsError | { code: 'NO_REGISTRY'; hint: string }> {
    if (!this._registry) {
      return err({
        code: 'NO_REGISTRY' as const,
        hint: 'this facade has no AssetRegistry (headless / pre-boot world); scene-asset instantiate is unavailable',
      });
    }
    _recordLeaf('world.allocSharedRef');
    const handle = this._world.allocSharedRef('SceneAsset', asset);
    _recordLeaf('registry.instantiateFlat');
    return this._registry.instantiateFlat(
      handle as Handle<'SceneAsset', 'shared'>,
      this._world,
    );
  }

  /** Add a component to an entity. Records 'world.addComponent' leaf. */
  addComponent<S extends ComponentSchema>(
    entity: EntityHandle,
    componentData: ComponentData<S>,
  ): Result<void, EcsError> {
    _recordLeaf('world.addComponent');
    return this._world.addComponent(entity, componentData);
  }

  /** Remove a component from an entity. Records 'world.removeComponent' leaf. */
  removeComponent<S extends ComponentSchema>(
    entity: EntityHandle,
    component: Component<string, S>,
  ): Result<void, EcsError> {
    _recordLeaf('world.removeComponent');
    return this._world.removeComponent(entity, component);
  }

  /** Internal: access the raw world for backward-compatible document applier
   *  wrapping (t9 adapter). NOT part of the public ApplierCtx surface. */
  _rawWorld(): World {
    return this._world;
  }
}

/**
 * Mint an EngineFacade bound to an arbitrary World.
 *
 * feat-20260709-editor-world-partition-editorworld-super-composite / M4 (w18):
 * world-manager owns the editorWorld and needs its OWN controlled write proxy —
 * the gateway's `engineFacade()` binds to `doc.world` (= sceneWorld) and must not
 * be repurposed for the editorWorld (D-5: dual-track writes — editorWorld through
 * a DEDICATED facade instance, sceneWorld still through gateway dispatch). Raw
 * `new EngineFacade(...)` stays inside this file so lint-unique-mutator's "raw
 * world writes live only in engine-facade.ts" invariant holds: world-manager
 * calls this factory instead of touching the World directly. The number of
 * facade INSTANCES is unbounded by the gate — the gate only forbids raw
 * world.set/spawn/despawn outside this file, and every facade write is still
 * routed through EngineFacade's own methods here.
 */
export function createEngineFacade(world: World, registry?: AssetRegistry): EngineFacade {
  return new EngineFacade(world, registry);
}
