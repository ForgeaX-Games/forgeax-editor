// Shared entity operations used by panels and keyboard shortcuts. They go
// through the bus (undoable) and live above core so they may touch selection.
import { childrenOf, isSelfOrDescendant } from './document';
import { bus, dispatch, setSelection, setSelectionMany } from './store';
import type { EditorCommand, EntityId } from './types';

export function reparentEntity(child: EntityId, parent: EntityId | null): void {
  if (parent !== null && isSelfOrDescendant(bus.doc, child, parent)) return;
  if (bus.doc.entities[child]?.parent === parent) return;
  dispatch({ kind: 'reparent', entity: child, parent });
}

// post-order (children before parent) so the transaction's reversed inverse
// respawns parents before children on undo (avoids INVALID_PARENT).
function postOrder(id: EntityId, out: EntityId[]): void {
  for (const c of childrenOf(bus.doc, id)) postOrder(c, out);
  out.push(id);
}

export function deleteEntityCascade(id: EntityId): void {
  if (!bus.doc.entities[id]) return;
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
    if (!bus.doc.entities[id]) continue;
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
  const newId = bus.doc.nextLocalId;
  const primary = ids[ids.length - 1]!;
  const parent = bus.doc.entities[primary]?.parent ?? null;
  const commands: EditorCommand[] = [
    { kind: 'spawnEntity', name: 'Group', parent, components: { Transform: { x: 0, y: 0, z: 0 } }, _id: newId },
    ...ids.map((e): EditorCommand => ({ kind: 'reparent', entity: e, parent: newId })),
  ];
  dispatch({ kind: 'transaction', label: `group ×${ids.length}`, commands });
  setSelection(newId);
}

// Inverse of group: lift a node's children up to its own parent, then remove the
// (now-empty) node — all in one transaction (single undo).
export function ungroupEntity(id: EntityId): void {
  const node = bus.doc.entities[id];
  if (!node) return;
  const kids = childrenOf(bus.doc, id);
  if (kids.length === 0) return;
  const commands: EditorCommand[] = [
    ...kids.map((c): EditorCommand => ({ kind: 'reparent', entity: c, parent: node.parent })),
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
      const n = bus.doc.entities[id];
      return n ? { name: n.name, components: structuredClone(n.components) } : null;
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
  let next = bus.doc.nextLocalId;
  for (const c of clipboard) {
    const comps = structuredClone(c.components);
    const t = comps.Transform as { x?: number; y?: number; z?: number } | undefined;
    if (t) {
      const moved = translate({ x: t.x ?? 0, z: t.z ?? 0 });
      t.x = moved.x;
      t.z = moved.z;
    }
    const id = next++;
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
  const pts = clipboard.map((c) => (c.components.Transform as { x?: number; z?: number } | undefined) ?? { x: 0, z: 0 });
  const cx = pts.reduce((s, t) => s + (t.x ?? 0), 0) / pts.length;
  const cz = pts.reduce((s, t) => s + (t.z ?? 0), 0) / pts.length;
  spawnClipboard(`paste@ ×${clipboard.length}`, (t) => ({ x: wx + (t.x - cx), z: wz + (t.z - cz) }));
}

export function duplicateEntity(id: EntityId): void {
  const node = bus.doc.entities[id];
  if (!node) return;
  dispatch({
    kind: 'spawnEntity',
    name: `${node.name} copy`,
    parent: node.parent,
    components: structuredClone(node.components),
  });
}
