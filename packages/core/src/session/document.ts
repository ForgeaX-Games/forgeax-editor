// applyCommand — world-based imperative mutation (M7: EntityNode deleted).
//
// feat-20260701-editor-world-container-doc-ecs-collapse M7 / AC-15:
// Dual-write mirror helpers (legacy*) + doc.entities/order/nextLocalId removed.
// Legacy ID → engine handle mapping via SessionInternals (_e2h/_h2e).
// childrenOf root case reads from internal _e2h keys + world ChildOf.
//
// Anchors:
//   requirements AC-01: applyCommand 9 case → session.world
//   requirements AC-06: spawn no resolver seam
//   requirements AC-15: EntityNode/doc.entities zero hits
//   requirements AC-17: three independent lights (scheme A)
//   plan-strategy S2 D-1/D-3/D-7: applyCommand→world, Light A, EditorHidden

import type {
  ApplyResult,
  EditorOp,
  EditSession,
  EntityId,
} from '../types';

import {
  ChildOf,
  Children,
  MeshFilter,
  MeshRenderer,
  Name,
  Transform,
} from '@forgeax/engine-runtime';
import { getRegisteredComponents } from '@forgeax/engine-ecs';
import type { World } from '@forgeax/engine-ecs';
import type { EntityHandle } from '../scene/scene-types';
import { EditorHidden } from '../components/EditorHidden';
import { getInternals } from './edit-session';
import { EngineFacade } from '../io/engine-facade';
import { entHandle, entLegacyId, entMap, entUnmap, entNextId, entSetNextId, entGetNextId, entIds, entParent } from '../store/entity-state';

export { createEditSession } from './edit-session';

// ── IoC context for document appliers (plan-strategy §2 D-2, AC-01) ─────────
// F-1 (implement-review round 1): the 9 document appliers previously took an
// `EditSession` and wrote through `session.world` directly — bypassing the
// EngineFacade, so (a) `.world` was type-visible inside applier bodies (AC-01
// unmet for the document domain) and (b) their span leaves were never recorded
// (AC-09 empty for every document op). The fix inverts the dependency: an
// applier now receives a `DocApplierCtx` whose ONLY world access is the
// controlled `engine` proxy (routes through EngineFacade._recordLeaf → span
// attributes) plus an opaque id map. `ctx.world` does not exist — writing it is
// a tsc error (the ctx-world-negative guard test proves this).

/** Typed engine-write proxy handed to document appliers via `ctx.engine`.
 *  Structurally it IS the EngineFacade instance (cast at the executor / applyCommand
 *  boundary), but typed as the World read/write surface so appliers keep full type
 *  safety on reads (`.value.value`, `.value.entities`, …) WITHOUT ever holding a raw
 *  `world` handle (AC-01). Every write routes through EngineFacade and records its
 *  engine interface leaf onto the active span (AC-09). Reads (`get`) record nothing. */
export type EngineWriteProxy = Pick<World, 'get' | 'set' | 'spawn' | 'despawn' | 'addComponent' | 'removeComponent'>;

/** Legacy EntityId <-> engine handle mapping exposed to document appliers.
 *  Replaces the `EditSession` argument (D-2: EditSession no longer enters the
 *  applier signature). Backed by the same SessionInternals maps via entity-state
 *  helpers — behavior-identical, only the access shape changed. */
export interface DocIdMap {
  handle(id: EntityId): EntityHandle | undefined;
  legacyId(handle: EntityHandle): EntityId | undefined;
  map(id: EntityId, handle: EntityHandle): void;
  unmap(id: EntityId, handle: EntityHandle): void;
  nextId(): EntityId;
  getNextId(): EntityId;
  setNextId(id: EntityId): void;
}

/** Read-side query snapshot function shape (mirrors io/query-snapshot's
 *  QuerySnapshotFn). Kept structural here to avoid a session→io type import;
 *  document appliers don't consume it, but it is part of the established M2 ctx
 *  contract (t12a) so it stays on the ctx. */
export type DocQueryFn = (descriptor: unknown) => unknown;

/** The IoC context every DOCUMENT applier receives (plan-strategy §2 D-2).
 *  engine (controlled write proxy) + ids (mapping) + dispatchSub (recursive
 *  transaction dispatch) + query (read side, carried for the M2 ctx contract).
 *  Deliberately NO `world` field — `ctx.world` in an applier body is a tsc error
 *  (AC-01 negative; ctx-world-negative guard). */
