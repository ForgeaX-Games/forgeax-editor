// applyCommand — world-based imperative mutation (M7: EntityNode deleted).
//
// feat-20260707-editor-world-fork-ssot-level-load-play M3 (I1): handle IS identity.
// The legacy id-to-handle map is deleted. Document appliers write the engine
// world directly; the runtime entity identity is the engine EntityHandle. The op
// payloads carry handles; a spawnEntity may carry a NEGATIVE placeholder _id used
// only to forward-reference the not-yet-spawned entity WITHIN a single transaction
// (e.g. groupSelected: spawn a group, then reparent children under it). That
// forward-reference is resolved by a transaction-scoped alias map (DocAliasMap) —
// an ephemeral map created per top-level dispatch and discarded after; it is NOT a
// persistent second identity namespace (AC-01: legacy-map symbol grep zero hits).
// After a spawn applier runs it rewrites cmd._id in place to the real engine
// handle so the committed ledger op and any post-dispatch reader (spawnClipboard
// selection) see the concrete handle.
//
// childrenOf walks a World via the engine Children component (activeWorld read
// face) — no legacy-map iteration. Root entities are derived from the world walk
// (worldRootHandles) — entities with no live ChildOf parent.
//
// Anchors:
//   requirements AC-01: applyCommand off the double-identity map
//   requirements AC-09: childrenOf walks activeWorld (play->playWorld/edit->editWorld)
//   requirements AC-11: childrenOf dedup guard removed (Half A gone; Half B kept)
//   requirements AC-17: three independent lights (scheme A)
//   plan-strategy §3.1: document.childrenOf is the single tree-walk primitive
//   plan-strategy R-N3: M3 atomic migration — core signatures first
//   research Finding 9: Half A dedup naturally gone after engine transient fix

import type {
  ApplyResult,
  CommandError,
  EditorOp,
  EditSession,
} from '../types';
import type { SceneAsset } from '@forgeax/engine-types';

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
import { EngineFacade } from '../io/engine-facade';
import { assetIO } from '../io/asset-io-facade';
import { worldRootHandles } from '../store/entity-state';

export { createEditSession } from './edit-session';

// ── IoC context for document appliers (plan-strategy §2 D-2, AC-01) ─────────
// The 9 document appliers receive a `DocApplierCtx` whose ONLY world access is
// the controlled `engine` proxy (routes through EngineFacade._recordLeaf → span
// attributes). `ctx.world` does not exist — writing it is a tsc error (the
// ctx-world-negative guard test proves this).

/** Typed engine-write proxy handed to document appliers via `ctx.engine`.
 *  Structurally it IS the EngineFacade instance, and is now typed as a `Pick<>`
 *  of the facade's own method surface (not the raw `World`) so appliers keep full
 *  type safety on reads WITHOUT ever holding a raw `world` handle (AC-01) — the
 *  proxy is exactly the facade-method subset appliers may call, and facade-only
 *  methods (e.g. `instantiateSceneAssetFlat`, which needs the registry) are
 *  reachable while a raw `world` remains inaccessible. Every write routes through
 *  EngineFacade and records its engine interface leaf onto the active span
 *  (AC-09). Reads (`get`) record nothing. */
export type EngineWriteProxy = Pick<
  EngineFacade,
  'get' | 'set' | 'spawn' | 'despawn' | 'addComponent' | 'removeComponent' | 'instantiateSceneAssetFlat'
>;

/** Transaction-scoped spawn-placeholder alias (replaces the deleted legacy
 *  id-to-handle map). A spawnEntity op may carry a NEGATIVE placeholder `_id` so a
 *  later sub-op in the SAME transaction can reference the not-yet-spawned entity
 *  (groupSelected forward-reference). The spawn applier records
 *  placeholder -> real handle here; toEntity resolves a negative reference
 *  through it. Positive references ARE handles and pass through unchanged. The
 *  map is created per top-level dispatch (gateway) or per applyCommand call and
 *  discarded after — no session-lifetime identity state (AC-01). */
export type DocAliasMap = Map<number, EntityHandle>;

/** Read-side query snapshot function shape (mirrors io/query-snapshot's
 *  QuerySnapshotFn). Kept structural here to avoid a session→io type import;
 *  document appliers don't consume it, but it is part of the established M2 ctx
 *  contract (t12a) so it stays on the ctx. */
