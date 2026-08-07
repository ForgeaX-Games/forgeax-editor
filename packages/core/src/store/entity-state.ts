// entity-state — the activeWorld read face (M3: handle IS identity).
//
// feat-20260707-editor-world-fork-ssot-level-load-play-activeworld M3 (I1):
// The former "double-identity translation" layer (the legacy id-to-handle maps
// plus their mapping/allocator/enumeration helpers) is DELETED. The runtime
// editor identity IS the engine EntityHandle. Every helper here takes a World + an
// EntityHandle and reads that world directly (the caller passes gateway.activeWorld
// — play mode -> playWorld, edit mode -> editWorld). This file is now purely the
// activeWorld read face and the single stale-entity-handle error normalization
// point (D-4).
//
// Handle reads:
//   - entName / entExists / entParent / entComponents return plain values for UI
//     convenience (entExists === false is itself the detectable stale signal);
//   - entComponent returns a StaleHandleResult so a stale handle is an explicit,
//     structured error (code 'stale-entity-handle') distinct from a component
//     that is merely absent on a live entity — the exact charter-P3 defect that
//     research Finding 13 named (the old code returned undefined for both).
//
// Entity ENUMERATION (former per-session id-set/handle-set/root-set helpers) is
// now a world walk: worldEntityHandles(world) runs a Name query (createQueryState
// + queryRun) to list every live handle; worldRootHandles(world) filters to
// entities with no live ChildOf parent. These replace the legacy-map keyset the
// deleted helpers walked.
//
// Anchors:
//   requirements AC-01: entity-state full handle<->id mapping ops deleted
//   requirements AC-14: stale-entity-handle structured error (.code/.hint/.objectRefs.entity)
//   plan-strategy D-4: read helper normalized to Result on stale handle
//   plan-strategy §2.5: entity-state.ts net-reduction (double-map -> read face)
//   research Finding 13: current entComponent returns undefined for stale ids (P3)

import { Name, ChildOf, Transform } from '@forgeax/engine-scene';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
// EditorHidden is editor-core's own marker component (plan-strategy §2 D-7), NOT
// an engine export — importing it from @forgeax/engine-runtime is the exact
// `Socket`-class regression AGENTS.md anti-pattern #5 warns about (would trip
// TS2305 under the strict engine-.d.ts typecheck gate).
import { EditorHidden } from '../components/EditorHidden';
import {
  getRegisteredComponents,
  createQueryState,
  queryRun,
  Disabled,
  Entity,
} from '@forgeax/engine-ecs';
import type { World } from '@forgeax/engine-ecs';
import type { EntityHandle } from '../scene/scene-types';
import {
  createEntityObjectRef,
  type ErrorSubjectRef,
} from '@forgeax/editor-product';
import {
  validateHandlePair,
  type HandlePair,
  type HandlePairBinding,
  type HandlePairStaleReason,
  type WorldMismatchError,
} from './handle-pair';

// ── Structured error types (D-4 / AC-14) ───────────────────────────────────

/** The stale-entity-handle error returned when an EntityHandle is no longer
 *  valid in the target World (despawned, from a previous play session, etc.).
 *  plan-strategy D-4 / AC-14: structured error with self-rescue hint.
 *
 *  M5 (w27, D-8): when the read went through the super handle-pair three-layer
 *  check, `detail.reason` narrows WHY the handle is stale so an AI/human picks the
 *  right self-rescue — 'world-epoch-mismatch' (whole-world reload; rebuild
 *  selection) vs 'stale-entity' (this entity despawned; re-query). The field is
 *  OPTIONAL: the legacy fallback path (no binding, e.g. play mode) omits it. */
export interface StaleEntityHandleError {
  readonly code: 'stale-entity-handle';
  /** Self-rescue path for AI and human consumers — re-query the active world
   *  or call getSelection() to obtain a fresh handle. */
  readonly hint: string;
  /** The stable entity ref and optional world-bound locator that triggered the error. */
  readonly objectRefs: { readonly entity: ErrorSubjectRef };
  /** Present when the super handle-pair check produced this error — narrows the
   *  stale cause (D-8). Absent on the legacy isStale fallback path. */
  readonly detail?: { readonly reason: HandlePairStaleReason; readonly engineCode?: string };
}

/** The component-not-present error returned when the handle is LIVE but the
 *  requested component is simply absent on it. Distinct code from
 *  stale-entity-handle so a caller can tell "wrong handle" from "no such
 *  component" (research Finding 13 P3 fix — no more conflated undefined). */
