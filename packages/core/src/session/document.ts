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
  EditorCommand,
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
import { entHandle, entLegacyId, entMap, entUnmap, entNextId, entSetNextId, entGetNextId, entIds, entParent } from '../store/entity-state';

export { createEditSession } from './edit-session';

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
  world: World,
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
// as EntityHandle so every world.get/set/addComponent/removeComponent below is
// type-correct without per-call casts (the fallback `id` is only hit for
// unmapped ids, which the immediately-following existence check rejects).
function toEntity(session: EditSession, id: number): EntityHandle {
  return (entHandle(session, id) ?? id) as EntityHandle;
}

// ── applyCommand ───────────────────────────────────────────────────────────┐

export function applyCommand(session: EditSession, cmd: EditorCommand): ApplyResult {
  const w = session.world;

  switch (cmd.kind) {
    // ── 1. spawnEntity ──────────────────────────────────────────────────────
    case 'spawnEntity': {
      const reuse = cmd._id !== undefined && !entHandle(session, cmd._id);
      const id: number = reuse ? (cmd._id as number) : entNextId(session);
      if (reuse && id >= entGetNextId(session)) entSetNextId(session, id + 1);
      const parent = cmd.parent ?? null;
      const parentEng = parent !== null ? toEntity(session, parent) : parent;
      if (parentEng !== null && !w.get(parentEng, Name).ok) {
        if (!reuse) entSetNextId(session, id);
        return { ok: false, error: { code: 'INVALID_PARENT', hint: `parent ${parent} does not exist` } };
      }
      const compData = spawnComponentData(cmd.name ?? `Entity ${id}`, parentEng, w as World, cmd.components);
      const r = w.spawn(...compData as any);
      if (!r.ok) { if (!reuse) entSetNextId(session, id); return { ok: false, error: { code: 'SPAWN_FAILED', hint: String(r.error) } }; }
      const eH = r.value as EntityHandle;
      cmd._id = id;
      entMap(session, id, eH);
      return { ok: true, inverse: { kind: 'destroyEntity', entity: id } };
    }

    // ── 2. destroyEntity ────────────────────────────────────────────────────
    case 'destroyEntity': {
      const eH = toEntity(session, cmd.entity);
      if (!w.get(eH, Name).ok) {
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
        const nr = w.get(ce, Name); const nm = nr.ok ? nr.value.value : '?';
        const comps: Record<string, unknown> = {};
        for (const [cn, ct] of [['Transform', Transform], ['ChildOf', ChildOf], ['MeshFilter', MeshFilter], ['EditorHidden', EditorHidden]] as [string, CToken][]) {
          const cr = w.get(ce, ct); if (cr.ok) comps[cn] = clone(cr.value);
        }
        const nc = w.get(ce, Name); if (nc.ok) comps['Name'] = clone(nc.value);
        entries.push({ eId: ce, legacyId: entLegacyId(session, ce), name: nm, comps });
        const chR = w.get(ce, Children);
        if (chR.ok && chR.value.entities != null) {
          const arr = chR.value.entities as { readonly length: number; [index: number]: number };
          for (let ci = 0; ci < arr.length; ci++) if (!visitedEng.has(arr[ci]! as EntityHandle)) idStack.push(arr[ci]! as EntityHandle);
        }
      }
      // Despawn bottom-up
      for (const entry of [...entries].reverse()) {
        const dr = w.despawn(entry.eId);
        if (!dr.ok) return { ok: false, error: { code: 'DESPAWN_FAILED', hint: String(dr.error) } };
        if (entry.legacyId !== undefined) entUnmap(session, entry.legacyId, entry.eId);
      }
      const spawnCmds: EditorCommand[] = entries.map((e) => ({
        kind: 'spawnEntity' as const,
        name: e.name, parent: null, components: e.comps,
        _id: e.legacyId ?? (e.eId as number),
      }));
      const rootName = entries[0]?.name ?? `Entity ${cmd.entity}`;
      return { ok: true, inverse: spawnCmds.length === 1 ? spawnCmds[0]! : { kind: 'transaction', label: `undo destroy ${rootName}`, commands: spawnCmds } };
    }

    // ── 3. rename ───────────────────────────────────────────────────────────
    case 'rename': {
      const eH = toEntity(session, cmd.entity);
      const nameR = w.get(eH, Name);
      if (!nameR.ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
      const before = nameR.value.value;
      const r = w.set(eH, Name, { value: cmd.name });
      if (!r.ok) return { ok: false, error: { code: 'RENAME_FAILED', hint: String(r.error) } };
      return { ok: true, inverse: { kind: 'rename', entity: cmd.entity, name: before } };
    }

    // ── 4. reparent ─────────────────────────────────────────────────────────
    case 'reparent': {
      const eH = toEntity(session, cmd.entity);
      if (!w.get(eH, Name).ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
      const parentEng = cmd.parent !== null ? toEntity(session, cmd.parent) : null;
      if (cmd.parent !== null && !w.get(parentEng!, Name).ok) {
        return { ok: false, error: { code: 'INVALID_PARENT', hint: `parent ${cmd.parent} not found` } };
      }
      if (cmd.parent === cmd.entity) {
        return { ok: false, error: { code: 'INVALID_PARENT', hint: 'cannot parent an entity to itself' } };
      }
      const coR = w.get(eH, ChildOf);
      const before = coR.ok ? coR.value.parent : null;
      if (parentEng !== null) {
        const r = coR.ok
          ? w.set(eH, ChildOf, { parent: parentEng })
          : w.addComponent(eH, { component: ChildOf, data: { parent: parentEng } });
        if (!r.ok) return { ok: false, error: { code: 'REPARENT_FAILED', hint: String(r.error) } };
      } else if (coR.ok) {
        const r = w.removeComponent(eH, ChildOf);
        if (!r.ok) return { ok: false, error: { code: 'REPARENT_FAILED', hint: String(r.error) } };
      }
      return { ok: true, inverse: { kind: 'reparent', entity: cmd.entity, parent: before } };
    }

    // ── 5. setComponent ─────────────────────────────────────────────────────
    case 'setComponent': {
      const tok = resolveToken(cmd.component);
      if (!tok) return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `unknown component ${cmd.component}` } };
      const eH = toEntity(session, cmd.entity);
      if (!w.get(eH, Name).ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
      const cur = w.get(eH, tok);
      if (!cur.ok) return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `component ${cmd.component} not on entity ${cmd.entity}` } };
      const before = clone(cur.value) as Record<string, unknown>;
      const restore: Record<string, unknown> = {};
      for (const k of Object.keys(cmd.patch)) restore[k] = before[k];
      // tok is a runtime-resolved component token (CToken = any); the patch is a
      // dynamic Record whose keys the engine validates against the resolved
      // schema at runtime. There is no compile-time schema to check it against
      // here, so widen to the set() param type.
      const r = w.set(eH, tok, cmd.patch as Parameters<typeof w.set>[2]);
      if (!r.ok) return { ok: false, error: { code: 'SET_FAILED', hint: String(r.error) } };
      return { ok: true, inverse: { kind: 'setComponent', entity: cmd.entity, component: cmd.component, patch: restore } };
    }

    // ── 6. addComponent ─────────────────────────────────────────────────────
    case 'addComponent': {
      const tok = resolveToken(cmd.component);
      if (!tok) return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `unknown component ${cmd.component}` } };
      const eH = toEntity(session, cmd.entity);
      if (!w.get(eH, Name).ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
      if (w.get(eH, tok).ok) return { ok: false, error: { code: 'COMPONENT_EXISTS', hint: `component ${cmd.component} already on entity ${cmd.entity}` } };
      // Dynamic component token (see the set() note above) — the data Record is
      // validated by the engine against the resolved schema at runtime.
      const r = w.addComponent(eH, { component: tok, data: (cmd.value ?? {}) as never });
      if (!r.ok) return { ok: false, error: { code: 'ADD_FAILED', hint: String(r.error) } };
      return { ok: true, inverse: { kind: 'removeComponent', entity: cmd.entity, component: cmd.component } };
    }

    // ── 7. removeComponent ──────────────────────────────────────────────────
    case 'removeComponent': {
      const tok = resolveToken(cmd.component);
      if (!tok) return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `unknown component ${cmd.component}` } };
      const eH = toEntity(session, cmd.entity);
      if (!w.get(eH, Name).ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
      const cur = w.get(eH, tok);
      if (!cur.ok) return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `component ${cmd.component} not on entity ${cmd.entity}` } };
      const value = clone(cur.value);
      const r = w.removeComponent(eH, tok);
      if (!r.ok) return { ok: false, error: { code: 'REMOVE_FAILED', hint: String(r.error) } };
      return { ok: true, inverse: { kind: 'addComponent', entity: cmd.entity, component: cmd.component, value } };
    }

    // ── 8. setHidden ────────────────────────────────────────────────────────
    case 'setHidden': {
      const eH = toEntity(session, cmd.entity);
      if (!w.get(eH, Name).ok) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
      const isHidden = w.get(eH, EditorHidden).ok;
      if (cmd.hidden && !isHidden) {
        const r = w.addComponent(eH, { component: EditorHidden, data: {} });
        if (!r.ok) return { ok: false, error: { code: 'HIDE_FAILED', hint: String(r.error) } };
      } else if (!cmd.hidden && isHidden) {
        const r = w.removeComponent(eH, EditorHidden);
        if (!r.ok) return { ok: false, error: { code: 'UNHIDE_FAILED', hint: String(r.error) } };
      }
      return { ok: true, inverse: { kind: 'setHidden', entity: cmd.entity, hidden: isHidden } };
    }

    // ── 9. transaction ──────────────────────────────────────────────────────
    case 'transaction': {
      if (cmd.commands.length === 0) return { ok: false, error: { code: 'EMPTY_TRANSACTION', hint: 'transaction has no commands' } };
      const inverses: EditorCommand[] = [];
      for (const sub of cmd.commands) {
        const r = applyCommand(session, sub);
        if (!r.ok) { for (let i = inverses.length - 1; i >= 0; i--) applyCommand(session, inverses[i]!); return r; }
        inverses.push(r.inverse);
      }
      inverses.reverse();
      return { ok: true, inverse: { kind: 'transaction', label: `undo ${cmd.label}`, commands: inverses } };
    }
  }
}

// ── Hierarchy helpers (M7 world reads, no EntityNode) ─────────────────────
// feat-20260701-editor-world-container-doc-ecs-collapse M7:
// childrenOf reads from world Children (SSOT). Root entities = all mapped
// entities that have no ChildOf component.

export function childrenOf(doc: EditSession, parent: EntityId | null): EntityId[] {
  // M3: single-realm — world is always live, dead-world branch deleted.
  if (parent !== null) {
    const pE = toEntity(doc, parent);
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