export type DocQueryFn = (descriptor: unknown) => unknown;

/** The IoC context every DOCUMENT applier receives (plan-strategy §2 D-2).
 *  engine (controlled write proxy) + alias (transaction placeholder resolution)
 *  + dispatchSub (recursive transaction dispatch) + query (read side, carried for
 *  the M2 ctx contract). Deliberately NO `world` field — `ctx.world` in an
 *  applier body is a tsc error (AC-01 negative; ctx-world-negative guard). */
export interface DocApplierCtx {
  engine: EngineWriteProxy;
  /** Asset/pack write gate (north-star §2 axis symmetry with engine). Document
   *  appliers such as destroyAsset reach pack IO through this. */
  assetIO: import('../io/asset-io-facade').AssetIOFacade;
  alias: DocAliasMap;
  dispatchSub(ctx: DocApplierCtx, sub: EditorOp): ApplyResult;
  query: DocQueryFn;
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
    pos: [0, 0, 0],
    quat: [0, 0, 0, 1],
    scale: [1, 1, 1],
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
  // Half B (AC-11 / Finding 9): 'Children' stays OUT of the editor's spawn-time
  // vocabulary. The engine's ChildOf mirror hook is the SOLE writer of Children,
  // so a rebuilt node (duplicateEntity: entComponents -> spawnComponentData)
  // must NOT re-author Children or it would double-write. On the dedup-absent
  // baseline (main HEAD) BASELINE_NAMES already omits 'Children'; keeping it out
  // of this skip-set-plus-author path is the verify-absence guarantee.
  const BASELINE_NAMES = new Set(['Name', 'Transform', 'ChildOf', 'MeshRenderer']);
  // verify F-1 (round 1): `Editor*`-prefixed keys are intentional transient
  // editor-side markers (e.g. `EditorPendingMeshAsset`, carrying a real GUID for
  // the edit-runtime drag-spawn resolver to consume via `lastCommand.components`
  // BEFORE this drop happens). They are DESIGNED never to reach the world — so
  // dropping them here is expected, not the data-loss case below.
  const isIntentionalEditorMarker = (n: string): boolean => n.startsWith('Editor');
  if (extraComponents) {
    let hasMeshFilter = false;
    for (const [compName, value] of Object.entries(extraComponents)) {
      if (BASELINE_NAMES.has(compName)) continue;
      if (compName === 'Children') continue; // Half B: engine owns Children mirror
      if (isIntentionalEditorMarker(compName)) continue;
      const tok = resolveToken(compName);
      if (tok) {
        out.push({ component: tok, data: (value ?? {}) as Record<string, unknown> });
        if (compName === 'MeshFilter') hasMeshFilter = true;
      } else {
        // charter P3 — fail loud, never silently drop: an unregistered component
        // name means an UPSTREAM producer still emits a vocabulary this collapse
        // deleted. Warn so the divergence surfaces at author time instead of as a
        // mysteriously empty entity on reopen (AGENTS.md #2 data-loss).
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
      // presence, so a MeshFilter-only entity is archetype-absent and never drawn.
      // An empty `materials: []` routes through the engine's OWN default-material
      // fallback (identical in Edit and Play) and serializes with zero material
      // handles to resolve, so save never sees an unresolved handle.
      out.push({
        component: MeshRenderer as unknown as CToken,
        data: { materials: [] },
      });
    }
  }
  return out;
}

// ── Handle resolution (transaction placeholder alias) ───────────────────────

// A reference in an op payload is either a real engine handle (>= 0) or a
// negative transaction placeholder that resolves through the alias map. Real
// engine handles are always non-negative (packed slot+generation), so the sign
// unambiguously discriminates the two.
function toEntity(alias: DocAliasMap, ref: number): EntityHandle {
  if (ref < 0) {
    const h = alias.get(ref);
    return (h ?? ref) as EntityHandle;
  }
  return ref as EntityHandle;
}

// ── Per-op document appliers (plan-strategy §2 D-1) ─────────────────────────

// ── spawnEntity applier ─────────────────────────────────────────────────────

export function applySpawnEntity(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  const { engine, alias } = ctx;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  // A negative _id is a transaction placeholder (forward-reference); a
  // non-negative _id is a concrete handle from a prior apply (redo / inverse).
  const placeholder: number | undefined =
    typeof cmd._id === 'number' && cmd._id < 0 ? (cmd._id as number) : undefined;
  const parent = cmd.parent ?? null;
  const parentEng = parent !== null ? toEntity(alias, parent) : null;
  if (parentEng !== null && !engine.get(parentEng, Name).ok) {
    return { ok: false, error: { code: 'INVALID_PARENT', hint: `parent ${parent} does not exist` } };
  }
  const compData = spawnComponentData(cmd.name ?? 'Entity', parentEng, cmd.components);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = engine.spawn(...(compData as any));
  if (!r.ok) return { ok: false, error: { code: 'SPAWN_FAILED', hint: String(r.error) } };
  const eH = r.value as EntityHandle;
  // Rewrite _id in place to the real handle: the committed ledger op keeps the
  // concrete handle, and a NEGATIVE placeholder must resolve for later sub-ops in
  // the same transaction (alias forward-reference). Post-dispatch readers use the
  // returned `created` channel instead of reading this back.
  cmd._id = eH;
  if (placeholder !== undefined) alias.set(placeholder, eH);
  return { ok: true, inverse: { kind: 'destroyEntity', entity: eH }, created: [eH] };
}

// ── destroyEntity applier ────────────────────────────────────────────────────

export function applyDestroyEntity(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  const { engine, alias } = ctx;
  const eH = toEntity(alias, cmd.entity);
  if (!engine.get(eH, Name).ok) {
    return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
  }
  // Collect subtree via engine handles (eH + Children members).
  const idStack: EntityHandle[] = [eH];
  const visitedEng = new Set<EntityHandle>();
  const entries: Array<{ eId: EntityHandle; name: string; comps: Record<string, unknown> }> = [];
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
    entries.push({ eId: ce, name: nm, comps });
    const chR = engine.get(ce, Children);
    if (chR.ok && chR.value.entities != null) {
      const arr = chR.value.entities as { readonly length: number; [index: number]: number };
      for (let ci = 0; ci < arr.length; ci++) if (!visitedEng.has(arr[ci]! as EntityHandle)) idStack.push(arr[ci]! as EntityHandle);
    }
  }
  // Despawn bottom-up.
  for (const entry of [...entries].reverse()) {
    const dr = engine.despawn(entry.eId);
    if (!dr.ok) return { ok: false, error: { code: 'DESPAWN_FAILED', hint: String(dr.error) } };
  }
  // Inverse respawns the collected entities (names + components survive undo).
  // parent:null + comps carrying ChildOf preserves the prior mount shape as far
  // as the collected component data allows (I1: cross-respawn handle identity is
  // not reconstructed — the respawned entities carry fresh handles).
  const spawnCmds: EditorOp[] = entries.map((e) => ({
    kind: 'spawnEntity' as const,
    name: e.name, parent: null, components: e.comps,
  }));
  const rootName = entries[0]?.name ?? `Entity ${cmd.entity}`;
  return { ok: true, inverse: spawnCmds.length === 1 ? spawnCmds[0]! : { kind: 'transaction', label: `undo destroy ${rootName}`, commands: spawnCmds }, created: [] };
}