export interface DocApplierCtx {
  engine: EngineWriteProxy;
  ids: DocIdMap;
  dispatchSub(ctx: DocApplierCtx, sub: EditorOp): ApplyResult;
  query: DocQueryFn;
}

/** Build a DocIdMap over a session's internal id<->handle maps. Used by the
 *  executor (gateway) and by the public `applyCommand` wrapper to construct a
 *  ctx from a session without leaking the session (or its world) into appliers. */
export function docIdMapForSession(session: EditSession): DocIdMap {
  return {
    handle: (id) => entHandle(session, id),
    legacyId: (h) => entLegacyId(session, h),
    map: (id, h) => entMap(session, id, h),
    unmap: (id, h) => entUnmap(session, id, h),
    nextId: () => entNextId(session),
    getNextId: () => entGetNextId(session),
    setNextId: (id) => entSetNextId(session, id),
  };
}

// ── Component token resolution ─────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CToken = any;

const _cmpCache = new Map<string, CToken | undefined>();

function resolveToken(name: string): CToken | undefined {
  const cached = _cmpCache.get(name);
  if (cached !== undefined || _cmpCache.has(name)) return cached;
  const tok = getRegisteredComponents().get(name);
  _cmpCache.set(name, tok);
  return tok;
}
(function _seedCache() {
  _cmpCache.set('Name', Name);
  _cmpCache.set('Transform', Transform);
  _cmpCache.set('ChildOf', ChildOf);
  _cmpCache.set('EditorHidden', EditorHidden);
})();

// ── Helpers ───────────────────────────────────────────────────────────────────

function clone<T>(v: T): T {
  return structuredClone(v);
}

function spawnComponentData(
  name: string,
  parent: EntityHandle | null,
  extraComponents?: Record<string, unknown>,
): Array<{ component: CToken; data: Record<string, unknown> }> {
  const transformDefaults: Record<string, unknown> = {
    posX: 0, posY: 0, posZ: 0,
    quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
    scaleX: 1, scaleY: 1, scaleZ: 1,
  };
  if (extraComponents?.Transform) {
    Object.assign(transformDefaults, extraComponents.Transform as Record<string, unknown>);
  }
  const out: Array<{ component: CToken; data: Record<string, unknown> }> = [
    { component: Name, data: { value: name } },
    { component: Transform, data: transformDefaults },
  ];
  if (parent !== null) {
    out.push({ component: ChildOf, data: { parent } });
  }
  const BASELINE_NAMES = new Set(['Name', 'Transform', 'ChildOf', 'MeshRenderer']);
  // verify F-1 (round 1): `Editor*`-prefixed keys are intentional transient
  // editor-side markers (e.g. `EditorPendingMeshAsset`, carrying a real GUID for
  // the edit-runtime drag-spawn resolver to consume via `lastCommand.components`
  // BEFORE this drop happens). They are DESIGNED never to reach the world — so
  // dropping them here is expected, not the data-loss case below. Skipping them
  // keeps the migration warning a true signal (real orphaned vocabulary only),
  // instead of firing on every mesh drag and drowning out genuine divergence.
  const isIntentionalEditorMarker = (n: string): boolean => n.startsWith('Editor');
  if (extraComponents) {
    let hasMeshFilter = false;
    for (const [compName, value] of Object.entries(extraComponents)) {
      if (BASELINE_NAMES.has(compName)) continue;
      if (isIntentionalEditorMarker(compName)) continue;
      const tok = resolveToken(compName);
      if (tok) {
        out.push({ component: tok, data: (value ?? {}) as Record<string, unknown> });
        if (compName === 'MeshFilter') hasMeshFilter = true;
      } else {
        // F-1 review round 1 (charter P3 — fail loud, never silently drop):
        // an unregistered component name means an UPSTREAM producer is still
        // emitting a vocabulary this collapse deleted (e.g. legacy `Mesh` /
        // `Material` / `GltfRef` from a not-yet-migrated glTF import path). The
        // component was previously dropped with no signal → geometry vanished
        // (AGENTS.md #2 data-loss). Warn so the divergence surfaces at author
        // time instead of as a mysteriously empty entity on reopen.
        console.warn(
          `[editor] spawnComponentData: unknown component '${compName}' dropped — ` +
          `upstream producer still emits a component this editor does not register. ` +
          `Migrate it to an engine-native component (MeshFilter/MeshRenderer/Transform/…).`,
        );
      }
    }
    if (hasMeshFilter && !(extraComponents as Record<string, unknown>).MeshRenderer) {
      // Attach an EMPTY MeshRenderer so the entity is renderable WITHOUT minting a
      // synthetic material. The engine's render walk is gated on MeshRenderer
      // presence (render-system-extract `with: [MeshRenderer]`), so a
      // MeshFilter-only entity is archetype-absent and never drawn — the
      // MeshRenderer must exist. But we must NOT allocSharedRef a default
      // MaterialAsset here: that handle is never cataloged, so on save
      // collect-scene-asset's `_guidForAsset` returns undefined and throws
      // SceneCollectAssetGuidUnresolvedError, aborting the whole write (the scene
      // silently fails to save). An empty `materials: []` routes through the
      // engine's OWN default-material fallback (defaultMaterialSnapshot → mid-grey
      // unlit) — identical in Edit and Play — and serializes with zero material
      // handles to resolve, so save never sees an unresolved handle. (SSOT: the
      // engine already owns the default-material concept; the editor must not
      // hand-roll a parallel one.)
      out.push({
        component: MeshRenderer as unknown as CToken,
        data: { materials: [] },
      });
    }
  }
  return out;
}