export interface ComponentAbsentError {
  readonly code: 'component-absent';
  readonly hint: string;
  readonly objectRefs: { readonly entity: ErrorSubjectRef; readonly component: ErrorSubjectRef };
}

/** Result shape for entity read operations: ok with value, or a structured
 *  error. Consistent with gateway.dispatch() return type (charter P4).
 *  M5 (w27): may also carry a WorldMismatchError when the read went through the
 *  super handle-pair check and the handle belonged to the wrong world (D-8). */
export type StaleHandleResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: StaleEntityHandleError | ComponentAbsentError | WorldMismatchError };

/** The edit-rejected-in-play error returned when a document-domain dispatch is
 *  attempted while gateway.mode === 'play'. plan-strategy D-5: play-mode write
 *  gate — document ops are rejected with this code; session ops pass through.
 *  (Wired in gateway.dispatch, M2.) */
export interface EditRejectedInPlayError {
  readonly code: 'edit-rejected-in-play';
  /** Self-rescue path — stop play mode before editing. */
  readonly hint: string;
}

const STALE_HINT =
  'handle does not survive a play/stop boundary; re-query activeWorld or call getSelection() for a fresh handle';

/** True when `world.get(handle, Name)` fails specifically because the handle is
 *  stale/despawned (engine code 'stale-entity'). A component-absent failure on a
 *  live entity is NOT stale. Name is intrinsic (every live entity has it), so its
 *  failure is a reliable liveness probe. */
function isStale(world: World, handle: EntityHandle): boolean {
  const r = world.get(handle, Name);
  return !r.ok;
}

/** Studio cross-game switch clears `gateway.doc.world` before the next createApp
 *  injects a fresh world. Read helpers must tolerate a missing world (Fail Soft)
 *  so Hierarchy/Inspector Rows that still hold stale fiber props do not throw on
 *  `undefined.get(...)`. */
function hasWorld(world: World | null | undefined): world is World {
  return world != null;
}

const NO_WORLD_HINT =
  'activeWorld is unavailable (cross-game realm gap); wait for the next createApp inject';

// ── Active read-binding provider (IoC seam — world-manager fills it) ──────────
//
// feat-20260709-editor-world-partition VERIFY finding-3 (defense-in-depth):
// production READ points (Inspector) call entComponent(activeWorld, id) without
// opts, so they fell back to the legacy `isStale` liveness probe and never ran
// the three-layer validateHandlePair check (world-mismatch / epoch / generation).
// This seam lets a DAG-downstream package (edit-runtime's WorldManager) publish
// the live (worldRef, epoch, world) binding of the ACTIVE read world, so a read
// point can build HandleCheckOpts and run the structured check at the read seam —
// not only inside the reload collar's revalidateSelection.
//
// Same IoC direction as registerSelectionBindingProvider / the ApiClient seam
// (core defines the seam; edit-runtime satisfies it — DAG-legal, RD4). Headless
// core / play mode leave it unset, so reads keep the legacy fallback unchanged.
//
// Scope note (VERIFY finding-3): wired into the Inspector primary read only; other
// read points (Hierarchy, viewport, host-session) stay on the legacy path as a
// documented follow-up — editorWorld is unreachable via gateway.dispatch, so this
// is hardening, not a bug fix (see verify.md finding 2/B1 adjudication).
let activeReadBindingProvider: (() => HandlePairBinding | undefined) | null = null;

/** Register the active read-world binding provider (world-manager, at boot).
 *  Returns an idempotent unregister fn. The provider supplies the live
 *  (worldRef, epoch, world) binding a read point validates a selection pair
 *  against — so entComponent reads can run the three-layer check (D-4). */
export function registerActiveReadBinding(
  fn: () => HandlePairBinding | undefined,
): () => void {
  activeReadBindingProvider = fn;
  return () => {
    if (activeReadBindingProvider === fn) activeReadBindingProvider = null;
  };
}

/** The live binding of the active read world, or undefined when no provider is
 *  registered (headless core / play mode) — callers then omit opts and read via
 *  the legacy liveness fallback. */
export function getActiveReadBinding(): HandlePairBinding | undefined {
  return activeReadBindingProvider?.();
}

/** Check `handle`'s liveness, preferring the super handle-pair three-layer check
 *  when a binding is available (D-4). Returns `null` when the handle is valid;
 *  otherwise the structured error (world-mismatch or stale-entity-handle with a
 *  narrowed `.detail.reason`).
 *
 *  Contract (w27): callers pass a `binding` — the live (worldRef, epoch, world)
 *  target — AND the pair epoch/worldRef the handle was minted with. When no
 *  binding is available (headless / play mode), it falls back to the plain
 *  `isStale` liveness probe and returns a reason-less stale error (compat). */