// ── rename applier ────────────────────────────────────────────────────────────

export function applyRename(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  const { engine, alias } = ctx;
  const eH = toEntity(alias, cmd.entity);
  const nameR = engine.get(eH, Name);
  if (!nameR.ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
  const before = nameR.value.value;
  const r = engine.set(eH, Name, { value: cmd.name });
  if (!r.ok) return { ok: false, error: { code: 'RENAME_FAILED', hint: String(r.error) } };
  return { ok: true, inverse: { kind: 'rename', entity: cmd.entity, name: before }, created: [] };
}

// ── reparent applier ──────────────────────────────────────────────────────────

export function applyReparent(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  const { engine, alias } = ctx;
  const eH = toEntity(alias, cmd.entity);
  if (!engine.get(eH, Name).ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
  const parentEng = cmd.parent !== null ? toEntity(alias, cmd.parent) : null;
  if (cmd.parent !== null && !engine.get(parentEng!, Name).ok) {
    return { ok: false, error: { code: 'INVALID_PARENT', hint: `parent ${cmd.parent} not found` } };
  }
  if (parentEng !== null && parentEng === eH) {
    return { ok: false, error: { code: 'INVALID_PARENT', hint: 'cannot parent an entity to itself' } };
  }
  const coR = engine.get(eH, ChildOf);
  // Inverse carries the prior parent HANDLE (handle IS identity now — no legacy
  // id translation). null when the entity was previously a root.
  const before: EntityHandle | null = coR.ok ? (coR.value.parent as EntityHandle) : null;
  if (parentEng !== null) {
    // ChildOf is a relationship (exclusive arm): reparent MUST go through
    // addComponent so the engine's relationship hook fires and keeps the
    // bidirectional Children mirror in sync (remove-from-old + add-to-new). A
    // bare engine.set skips the exclusive-arm handling and desyncs Children (the
    // node-hidden bug: feedbacks/2026-07-07-hierarchy-reparent-children-desync-
    // node-hidden.md §6/§8). Routes through ctx.engine so the write records its
    // leaf on the active span (AC-09).
    const r = engine.addComponent(eH, { component: ChildOf, data: { parent: parentEng } });
    if (!r.ok) return { ok: false, error: { code: 'REPARENT_FAILED', hint: String(r.error) } };
  } else if (coR.ok) {
    const r = engine.removeComponent(eH, ChildOf);
    if (!r.ok) return { ok: false, error: { code: 'REPARENT_FAILED', hint: String(r.error) } };
  }
  return { ok: true, inverse: { kind: 'reparent', entity: cmd.entity, parent: before }, created: [] };
}

// ── setComponent applier ──────────────────────────────────────────────────────

export function applySetComponent(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  const { engine, alias } = ctx;
  const tok = resolveToken(cmd.component);
  if (!tok) return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `unknown component ${cmd.component}` } };
  const eH = toEntity(alias, cmd.entity);
  if (!engine.get(eH, Name).ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
  const cur = engine.get(eH, tok);
  if (!cur.ok) return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `component ${cmd.component} not on entity ${cmd.entity}` } };
  const before = clone(cur.value) as Record<string, unknown>;
  const restore: Record<string, unknown> = {};
  for (const k of Object.keys(cmd.patch)) restore[k] = before[k];
  const r = engine.set(eH, tok, cmd.patch as Parameters<typeof engine.set>[2]);
  if (!r.ok) return { ok: false, error: { code: 'SET_FAILED', hint: String(r.error) } };
  return { ok: true, inverse: { kind: 'setComponent', entity: cmd.entity, component: cmd.component, patch: restore }, created: [] };
}