// ── ID mapping (legacy ID ↔ engine handle) ─────────────────────────────────

// The editor's legacy IDs and the engine's entity handles are both raw numbers
// at runtime; toEntity resolves a legacy ID to its live handle. Brand the result
// as EntityHandle so every engine.get/set/addComponent/removeComponent below is
// type-correct without per-call casts (the fallback `id` is only hit for
// unmapped ids, which the immediately-following existence check rejects).
function toEntity(ids: DocIdMap, id: number): EntityHandle {
  return (ids.handle(id) ?? id) as EntityHandle;
}

// ── Per-op document appliers (plan-strategy §2 D-1, requirements S11 / AC-25) ─
// Each of the 9 document primitives extracted from applyCommand's switch as
// standalone applier functions (bodies byte-identical, no logic change).
// M1 t2: spawnEntity / destroyEntity / rename / reparent
// M1 t3: setComponent / addComponent / removeComponent / setHidden
// M1 t4: transaction (delegated through dispatchSub module-level dispatch)

// ── t2.1 spawnEntity applier ────────────────────────────────────────────────

export function applySpawnEntity(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  const { engine, ids } = ctx;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  const reuse = cmd._id !== undefined && !ids.handle(cmd._id);
  const id: number = reuse ? (cmd._id as number) : ids.nextId();
  if (reuse && id >= ids.getNextId()) ids.setNextId(id + 1);
  const parent = cmd.parent ?? null;
  const parentEng = parent !== null ? toEntity(ids, parent) : parent;
  if (parentEng !== null && !engine.get(parentEng, Name).ok) {
    if (!reuse) ids.setNextId(id);
    return { ok: false, error: { code: 'INVALID_PARENT', hint: `parent ${parent} does not exist` } };
  }
  const compData = spawnComponentData(cmd.name ?? `Entity ${id}`, parentEng, cmd.components);
  const r = engine.spawn(...compData as any);
  if (!r.ok) { if (!reuse) ids.setNextId(id); return { ok: false, error: { code: 'SPAWN_FAILED', hint: String(r.error) } }; }
  const eH = r.value as EntityHandle;
  cmd._id = id;
  ids.map(id, eH);
  return { ok: true, inverse: { kind: 'destroyEntity', entity: id } };
}

// ── t2.2 destroyEntity applier ───────────────────────────────────────────────

