// Shared entity operations used by panels and keyboard shortcuts. They go
// through the bus (undoable) and live above core so they may touch selection.
//
// feat-20260701-editor-world-container-doc-ecs-collapse M3:
// Entity existence checks and parent reads switch to world.get.
// nextLocalId replaced by editor-side counter (no doc dep).
import { childrenOf, isSelfOrDescendant } from './document';
import { bus, dispatch, setSelection, setSelectionMany } from '../store/store';
import type { EditorCommand, EntityId } from '../types';
import { Name, ChildOf } from '@forgeax/engine-runtime';
import type { EntityHandle } from '../scene/scene-types';
import {
  entHandle,
  entLegacyId,
  entExists,
  entParent,
  entName,
  entComponents,
} from '../store/entity-state';

// ── Editor-side ID counter (replaces bus.doc.nextLocalId for groupSelected) ───
let _nextLocalId = 100;
function nextLocalId(): number { return _nextLocalId++; }

// feat-20260701-editor-world-container-doc-ecs-collapse M7 / AC-15:
// doc.entities dual-write mirror deleted — entity handle/existence/parent reads
// route through entity-state helpers (world SSOT on main, popout cache on
// popout windows).

/** Resolve legacy EntityId → engine handle (M7 entity-state, no doc.entities). */
function toEngine(eId: EntityId): EntityHandle | undefined {
  return entHandle(bus.doc, eId);
}

/** Check entity existence via world.get(id,Name).ok (no world.hasEntity). */
function entityExists(eId: EntityId): boolean {
  return entExists(bus.doc, eId);
}

export function reparentEntity(child: EntityId, parent: EntityId | null): void {
  if (parent !== null && isSelfOrDescendant(bus.doc, child, parent)) return;
  // Check current parent via world ChildOf
  const eH = toEngine(child);
  if (eH !== undefined) {
    const co = bus.doc.world.get(eH, ChildOf);
    if (co.ok) {
      const curParentEh = (co.value as { parent: number }).parent as EntityHandle;
      // Find legacy ID for current parent
      const curParentId = eHToLegacy(curParentEh);
      if (curParentId === parent) return;
    } else if (parent === null) return;
  }
  dispatch({ kind: 'reparent', entity: child, parent });
}

function eHToLegacy(engineHandle: EntityHandle): number | undefined {
  return entLegacyId(bus.doc, engineHandle);
}

// post-order (children before parent) so the transaction's reversed inverse
// respawns parents before children on undo (avoids INVALID_PARENT).
function postOrder(id: EntityId, out: EntityId[]): void {
  for (const c of childrenOf(bus.doc, id)) postOrder(c, out);
  out.push(id);
}

export function deleteEntityCascade(id: EntityId): void {
  if (!entityExists(id)) return;
  const order: EntityId[] = [];
  postOrder(id, order);
  const commands: EditorCommand[] = order.map((e) => ({ kind: 'destroyEntity', entity: e }));
  dispatch({ kind: 'transaction', label: `delete ${id}`, commands });
  setSelection(null);
}

// Cascade-delete several entities (+ their subtrees) in one undo step. De-dupes
// overlapping subtrees so an entity is never destroyed twice.
export function deleteManyCascade(ids: EntityId[]): void {
  const seen = new Set<EntityId>();
  const order: EntityId[] = [];
  for (const id of ids) {
    if (!entityExists(id)) continue;
    const sub: EntityId[] = [];
    postOrder(id, sub);
    for (const e of sub) {
      if (!seen.has(e)) {
        seen.add(e);
        order.push(e);
      }
    }
  }
  if (order.length === 0) return;
  const commands: EditorCommand[] = order.map((e) => ({ kind: 'destroyEntity', entity: e }));
  dispatch({ kind: 'transaction', label: `delete ×${ids.length}`, commands });
  setSelection(null);
}

// Group selected entities under a fresh empty parent (single undo step). The
// group node reuses a pre-allocated id so later reparents in the same
// transaction can target it.
export function groupSelected(ids: EntityId[]): void {
  if (ids.length < 1) return;
  const newId = nextLocalId();
  const primary = ids[ids.length - 1]!;
  const parent = entParent(bus.doc, primary);
  const commands: EditorCommand[] = [
    { kind: 'spawnEntity', name: 'Group', parent, components: { Transform: { posX: 0, posY: 0, posZ: 0, quatX: 0, quatY: 0, quatZ: 0, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 } }, _id: newId },
    ...ids.map((e): EditorCommand => ({ kind: 'reparent', entity: e, parent: newId })),
  ];
  dispatch({ kind: 'transaction', label: `group ×${ids.length}`, commands });
  setSelection(newId);
}