// ── addComponent applier ──────────────────────────────────────────────────────

export function applyAddComponent(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  const { engine, alias } = ctx;
  const tok = resolveToken(cmd.component);
  if (!tok) return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `unknown component ${cmd.component}` } };
  const eH = toEntity(alias, cmd.entity);
  if (!engine.get(eH, Name).ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
  if (engine.get(eH, tok).ok) return { ok: false, error: { code: 'COMPONENT_EXISTS', hint: `component ${cmd.component} already on entity ${cmd.entity}` } };
  const r = engine.addComponent(eH, { component: tok, data: (cmd.value ?? {}) as never });
  if (!r.ok) return { ok: false, error: { code: 'ADD_FAILED', hint: String(r.error) } };
  return { ok: true, inverse: { kind: 'removeComponent', entity: cmd.entity, component: cmd.component }, created: [] };
}

// ── removeComponent applier ───────────────────────────────────────────────────

export function applyRemoveComponent(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  const { engine, alias } = ctx;
  // Name is intrinsic: removeComponent Name → PROTECTED_COMPONENT. Guard before
  // token resolution.
  if (cmd.component === 'Name') return { ok: false, error: { code: 'PROTECTED_COMPONENT', hint: 'Name is intrinsic and cannot be removed' } };
  const tok = resolveToken(cmd.component);
  if (!tok) return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `unknown component ${cmd.component}` } };
  const eH = toEntity(alias, cmd.entity);
  if (!engine.get(eH, Name).ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
  const cur = engine.get(eH, tok);
  if (!cur.ok) return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `component ${cmd.component} not on entity ${cmd.entity}` } };
  const value = clone(cur.value);
  const r = engine.removeComponent(eH, tok);
  if (!r.ok) return { ok: false, error: { code: 'REMOVE_FAILED', hint: String(r.error) } };
  return { ok: true, inverse: { kind: 'addComponent', entity: cmd.entity, component: cmd.component, value }, created: [] };
}