function checkHandle(
  world: World,
  handle: EntityHandle,
  binding: HandlePairBinding | undefined,
  pairMeta: { worldRef: number; epoch: number } | undefined,
): StaleEntityHandleError | WorldMismatchError | null {
  if (binding !== undefined && pairMeta !== undefined) {
    const pair: HandlePair = { worldRef: pairMeta.worldRef, epoch: pairMeta.epoch, entity: handle };
    const v = validateHandlePair(pair, binding);
    if (v.ok) return null;
    // Pass the structured error through verbatim: world-mismatch stays
    // world-mismatch; stale-entity-handle keeps its narrowed detail.reason.
    return v.error;
  }
  // Missing world (cross-game gap): treat as stale so Result callers stay structured.
  if (!hasWorld(world)) {
    return {
      code: 'stale-entity-handle',
      hint: NO_WORLD_HINT,
      objectRefs: { entity: createEntityObjectRef({ handle, ...pairMeta }) },
    };
  }
  // Legacy fallback (no binding): plain liveness, reason-less stale error.
  return isStale(world, handle)
    ? {
      code: 'stale-entity-handle',
      hint: STALE_HINT,
      objectRefs: { entity: createEntityObjectRef({ handle, ...pairMeta }) },
    }
    : null;
}

// ── Entity enumeration (replaces entIds / entHandles / entRootHandles) ──────

/** Run `queryRun` over every live entity carrying ALL of `withTokens` — INCLUDING
 *  entities carrying the engine `Disabled` marker. The engine query auto-excludes
 *  Disabled unless `Disabled` is explicitly in `with` (which then REQUIRES it), so
 *  full coverage is the UNION of two passes: one ordinary (enabled entities) and
 *  one with Disabled appended (hidden entities). Works on every engine pin — no
 *  engine change required (editor-side answer to harness feedback
 *  2026-08-04-ecs-query-needs-disabled-opt-out-for-editor-enumeration).
 *  Editor enumeration MUST see hidden entities: the Hierarchy eye is the unhide
 *  entry, and select-all / show-all / pack collection need the full set.
 *  `Entity` must be among `withTokens` for `bundle.Entity.self` to populate. */
export function queryEachIncludingDisabled(
  world: World,
  withTokens: ReadonlyArray<unknown>,
  visit: (handle: number) => void,
): void {
  const alreadyDisabled = withTokens.includes(Disabled);
  const passes: ReadonlyArray<ReadonlyArray<unknown>> = alreadyDisabled
    ? [withTokens]
    : [withTokens, [...withTokens, Disabled]];
  type EntityColumn = { self?: { length: number; [i: number]: number } };
  for (const withList of passes) {
    // The engine query generics don't flow through a dynamic `with`, so the
    // runtime shapes are erased to `unknown` and narrowed at the read site (the
    // store/ AC-06 gate forbids the colon-any annotation, so none appear here).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = createQueryState({ with: withList as any[] } as any);
    queryRun(
      state as unknown as Parameters<typeof queryRun>[0],
      world as unknown as Parameters<typeof queryRun>[1],
      (bundle: unknown) => {
        const entities = (bundle as { Entity?: EntityColumn }).Entity?.self;
        if (!entities) return;
        for (let i = 0; i < entities.length; i++) {
          const h = entities[i];
          if (h !== undefined) visit(h);
        }
      },
    );
  }
}

/** Every live entity handle in `world` — a Name query walk (Name is intrinsic,
 *  so this covers all live entities, hidden ones included). Replaces the
 *  deleted enumeration helpers that iterated the legacy-map keyset. */
export function worldEntityHandles(world: World): EntityHandle[] {
  if (!hasWorld(world)) return [];
  const out: EntityHandle[] = [];
  queryEachIncludingDisabled(world, [Name, Entity], (h) => out.push(h as EntityHandle));
  return out;
}

/** Every live entity carrying MeshFilter + MeshRenderer — the viewport pick
 *  candidate set (bug-20260806 GLB 选不中). Unlike worldEntityHandles (Name
 *  query), this covers GLB mount-internal mesh nodes that carry NO Name —
 *  the glTF bridge only stamps Name on nodes with a non-empty glTF name, so a
 *  Name-keyed enumeration makes unnamed mesh nodes unpickable. Hidden
 *  (Disabled / EditorHidden-chain) entities are INCLUDED here; visibility
 *  filtering is the consumer's job (the pick sweep applies
 *  isEntEffectivelyHidden per candidate). */