export function applyDestroyEntity(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  const { engine, ids } = ctx;
  const eH = toEntity(ids, cmd.entity);
  if (!engine.get(eH, Name).ok) {
    return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
  }
  // Collect subtree via engine handles
  // Handles walked here are live engine entity handles (eH + Children members).
  const idStack: EntityHandle[] = [eH];
  const visitedEng = new Set<EntityHandle>();
  const entries: Array<{ eId: EntityHandle; legacyId: EntityId | undefined; name: string; comps: Record<string, unknown> }> = [];
  while (idStack.length > 0) {
    const ce = idStack.pop()!;
    if (visitedEng.has(ce)) continue;
    visitedEng.add(ce);
    const nr = engine.get(ce, Name); const nm = nr.ok ? nr.value.value : '?';
    const comps: Record<string, unknown> = {};
    for (const [cn, ct] of [['Transform', Transform], ['ChildOf', ChildOf], ['MeshFilter', MeshFilter], ['EditorHidden', EditorHidden]] as [string, CToken][]) {
      const cr = engine.get(ce, ct); if (cr.ok) comps[cn] = clone(cr.value);
    }
    const nc = engine.get(ce, Name); if (nc.ok) comps['Name'] = clone(nc.value);
    entries.push({ eId: ce, legacyId: ids.legacyId(ce), name: nm, comps });
    const chR = engine.get(ce, Children);
    if (chR.ok && chR.value.entities != null) {
      const arr = chR.value.entities as { readonly length: number; [index: number]: number };
      for (let ci = 0; ci < arr.length; ci++) if (!visitedEng.has(arr[ci]! as EntityHandle)) idStack.push(arr[ci]! as EntityHandle);
    }
  }
  // Despawn bottom-up
  for (const entry of [...entries].reverse()) {
    const dr = engine.despawn(entry.eId);
    if (!dr.ok) return { ok: false, error: { code: 'DESPAWN_FAILED', hint: String(dr.error) } };
    if (entry.legacyId !== undefined) ids.unmap(entry.legacyId, entry.eId);
  }
  const spawnCmds: EditorOp[] = entries.map((e) => ({
    kind: 'spawnEntity' as const,
    name: e.name, parent: null, components: e.comps,
    _id: e.legacyId ?? (e.eId as number),
  }));
  const rootName = entries[0]?.name ?? `Entity ${cmd.entity}`;
  return { ok: true, inverse: spawnCmds.length === 1 ? spawnCmds[0]! : { kind: 'transaction', label: `undo destroy ${rootName}`, commands: spawnCmds } };
}

// ── t2.3 rename applier ──────────────────────────────────────────────────────

export function applyRename(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  const { engine, ids } = ctx;
  const eH = toEntity(ids, cmd.entity);
  const nameR = engine.get(eH, Name);
  if (!nameR.ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
  const before = nameR.value.value;
  const r = engine.set(eH, Name, { value: cmd.name });
  if (!r.ok) return { ok: false, error: { code: 'RENAME_FAILED', hint: String(r.error) } };
  return { ok: true, inverse: { kind: 'rename', entity: cmd.entity, name: before } };
}

// ── t2.4 reparent applier ────────────────────────────────────────────────────

export function applyReparent(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  const { engine, ids } = ctx;
  const eH = toEntity(ids, cmd.entity);
  if (!engine.get(eH, Name).ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
  const parentEng = cmd.parent !== null ? toEntity(ids, cmd.parent) : null;
  if (cmd.parent !== null && !engine.get(parentEng!, Name).ok) {
    return { ok: false, error: { code: 'INVALID_PARENT', hint: `parent ${cmd.parent} not found` } };
  }
  if (cmd.parent === cmd.entity) {
    return { ok: false, error: { code: 'INVALID_PARENT', hint: 'cannot parent an entity to itself' } };
  }
  const coR = engine.get(eH, ChildOf);
  // Inverse must carry the LEGACY EntityId of the prior parent, not the raw
  // engine handle — undo re-dispatches through toEntity(legacyId) (merge
  // origin/main: reparent-desync test asserts inverse.parent === legacyId).
  const beforeHandle = coR.ok ? (coR.value.parent as EntityHandle) : null;
  const before = beforeHandle !== null ? ids.legacyId(beforeHandle) ?? null : null;
  if (parentEng !== null) {
    // ChildOf is a relationship (exclusive arm): reparent MUST go through
    // addComponent so the engine's relationship hook fires and keeps the
    // bidirectional Children mirror in sync (remove-from-old + add-to-new). A
    // bare engine.set — even when ChildOf is already present — skips the
    // exclusive-arm handling and desyncs Children (the exact node-hidden bug the
    // harness recorded: feedbacks/2026-07-07-hierarchy-reparent-children-desync
    // -node-hidden.md §6/§8). The engine treats addComponent on an existing
    // exclusive relationship as an in-place re-target. Routes through ctx.engine
    // so the write records its leaf on the active span (AC-09).
    const r = engine.addComponent(eH, { component: ChildOf, data: { parent: parentEng } });
    if (!r.ok) return { ok: false, error: { code: 'REPARENT_FAILED', hint: String(r.error) } };
  } else if (coR.ok) {
    const r = engine.removeComponent(eH, ChildOf);
    if (!r.ok) return { ok: false, error: { code: 'REPARENT_FAILED', hint: String(r.error) } };
  }
  return { ok: true, inverse: { kind: 'reparent', entity: cmd.entity, parent: before } };
}

// ── t3.1 setComponent applier ────────────────────────────────────────────────

export function applySetComponent(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  const { engine, ids } = ctx;
  const tok = resolveToken(cmd.component);
  if (!tok) return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `unknown component ${cmd.component}` } };
  const eH = toEntity(ids, cmd.entity);
  if (!engine.get(eH, Name).ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
  const cur = engine.get(eH, tok);
  if (!cur.ok) return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `component ${cmd.component} not on entity ${cmd.entity}` } };
  const before = clone(cur.value) as Record<string, unknown>;
  const restore: Record<string, unknown> = {};
  for (const k of Object.keys(cmd.patch)) restore[k] = before[k];
  const r = engine.set(eH, tok, cmd.patch as Parameters<typeof engine.set>[2]);
  if (!r.ok) return { ok: false, error: { code: 'SET_FAILED', hint: String(r.error) } };
  return { ok: true, inverse: { kind: 'setComponent', entity: cmd.entity, component: cmd.component, patch: restore } };
}