// ── setHidden applier ─────────────────────────────────────────────────────────

export function applySetHidden(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  const { engine, alias } = ctx;
  const eH = toEntity(alias, cmd.entity);
  if (!engine.get(eH, Name).ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
  const isHidden = engine.get(eH, EditorHidden).ok;
  if (cmd.hidden && !isHidden) {
    const r = engine.addComponent(eH, { component: EditorHidden, data: {} });
    if (!r.ok) return { ok: false, error: { code: 'HIDE_FAILED', hint: String(r.error) } };
  } else if (!cmd.hidden && isHidden) {
    const r = engine.removeComponent(eH, EditorHidden);
    if (!r.ok) return { ok: false, error: { code: 'UNHIDE_FAILED', hint: String(r.error) } };
  }
  return { ok: true, inverse: { kind: 'setHidden', entity: cmd.entity, hidden: isHidden }, created: [] };
}

// ── transaction applier ───────────────────────────────────────────────────────

export function applyTransaction(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  if (cmd.commands.length === 0) return { ok: false, error: { code: 'EMPTY_TRANSACTION', hint: 'transaction has no commands' } };
  const inverses: EditorOp[] = [];
  // Flatten every sub-op's created roots into one array (D-2: top-level created =
  // all sub-ops' roots). A caller needing per-sub-op roots (e.g. spawnClipboard's
  // "primary root of each paste") reads each sub-op's own dispatch result instead.
  const created: EntityHandle[] = [];
  for (const sub of cmd.commands) {
    const r = ctx.dispatchSub(ctx, sub);
    if (!r.ok) {
      for (let i = inverses.length - 1; i >= 0; i--) ctx.dispatchSub(ctx, inverses[i]!);
      return r;
    }
    inverses.push(r.inverse);
    created.push(...r.created);
  }
  inverses.reverse();
  return { ok: true, inverse: { kind: 'transaction', label: `undo ${cmd.label}`, commands: inverses }, created };
}

// ── instantiateSceneAsset applier ─────────────────────────────────────────────
// Re-instantiate a collected SceneAsset POD (produced OUT of this applier by
// EditGateway.collectSceneAsset, the one read-side collection seam) as live world
// entities. This is the ONE document op both "copy an existing entity" paths
// project onto — duplicateEntity (Ctrl+D) and clipboard
// paste — so material fidelity (materials round-trip by GUID) and subtree survival
// come from the engine's own round-trip, not a hand-rolled component copy that
// dropped the source MeshRenderer (the fixed bug).
//
// invariant 7: the raw allocSharedRef + registry.instantiateFlat live inside
// EngineFacade.instantiateSceneAssetFlat (the sole raw-world file); this applier
// only calls that facade method + facade set/addComponent — never a raw world.

/**
 * Apply a prepared public duplicate. Gateway owns the source read and freezes the
 * collected POD on the command before this document applier runs; this body only
 * projects that POD onto the established instantiateSceneAsset write path.
 */
export function applyDuplicateEntity(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  const cmd = _cmd as Extract<EditorOp, { kind: 'duplicateEntity' }>;
  if (cmd._asset === undefined) {
    return {
      ok: false,
      error: {
        code: 'SCENE_COLLECT_FAILED',
        hint: 'duplicateEntity requires a Gateway-collected SceneAsset; dispatch through EditGateway',
      },
    };
  }
  const instantiate: EditorOp = {
    kind: 'instantiateSceneAsset',
    asset: cmd._asset,
    parent: cmd.parent,
    name: cmd.name,
    posOffset: cmd.posOffset,
    label: cmd.label,
  };
  // Delegate to the instantiate applier; its result already carries `created`
  // (the new roots), so duplicate forwards it verbatim.
  return applyInstantiateSceneAsset(ctx, instantiate);
}

export function applyInstantiateSceneAsset(ctx: DocApplierCtx, _cmd: EditorOp): ApplyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = _cmd as any;
  const { engine, alias } = ctx;
  const asset = cmd.asset as SceneAsset | undefined;
  if (!asset) return { ok: false, error: { code: 'INVALID_ARGS', hint: 'instantiateSceneAsset requires a collected `asset` (SceneAsset POD)' } };

  const r = engine.instantiateSceneAssetFlat(asset);
  if (!r.ok) {
    // instantiateSceneAssetFlat returns AssetError | PackError | EcsError |
    // {NO_REGISTRY} — all opaque here; surface as a single structured code so the
    // failure never flows downstream silently (Fail Fast / charter P3).
    return { ok: false, error: { code: 'INSTANTIATE_FAILED', hint: `scene-asset instantiate failed: ${JSON.stringify(r.error)}` } };
  }
  const newRoots = r.value as EntityHandle[];
  if (newRoots.length === 0) {
    return { ok: false, error: { code: 'INSTANTIATE_FAILED', hint: 'scene-asset instantiate produced no roots' } };
  }

  // Retarget the PRIMARY root: parent + name. rootsToSceneAsset strips ChildOf on
  // roots (they collect parentless), so a parent must be re-attached via ChildOf
  // addComponent — the same relationship-hook path applyReparent uses so the
  // Children mirror stays in sync.
  const primary = newRoots[0]!;
  if (cmd.parent !== undefined && cmd.parent !== null) {
    const parentEng = toEntity(alias, cmd.parent);
    if (engine.get(parentEng, Name).ok) {
      const pr = engine.addComponent(primary, { component: ChildOf, data: { parent: parentEng } });
      if (!pr.ok) return cascadeInstantiateFailure(engine, newRoots, 'REPARENT_FAILED', String(pr.error));
    }
  }
  if (typeof cmd.name === 'string') {
    const nr = engine.set(primary, Name, { value: cmd.name });
    if (!nr.ok) return cascadeInstantiateFailure(engine, newRoots, 'RENAME_FAILED', String(nr.error));
  }

  // Positional offset (paste): shift every new root's Transform.pos so a paste
  // lands beside the source rather than exactly on top of it.
  if (Array.isArray(cmd.posOffset)) {
    const [dx, dy, dz] = cmd.posOffset as [number, number, number];
    for (const root of newRoots) {
      const tr = engine.get(root, Transform);
      if (!tr.ok) continue;
      const cur = ((tr.value as unknown as { pos?: ArrayLike<number> }).pos) ?? [0, 0, 0];
      engine.set(root, Transform, { pos: [(cur[0] ?? 0) + (dx ?? 0), (cur[1] ?? 0) + (dy ?? 0), (cur[2] ?? 0) + (dz ?? 0)] } as Parameters<typeof engine.set>[2]);
    }
  }

  // Inverse: destroy every new root. destroyEntity cascades the subtree
  // (applyDestroyEntity), so one op per root restores the pre-instantiate state.
  const destroys: EditorOp[] = newRoots.map((e) => ({ kind: 'destroyEntity' as const, entity: e }));
  const label = typeof cmd.label === 'string' ? cmd.label : 'instantiate';
  return {
    ok: true,
    inverse: destroys.length === 1 ? destroys[0]! : { kind: 'transaction', label: `undo ${label}`, commands: destroys },
    // The new roots are the created channel (replaces the old cmd._newRoots
    // in-place rewrite, which JSON couldn't carry back over the eval bridge).
    created: newRoots,
  };
}