export function worldRenderableHandles(world: World): EntityHandle[] {
  if (!hasWorld(world)) return [];
  const out: EntityHandle[] = [];
  queryEachIncludingDisabled(world, [MeshFilter, MeshRenderer, Entity], (h) => out.push(h as EntityHandle));
  return out;
}

/** Root entity handles = live entities with no live `ChildOf` parent. An entity
 *  is a root when it carries no ChildOf, or its ChildOf.parent is not itself a
 *  live handle (a detached parent — e.g. the synthetic SceneInstance root that
 *  the editor does not track). Replaces the deleted entRootHandles. */
export function worldRootHandles(world: World): EntityHandle[] {
  if (!hasWorld(world)) return [];
  const all = worldEntityHandles(world);
  const live = new Set<number>(all as unknown as number[]);
  const roots: EntityHandle[] = [];
  for (const h of all) {
    const co = world.get(h, ChildOf);
    if (!co.ok || !live.has((co.value as { parent: number }).parent)) {
      roots.push(h);
    }
  }
  return roots;
}

// ── Entity info accessors (activeWorld read face) ───────────────────────────

/** Entity existence: a live handle in `world` (Name resolves). This is the
 *  detectable stale signal for the plain-return helpers (false === stale/absent).
 *  Missing world (cross-game gap) → false. */
export function entExists(world: World, handle: EntityHandle): boolean {
  if (!hasWorld(world)) return false;
  return world.get(handle, Name).ok;
}

/** Get entity name from the world (SSOT). Returns a `#<handle>` fallback for a
 *  stale handle so UI never renders `undefined`; callers needing to DISTINGUISH
 *  stale from live use entExists / entComponent (which carry the structured
 *  error). Missing world → same `#<handle>` fallback. */
export function entName(world: World, handle: EntityHandle): string {
  if (!hasWorld(world)) return `#${handle}`;
  const r = world.get(handle, Name);
  if (r.ok) return r.value.value;
  return `#${handle}`;
}

/** Parent handle of `handle`, or null for a root (no live ChildOf).
 *  Missing world → null. */
export function entParent(world: World, handle: EntityHandle): EntityHandle | null {
  if (!hasWorld(world)) return null;
  const r = world.get(handle, ChildOf);
  if (!r.ok) return null;
  const parent = (r.value as { parent: number }).parent as EntityHandle;
  // A ChildOf whose parent is dead is treated as a root (matches worldRootHandles).
  return world.get(parent, Name).ok ? parent : null;
}

/** Optional super handle-pair inputs (w27). When BOTH are supplied, entComponent /
 *  entComponents run the three-layer check (D-4) instead of the plain isStale
 *  probe, so the returned error carries a narrowed `.detail.reason` (epoch vs
 *  generation) or a `world-mismatch` code. Omit both for the legacy path. */
export interface HandleCheckOpts {
  readonly binding: HandlePairBinding;
  readonly pair: { worldRef: number; epoch: number };
}

/** Get a specific component's value dict as a StaleHandleResult (D-4 / AC-14).
 *  - live handle + component present -> { ok:true, value };
 *  - stale/despawned handle          -> { ok:false, error: stale-entity-handle };
 *  - wrong world (super check)        -> { ok:false, error: world-mismatch };
 *  - live handle + component absent   -> { ok:false, error: component-absent }.
 *  The codes are distinct so callers can tell "wrong handle" from "wrong world"
 *  from "no such component" (Finding 13 P3 fix + D-8). When `opts` is supplied the
 *  stale path carries `.detail.reason` narrowing epoch vs generation. */
export function entComponent(
  world: World,
  handle: EntityHandle,
  compName: string,
  opts?: HandleCheckOpts,
): StaleHandleResult<Record<string, unknown>> {
  if (!hasWorld(world)) {
    return {
      ok: false,
      error: {
        code: 'stale-entity-handle',
        hint: NO_WORLD_HINT,
        objectRefs: { entity: createEntityObjectRef({ handle, ...opts?.pair }) },
      },
    };
  }
  const bad = checkHandle(world, handle, opts?.binding, opts?.pair);
  if (bad !== null) return { ok: false, error: bad };
  const token = resolveReadToken(compName);
  if (token !== undefined) {
    const r = world.get(handle, token as Parameters<typeof world.get>[1]);
    if (r.ok) return { ok: true, value: r.value as Record<string, unknown> };
  }
  return {
    ok: false,
    error: {
      code: 'component-absent',
      hint: `component '${compName}' is not present on this entity`,
      objectRefs: {
        entity: createEntityObjectRef({ handle, ...opts?.pair }),
        component: { kind: 'component', id: compName },
      },
    },
  };
}