// ── t3.2 addComponent applier ────────────────────────────────────────────────

export function applyAddComponent(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  const { engine, ids } = ctx;
  const tok = resolveToken(cmd.component);
  if (!tok) return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `unknown component ${cmd.component}` } };
  const eH = toEntity(ids, cmd.entity);
  if (!engine.get(eH, Name).ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
  if (engine.get(eH, tok).ok) return { ok: false, error: { code: 'COMPONENT_EXISTS', hint: `component ${cmd.component} already on entity ${cmd.entity}` } };
  const r = engine.addComponent(eH, { component: tok, data: (cmd.value ?? {}) as never });
  if (!r.ok) return { ok: false, error: { code: 'ADD_FAILED', hint: String(r.error) } };
  return { ok: true, inverse: { kind: 'removeComponent', entity: cmd.entity, component: cmd.component } };
}

// ── t3.3 removeComponent applier ─────────────────────────────────────────────

export function applyRemoveComponent(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  const { engine, ids } = ctx;
  // Name is intrinsic (merge origin/main: entity-existence-check test asserts
  // removeComponent Name → PROTECTED_COMPONENT). Guard before token resolution.
  if (cmd.component === 'Name') return { ok: false, error: { code: 'PROTECTED_COMPONENT', hint: 'Name is intrinsic and cannot be removed' } };
  const tok = resolveToken(cmd.component);
  if (!tok) return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `unknown component ${cmd.component}` } };
  const eH = toEntity(ids, cmd.entity);
  if (!engine.get(eH, Name).ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
  const cur = engine.get(eH, tok);
  if (!cur.ok) return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `component ${cmd.component} not on entity ${cmd.entity}` } };
  const value = clone(cur.value);
  const r = engine.removeComponent(eH, tok);
  if (!r.ok) return { ok: false, error: { code: 'REMOVE_FAILED', hint: String(r.error) } };
  return { ok: true, inverse: { kind: 'addComponent', entity: cmd.entity, component: cmd.component, value } };
}

// ── t3.4 setHidden applier ───────────────────────────────────────────────────