/** Best-effort rollback when a post-instantiate retarget step fails: despawn the
 *  already-spawned roots so a half-built duplicate never survives (Fail Fast). */
function cascadeInstantiateFailure(
  engine: EngineWriteProxy,
  roots: EntityHandle[],
  code: CommandError['code'],
  hint: string,
): ApplyResult {
  for (const root of roots) engine.despawn(root);
  return { ok: false, error: { code, hint } };
}

// ── applyCommand dispatch ───────────────────────────────────────────────────

/** Dispatch a single document op through the ctx-based appliers. Shared by both
 *  the public `applyCommand` wrapper and (via ctx.dispatchSub) transaction sub-op
 *  recursion. NO span push/pop here — the caller decides span policy. */
function applyCommandCtx(ctx: DocApplierCtx, cmd: EditorOp): ApplyResult {
  switch (cmd.kind) {
    case 'spawnEntity':
      return applySpawnEntity(ctx, cmd);
    case 'destroyEntity':
      return applyDestroyEntity(ctx, cmd);
    case 'rename':
      return applyRename(ctx, cmd);
    case 'reparent':
      return applyReparent(ctx, cmd);
    case 'setComponent':
      return applySetComponent(ctx, cmd);
    case 'addComponent':
      return applyAddComponent(ctx, cmd);
    case 'removeComponent':
      return applyRemoveComponent(ctx, cmd);
    case 'setHidden':
      return applySetHidden(ctx, cmd);
    case 'instantiateSceneAsset':
      return applyInstantiateSceneAsset(ctx, cmd);
    case 'duplicateEntity':
      return applyDuplicateEntity(ctx, cmd);
    case 'transaction':
      return applyTransaction(ctx, cmd);
    // A non-document kind reaching here means the gateway routed a session/
    // transient op into the document applier — a wiring bug; fail fast.
    default:
      return { ok: false, error: { code: 'UNKNOWN_OP', hint: `applyCommand handles document ops only; "${(cmd as { kind: string }).kind}" is a session/transient op` } };
  }
}