/** Component dict by walking the engine component registry against the world.
 *  Returns {} for a stale/invalid handle (entExists is the stale probe for
 *  callers that must distinguish). M3: reads the passed world (activeWorld), no
 *  legacy map. w27: when `opts` is supplied, an invalid pair (wrong world / stale
 *  epoch / despawned) yields {} via the three-layer check. */
export function entComponents(
  world: World,
  handle: EntityHandle,
  opts?: HandleCheckOpts,
): Record<string, unknown> {
  if (!hasWorld(world)) return {};
  if (checkHandle(world, handle, opts?.binding, opts?.pair) !== null) return {};
  const out: Record<string, unknown> = {};
  for (const [name, token] of getRegisteredComponents()) {
    const r = world.get(handle, token as Parameters<typeof world.get>[1]);
    if (r.ok) out[name] = r.value;
  }
  return out;
}

/** Map every live entity handle in `world` to the list of component names it
 *  carries — derived STRUCTURALLY (one query per registered component; a query
 *  matches archetypes, so a component the entity LACKS is never touched and no
 *  `ComponentNotPresentError` is ever constructed).
 *
 *  This is the list-level metadata source. Views that only need "which components
 *  does this entity have" (the Hierarchy type column / filter / hidden flag) must
 *  read names from this map, NOT call `entComponents` per row: the latter probes
 *  ALL registered components with `world.get`, eagerly building a stack-carrying
 *  Error on every miss — O(entities × all-registered-components) allocations that
 *  dominated a Hierarchy re-render. Full component VALUES (for the selected entity)
 *  still go through entComponent/entComponents in the Inspector. Missing world → {}.
 *
 *  Cost: O(registered-components × archetypes) query matching + O(present pairs)
 *  collection, all zero-allocation on the error path. Callers build it ONCE per
 *  render pass (structural changes are what re-render the tree) and index into it. */
export function worldComponentNames(world: World): Map<EntityHandle, string[]> {
  const map = new Map<EntityHandle, string[]>();
  if (!hasWorld(world)) return map;
  type EntityColumn = { self?: { length: number; [i: number]: number } };
  for (const [name, token] of getRegisteredComponents()) {
    // `Entity` is in the query `with` so the row-handle column populates (same
    // convention as worldEntityHandles). Hidden entities included via the same
    // union walk — the Hierarchy hidden flag / type column must see them.
    queryEachIncludingDisabled(world, [token, Entity], (h) => {
      let names = map.get(h as EntityHandle);
      if (names === undefined) { names = []; map.set(h as EntityHandle, names); }
      names.push(name);
    });
  }
  return map;
}

/** Value dict for ONLY the components named in `names` — a zero-miss read: every
 *  `world.get` hits (the names came from `worldComponentNames`, i.e. the entity's
 *  own archetype), so no `ComponentNotPresentError` is constructed. Use this for a
 *  list row that needs a FEW component values (e.g. the mobility hint) after
 *  deriving the name set structurally, instead of `entComponents`' probe-all-and-
 *  catch-misses loop. Missing world / unknown name → skipped. */
export function entComponentsPresent(
  world: World,
  handle: EntityHandle,
  names: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!hasWorld(world)) return out;
  for (const name of names) {
    const token = resolveReadToken(name);
    if (token === undefined) continue;
    const r = world.get(handle, token as Parameters<typeof world.get>[1]);
    if (r.ok) out[name] = r.value;
  }
  return out;
}

// ── Component token resolution (known tokens fast-path + registry) ──────────

const _readTokenCache = new Map<string, unknown>();
(function seed() {
  _readTokenCache.set('Name', Name);
  _readTokenCache.set('Transform', Transform);
  _readTokenCache.set('ChildOf', ChildOf);
  _readTokenCache.set('EditorHidden', EditorHidden);
})();

function resolveReadToken(name: string): unknown {
  const cached = _readTokenCache.get(name);
  if (cached !== undefined || _readTokenCache.has(name)) return cached;
  const tok = getRegisteredComponents().get(name);
  _readTokenCache.set(name, tok);
  return tok;
}