export function applySetHidden(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  const { engine, ids } = ctx;
  const eH = toEntity(ids, cmd.entity);
  if (!engine.get(eH, Name).ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
  const isHidden = engine.get(eH, EditorHidden).ok;
  if (cmd.hidden && !isHidden) {
    const r = engine.addComponent(eH, { component: EditorHidden, data: {} });
    if (!r.ok) return { ok: false, error: { code: 'HIDE_FAILED', hint: String(r.error) } };
  } else if (!cmd.hidden && isHidden) {
    const r = engine.removeComponent(eH, EditorHidden);
    if (!r.ok) return { ok: false, error: { code: 'UNHIDE_FAILED', hint: String(r.error) } };
  }
  return { ok: true, inverse: { kind: 'setHidden', entity: cmd.entity, hidden: isHidden } };
}

// ── t4 transaction applier ──────────────────────────────────────────────────
// M1 t4: transaction dispatches sub-ops through the module-level dispatchSub
// in appliers.ts (not through EditGateway, which may not be in scope). Keeps
// the same inverse rollback logic. M2 executor will take over this dispatch
// responsibility (RD-6 hard constraint).

export function applyTransaction(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  if (cmd.commands.length === 0) return { ok: false, error: { code: 'EMPTY_TRANSACTION', hint: 'transaction has no commands' } };
  const inverses: EditorOp[] = [];
  for (const sub of cmd.commands) {
    const r = ctx.dispatchSub(ctx, sub);
    if (!r.ok) {
      for (let i = inverses.length - 1; i >= 0; i--) ctx.dispatchSub(ctx, inverses[i]!);
      return r;
    }
    inverses.push(r.inverse);
  }
  inverses.reverse();
  return { ok: true, inverse: { kind: 'transaction', label: `undo ${cmd.label}`, commands: inverses } };
}

function entityMapped(session: EditSession, id: number): boolean {
  return entHandle(session, id) !== undefined;
}

// ── applyCommand ───────────────────────────────────────────────────────────┐

/** Dispatch a single document op through the ctx-based appliers.
 *  Shared by both the public `applyCommand` wrapper and (via ctx.dispatchSub)
 *  transaction sub-op recursion. NO span push/pop here — the caller decides span
 *  policy (the gateway executor pushes spans; the applyCommand path preserves the
 *  M1 behavior of NOT pushing per-sub-op spans, AC-25). */
function applyCommandCtx(ctx: DocApplierCtx, cmd: EditorOp): ApplyResult {
  switch (cmd.kind) {
    // ── 1. spawnEntity ──────────────────────────────────────────────────────
    case 'spawnEntity':
      return applySpawnEntity(ctx, cmd);

    // ── 2. destroyEntity ────────────────────────────────────────────────────
    // NOTE(merge origin/main): the reparent-children-desync fix from main lives
    // inside these extracted IoC appliers (applyReparent uses the exclusive-arm
    // addComponent path — see its body, anchored to
    // feedbacks/2026-07-07-hierarchy-reparent-children-desync-node-hidden.md).
    // main's inline switch bodies collapsed into this dispatch; both semantics
    // (IoC ctx.engine writes + bidirectional Children mirror upkeep) are retained.
    case 'destroyEntity':
      return applyDestroyEntity(ctx, cmd);

    // ── 3. rename ───────────────────────────────────────────────────────────
    case 'rename':
      return applyRename(ctx, cmd);

    // ── 4. reparent ─────────────────────────────────────────────────────────
    case 'reparent':
      return applyReparent(ctx, cmd);

    // ── 5. setComponent ─────────────────────────────────────────────────────
    case 'setComponent':
      return applySetComponent(ctx, cmd);

    // ── 6. addComponent ─────────────────────────────────────────────────────
    case 'addComponent':
      return applyAddComponent(ctx, cmd);

    // ── 7. removeComponent ──────────────────────────────────────────────────
    case 'removeComponent':
      return applyRemoveComponent(ctx, cmd);

    // ── 8. setHidden ────────────────────────────────────────────────────────
    case 'setHidden':
      return applySetHidden(ctx, cmd);

    // ── 9. transaction ──────────────────────────────────────────────────────
    case 'transaction':
      return applyTransaction(ctx, cmd);
    // M2: the EditorOp union now also carries session/transient op kinds whose
    // appliers live in the io/appliers session & transient tables — applyCommand
    // only handles the 9 DOCUMENT primitives. A non-document kind reaching here
    // means the gateway routed a session/transient op into the document applier,
    // which is a wiring bug; fail fast (Fail Fast) rather than silently no-op.
    default:
      return { ok: false, error: { code: 'UNKNOWN_OP', hint: `applyCommand handles document ops only; "${(cmd as { kind: string }).kind}" is a session/transient op` } };
  }
}

/** Build a DocApplierCtx from a session (engine facade over session.world + id
 *  map + non-span-pushing dispatchSub). This is the compat path used by the
 *  public `applyCommand(session, cmd)` entry (begin/update/commit/undo/redo and
 *  the index.ts export). The gateway's executor builds its OWN ctx (cached facade
 *  + span-pushing dispatchSub) — both produce the same DocApplierCtx shape. */
export function buildDocCtxForSession(session: EditSession): DocApplierCtx {
  // EngineFacade wraps the live session world. Cast to the typed write-proxy view
  // (its runtime methods forward the engine World's, so reads stay type-correct)
  // — the applier never sees the raw world, only this proxy (AC-01).
  const engine = new EngineFacade(session.world as World) as unknown as EngineWriteProxy;
  const ids = docIdMapForSession(session);
  const ctx: DocApplierCtx = {
    engine,
    ids,
    // Non-span-pushing recursion: matches M1's applyCommand transaction behavior
    // (the gateway executor supplies a span-pushing dispatchSub instead).
    dispatchSub: (c, sub) => applyCommandCtx(c, sub),
    // Read side is carried for the ctx contract; the compat applyCommand path has
    // no query-snapshot wiring of its own, so a no-op stub keeps the shape.
    query: () => ({ ok: false, error: { code: 'QUERY_UNAVAILABLE', hint: 'query snapshot is only wired on the gateway executor ctx' } }),
  };
  return ctx;
}

/**
 * Apply a document op against a session (public/compat entry, AC-25 behavior-
 * preserving). Builds a DocApplierCtx internally and dispatches through the
 * ctx-based appliers — so the 9 appliers never receive an EditSession or a raw
 * world (D-2), while every existing caller (gateway begin/undo/redo, defineOp
 * document path, index.ts export, apply-command tests) keeps its
 * `applyCommand(session, cmd)` shape.
 */
export function applyCommand(session: EditSession, cmd: EditorOp): ApplyResult {
  return applyCommandCtx(buildDocCtxForSession(session), cmd);
}

// ── Hierarchy helpers (M7 world reads, no EntityNode) ─────────────────────
// feat-20260701-editor-world-container-doc-ecs-collapse M7:
// childrenOf reads from world Children (SSOT). Root entities = all mapped
// entities that have no ChildOf component.

export function childrenOf(doc: EditSession, parent: EntityId | null): EntityId[] {
  // M3: single-realm — world is always live, dead-world branch deleted.
  if (parent !== null) {
    // childrenOf is a session-level READ helper (not an applier), so it resolves
    // the handle straight off the session id map and reads the live world — it is
    // not subject to the applier no-world constraint (AC-01 is about mutation
    // appliers). toEntity now takes a DocIdMap, so use entHandle directly here.
    const pE = (entHandle(doc, parent) ?? parent) as EntityHandle;
    const ch = doc.world.get(pE, Children);
    if (ch.ok) {
      const val = ch.value as { entities: number[] | Uint32Array };
      const raw = val.entities;
      const arr: number[] = Array.isArray(raw) ? raw : Array.from(raw as Uint32Array);
      return arr
        .map((eH: number) => entLegacyId(doc, eH as EntityHandle))
        .filter((id): id is number => id !== undefined);
    }
    return [];
  }
  // Root entities: mapped entities with no ChildOf, OR whose ChildOf.parent is
  // not an editor-tracked handle. The second clause is essential after a scene
  // load: populateSessionMapFromSceneRoot maps every authored entity but NOT the
  // synthetic SceneInstance root, so the scene's top-level entities carry a
  // ChildOf pointing at that untracked root — a bare `!co.ok` check drops them
  // all and the hierarchy renders empty. This predicate reads the live world's
  // ChildOf.parent relation (single-realm SSOT) and is kept byte-identical to
  // entRootHandles (entity-state.ts) — the two must not drift.
  const internals = getInternals(doc);
  const rootIds: EntityId[] = [];
  for (const [id, h] of internals._e2h) {
    const co = doc.world.get(h as EntityHandle, ChildOf);
    if (!co.ok || !internals._h2e.has((co.value as { parent: number }).parent as EntityHandle)) {
      rootIds.push(id);
    }
  }
  rootIds.sort((a, b) => a - b);
  return rootIds;
}

export function isSelfOrDescendant(doc: EditSession, node: EntityId, candidate: EntityId): boolean {
  if (node === candidate) return true;
  for (const c of childrenOf(doc, node)) {
    if (isSelfOrDescendant(doc, c, candidate)) return true;
  }
  return false;
}