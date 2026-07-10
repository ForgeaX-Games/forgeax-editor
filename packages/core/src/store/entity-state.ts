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
//   requirements AC-14: stale-entity-handle structured error (.code/.hint/.entity)
//   plan-strategy D-4: read helper normalized to Result on stale handle
//   plan-strategy §2.5: entity-state.ts net-reduction (double-map -> read face)
//   research Finding 13: current entComponent returns undefined for stale ids (P3)

import { Name, ChildOf, Transform } from '@forgeax/engine-runtime';
// EditorHidden is editor-core's own marker component (plan-strategy §2 D-7), NOT
// an engine export — importing it from @forgeax/engine-runtime is the exact
// `Socket`-class regression AGENTS.md anti-pattern #5 warns about (would trip
// TS2305 under the strict engine-.d.ts typecheck gate).
import { EditorHidden } from '../components/EditorHidden';
import {
  getRegisteredComponents,
  createQueryState,
  queryRun,
  Entity,
} from '@forgeax/engine-ecs';
import type { World } from '@forgeax/engine-ecs';
import type { EntityHandle } from '../scene/scene-types';
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
  /** The stale entity handle that triggered the error. */
  readonly entity: EntityHandle;
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
  readonly entity: EntityHandle;
  readonly component: string;
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
  // Legacy fallback (no binding): plain liveness, reason-less stale error.
  return isStale(world, handle)
    ? { code: 'stale-entity-handle', hint: STALE_HINT, entity: handle }
    : null;
}

// ── Entity enumeration (replaces entIds / entHandles / entRootHandles) ──────

/** Every live entity handle in `world` — a Name query walk (Name is intrinsic,
 *  so this covers all live entities). Replaces the deleted enumeration helpers
 *  that iterated the legacy-map keyset. */
export function worldEntityHandles(world: World): EntityHandle[] {
  const out: EntityHandle[] = [];
  // `Entity` must be in the query `with` for `bundle.Entity.self` (the row
  // handle column) to be populated — same convention query-snapshot.ts uses.
  // The engine query generics don't flow through a dynamic `with`, so the
  // runtime shapes are erased to `unknown` and narrowed at the read site (the
  // store/ AC-06 gate forbids the colon-any annotation, so none appear here).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = createQueryState({ with: [Name, Entity] as any[] });
  type EntityColumn = { self?: { length: number; [i: number]: number } };
  queryRun(
    state as unknown as Parameters<typeof queryRun>[0],
    world as unknown as Parameters<typeof queryRun>[1],
    (bundle: unknown) => {
      const entities = (bundle as { Entity?: EntityColumn }).Entity?.self;
      if (!entities) return;
      for (let i = 0; i < entities.length; i++) {
        const h = entities[i];
        if (h !== undefined) out.push(h as EntityHandle);
      }
    },
  );
  return out;
}

/** Root entity handles = live entities with no live `ChildOf` parent. An entity
 *  is a root when it carries no ChildOf, or its ChildOf.parent is not itself a
 *  live handle (a detached parent — e.g. the synthetic SceneInstance root that
 *  the editor does not track). Replaces the deleted entRootHandles. */
export function worldRootHandles(world: World): EntityHandle[] {
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
 *  detectable stale signal for the plain-return helpers (false === stale/absent). */
export function entExists(world: World, handle: EntityHandle): boolean {
  return world.get(handle, Name).ok;
}

/** Get entity name from the world (SSOT). Returns a `#<handle>` fallback for a
 *  stale handle so UI never renders `undefined`; callers needing to DISTINGUISH
 *  stale from live use entExists / entComponent (which carry the structured
 *  error). */
export function entName(world: World, handle: EntityHandle): string {
  const r = world.get(handle, Name);
  if (r.ok) return r.value.value;
  return `#${handle}`;
}

/** Parent handle of `handle`, or null for a root (no live ChildOf). */
export function entParent(world: World, handle: EntityHandle): EntityHandle | null {
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
      entity: handle,
      component: compName,
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
  if (checkHandle(world, handle, opts?.binding, opts?.pair) !== null) return {};
  const out: Record<string, unknown> = {};
  for (const [name, token] of getRegisteredComponents()) {
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