/** Build a DocApplierCtx from a session (engine facade over session.world +
 *  fresh transaction alias + non-span-pushing dispatchSub). Compat path used by
 *  the public `applyCommand(session, cmd)` entry (begin/update/commit/undo/redo
 *  and the index.ts export). The gateway's executor builds its OWN ctx (cached
 *  facade + span-pushing dispatchSub) — both produce the same DocApplierCtx shape.
 *  The alias map is created fresh here so a transaction's forward-references
 *  resolve; it is discarded when this ctx goes out of scope. */
export function buildDocCtxForSession(session: EditSession): DocApplierCtx {
  // Pass session.registry so this compat-path facade can also run the scene-asset
  // round-trip (instantiateSceneAssetFlat needs the registry for GUID→handle
  // resolution). This path drives undo/redo (gateway.undo/redo → applyCommand),
  // so an instantiateSceneAsset REDO would fail here without the registry — same
  // wiring the gateway executor's _getEngineFacade does with doc.registry.
  const engine = new EngineFacade(session.world as World, session.registry) as unknown as EngineWriteProxy;
  const alias: DocAliasMap = new Map();
  const ctx: DocApplierCtx = {
    engine,
    // Asset write gate (north-star §2 axis symmetry): begin/undo of destroyAsset
    // reach pack IO through this, consistent with the gateway executor ctx. The
    // shared `assetIO` singleton has no per-instance state (AC-D2).
    assetIO,
    alias,
    // Non-span-pushing recursion reusing the SAME ctx (so the transaction alias
    // threads through every sub-op — forward-references resolve).
    dispatchSub: (c, sub) => applyCommandCtx(c, sub),
    query: () => ({ ok: false, error: { code: 'QUERY_UNAVAILABLE', hint: 'query snapshot is only wired on the gateway executor ctx' } }),
  };
  return ctx;
}

/**
 * Apply a document op against a session (public/compat entry). Builds a
 * DocApplierCtx internally (with a fresh transaction alias) and dispatches
 * through the ctx-based appliers — so the 9 appliers never receive an EditSession
 * or a raw world (D-2).
 */
export function applyCommand(session: EditSession, cmd: EditorOp): ApplyResult {
  return applyCommandCtx(buildDocCtxForSession(session), cmd);
}

// ── Hierarchy helpers (activeWorld walk, handle identity) ───────────────────
// childrenOf reads a World's Children (SSOT). Root entities = live entities with
// no live ChildOf parent (worldRootHandles). No legacy-map iteration, no dedup guard —
// the engine Children mirror after the transient fix writes each entry once
// (AC-11 Half A gone; Half B 'Children' kept out of spawnComponentData).

export function childrenOf(world: World, parent: EntityHandle | null): EntityHandle[] {
  if (parent !== null) {
    const ch = world.get(parent, Children);
    if (ch.ok) {
      const val = ch.value as { entities: number[] | Uint32Array };
      const raw = val.entities;
      const arr: number[] = Array.isArray(raw) ? raw : Array.from(raw as Uint32Array);
      return arr.map((eH: number) => eH as EntityHandle);
    }
    return [];
  }
  // Root entities: live entities with no live ChildOf parent.
  return worldRootHandles(world);
}

export function isSelfOrDescendant(world: World, node: EntityHandle, candidate: EntityHandle): boolean {
  if (node === candidate) return true;
  for (const c of childrenOf(world, node)) {
    if (isSelfOrDescendant(world, c, candidate)) return true;
  }
  return false;
}
