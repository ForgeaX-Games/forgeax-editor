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
import { activeSpan, type EngineInterfaceName } from './trace';

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
 *  (e.g., per-frame scaffolding writes — OOS-5 / D-2 harmonization). */
function _recordLeaf(name: EngineInterfaceName): void {
  const span = activeSpan();
  if (span) {
    span.attributes.engineCalls.push(name);
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

  constructor(world: World) {
    this._world = world;
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