// Inverse of group: lift a node's children up to its own parent, then remove the
// (now-empty) node — all in one transaction (single undo).
export function ungroupEntity(id: EntityId): void {
  if (!entityExists(id)) return;
  const kids = childrenOf(bus.doc, id);
  if (kids.length === 0) return;
  const grandParent = entParent(bus.doc, id);
  const commands: EditorCommand[] = [
    ...kids.map((c): EditorCommand => ({ kind: 'reparent', entity: c, parent: grandParent })),
    { kind: 'destroyEntity', entity: id },
  ];
  dispatch({ kind: 'transaction', label: `ungroup ${id}`, commands });
  setSelectionMany(kids);
}

// Module-level clipboard (flat copy of {name, components}; hierarchy is dropped
// for now). Paste spawns clones at a small offset and selects them.
interface ClipEntry {
  name: string;
  components: Record<string, unknown>;
}
let clipboard: ClipEntry[] = [];

export function copySelected(ids: EntityId[]): number {
  clipboard = ids
    .map((id) => {
      if (!entityExists(id)) return null;
      // M7 / AC-15: name + components read from world (SSOT) via entity-state;
      // doc.entities compat layer deleted. spawnComponentData skips Name /
      // Transform / ChildOf baseline keys, so carrying them here is harmless.
      const eH = toEngine(id);
      if (eH === undefined) return null;
      const nameResult = bus.doc.world.get(eH, Name);
      if (!nameResult.ok) return null;
      const name = (nameResult.value as { value: string }).value;
      return { name, components: structuredClone(entComponents(bus.doc, id)) };
    })
    .filter((c): c is ClipEntry => c !== null);
  return clipboard.length;
}

export function hasClipboard(): boolean {
  return clipboard.length > 0;
}

// shared spawn-from-clipboard helper. `translate` maps a clip entry's original
// Transform (x,z) → the desired spawn position.
function spawnClipboard(label: string, translate: (t: { x: number; z: number }) => { x: number; z: number }): void {
  const commands: EditorCommand[] = [];
  const ids: EntityId[] = [];
  for (const c of clipboard) {
    const comps = structuredClone(c.components);
    const t = comps.Transform as { posX?: number; posY?: number; posZ?: number } | undefined;
    if (t) {
      const moved = translate({ x: t.posX ?? 0, z: t.posZ ?? 0 });
      t.posX = moved.x;
      t.posZ = moved.z;
    }
    const id = nextLocalId();
    ids.push(id);
    commands.push({ kind: 'spawnEntity', name: c.name, parent: null, components: comps, _id: id });
  }
  dispatch({ kind: 'transaction', label, commands });
  setSelectionMany(ids);
}

export function pasteClipboard(): void {
  if (clipboard.length === 0) return;
  spawnClipboard(`paste ×${clipboard.length}`, (t) => ({ x: t.x + 0.5, z: t.z + 0.5 }));
}

// Paste so the clipboard's centroid lands at (wx,wz), preserving relative layout.
export function pasteClipboardAt(wx: number, wz: number): void {
  if (clipboard.length === 0) return;
  const pts = clipboard.map((c) => (c.components.Transform as { posX?: number; posZ?: number } | undefined) ?? { posX: 0, posZ: 0 });
  const cx = pts.reduce((s, t) => s + (t.posX ?? 0), 0) / pts.length;
  const cz = pts.reduce((s, t) => s + (t.posZ ?? 0), 0) / pts.length;
  spawnClipboard(`paste@ ×${clipboard.length}`, (t) => ({ x: wx + (t.x - cx), z: wz + (t.z - cz) }));
}

export function duplicateEntity(id: EntityId): void {
  if (!entityExists(id)) return;
  // M7 / AC-15: name/parent/components read from world (SSOT) via entity-state.
  dispatch({
    kind: 'spawnEntity',
    name: `${entName(bus.doc, id)} copy`,
    parent: entParent(bus.doc, id),
    components: structuredClone(entComponents(bus.doc, id)),
  });
}
