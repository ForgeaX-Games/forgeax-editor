// Shared entity operations used by panels and keyboard shortcuts. They go
// through the gateway (undoable) and live above core so they may touch selection.
//
// feat-20260707-editor-world-fork M3 (I1): handle IS identity. Entity reads route
// through the activeWorld read face (entity-state helpers take (world, handle));
// entity op payloads carry EntityHandles. Within-transaction forward-references
// (group: spawn a parent, then reparent children under it) use a NEGATIVE
// placeholder handle resolved by the document applier's transaction-scoped alias
// map — there is no legacy-id namespace.
import { childrenOf, isSelfOrDescendant } from './document';
import { gateway } from '../store/store';
import type { EditorOp } from '../types';
import type { EntityHandle } from '../scene/scene-types';
import {
  entExists,
  entParent,
  entName,
  entComponents,
} from '../store/entity-state';

// ── Transaction forward-reference placeholder allocator ─────────────────────
// A negative counter mints unique placeholder handles for entities a transaction
// spawns and then references before they exist (groupSelected). The document
// applier's DocAliasMap maps each negative placeholder to the real engine handle
// once the spawn runs. Real engine handles are always non-negative, so the sign
// disambiguates. Module-level and monotonic — never collides with a live handle.
let _placeholderSeq = -1;
function nextPlaceholder(): number { return _placeholderSeq--; }

export function reparentEntity(child: EntityHandle, parent: EntityHandle | null): void {
  const world = gateway.activeWorld;
  if (parent !== null && isSelfOrDescendant(world, child, parent)) return;
  const curParent = entParent(world, child);
  if (curParent === parent) return;
  gateway.dispatch({ kind: 'reparent', entity: child, parent });
}

// post-order (children before parent) so the transaction's reversed inverse
// respawns parents before children on undo (avoids INVALID_PARENT).
function postOrder(handle: EntityHandle, out: EntityHandle[]): void {
  for (const c of childrenOf(gateway.activeWorld, handle)) postOrder(c, out);
  out.push(handle);
}

export function deleteEntityCascade(handle: EntityHandle): void {
  if (!entExists(gateway.activeWorld, handle)) return;
  const order: EntityHandle[] = [];
  postOrder(handle, order);
  const commands: EditorOp[] = order.map((e) => ({ kind: 'destroyEntity', entity: e }));
  gateway.dispatch({ kind: 'transaction', label: `delete ${handle}`, commands });
  gateway.dispatch({ kind: 'setSelection', id: null });
}

// Cascade-delete several entities (+ their subtrees) in one undo step. De-dupes
// overlapping subtrees so an entity is never destroyed twice.
export function deleteManyCascade(handles: EntityHandle[]): void {
  const seen = new Set<EntityHandle>();
  const order: EntityHandle[] = [];
  for (const handle of handles) {
    if (!entExists(gateway.activeWorld, handle)) continue;
    const sub: EntityHandle[] = [];
    postOrder(handle, sub);
    for (const e of sub) {
      if (!seen.has(e)) {
        seen.add(e);
        order.push(e);
      }
    }
  }
  if (order.length === 0) return;
  const commands: EditorOp[] = order.map((e) => ({ kind: 'destroyEntity', entity: e }));
  gateway.dispatch({ kind: 'transaction', label: `delete x${handles.length}`, commands });
  gateway.dispatch({ kind: 'setSelection', id: null });
}

// Group selected entities under a fresh empty parent (single undo step). The
// group node uses a negative placeholder handle so the reparents in the same
// transaction can target it before it is spawned (resolved by the applier's
// transaction alias map).
export function groupSelected(handles: EntityHandle[]): void {
  if (handles.length < 1) return;
  const groupRef = nextPlaceholder();
  const primary = handles[handles.length - 1]!;
  const parent = entParent(gateway.activeWorld, primary);
  const commands: EditorOp[] = [
    { kind: 'spawnEntity', name: 'Group', parent, components: { Transform: { posX: 0, posY: 0, posZ: 0, quatX: 0, quatY: 0, quatZ: 0, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 } }, _id: groupRef },
    ...handles.map((e): EditorOp => ({ kind: 'reparent', entity: e, parent: groupRef })),
  ];
  gateway.dispatch({ kind: 'transaction', label: `group x${handles.length}`, commands });
  // The spawn applier rewrote _id in place to the real handle; select it.
  const groupCmd = commands[0] as { _id?: number };
  if (typeof groupCmd._id === 'number' && groupCmd._id >= 0) {
    gateway.dispatch({ kind: 'setSelection', id: groupCmd._id as EntityHandle });
  }
}

// Inverse of group: lift a node's children up to its own parent, then remove the
// (now-empty) node — all in one transaction (single undo).
export function ungroupEntity(handle: EntityHandle): void {
  if (!entExists(gateway.activeWorld, handle)) return;
  const kids = childrenOf(gateway.activeWorld, handle);
  if (kids.length === 0) return;
  const grandParent = entParent(gateway.activeWorld, handle);
  const commands: EditorOp[] = [
    ...kids.map((c): EditorOp => ({ kind: 'reparent', entity: c, parent: grandParent })),
    { kind: 'destroyEntity', entity: handle },
  ];
  gateway.dispatch({ kind: 'transaction', label: `ungroup ${handle}`, commands });
  gateway.dispatch({ kind: 'setSelectionMany', ids: kids });
}

// Module-level clipboard (flat copy of {name, components}; hierarchy is dropped
// for now). Paste spawns clones at a small offset and selects them.
interface ClipEntry {
  name: string;
  components: Record<string, unknown>;
}
let clipboard: ClipEntry[] = [];

export function copySelected(handles: EntityHandle[]): number {
  clipboard = handles
    .map((handle) => {
      const world = gateway.activeWorld;
      if (!entExists(world, handle)) return null;
      // name + components read from the active world (SSOT) via entity-state.
      // spawnComponentData skips Name/Transform/ChildOf baseline keys, so carrying
      // them here is harmless.
      const name = entName(world, handle);
      return { name, components: structuredClone(entComponents(world, handle)) };
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
  const commands: EditorOp[] = [];
  const refs: number[] = [];
  for (const c of clipboard) {
    const comps = structuredClone(c.components);
    const t = comps.Transform as { posX?: number; posY?: number; posZ?: number } | undefined;
    if (t) {
      const moved = translate({ x: t.posX ?? 0, z: t.posZ ?? 0 });
      t.posX = moved.x;
      t.posZ = moved.z;
    }
    const ref = nextPlaceholder();
    refs.push(ref);
    commands.push({ kind: 'spawnEntity', name: c.name, parent: null, components: comps, _id: ref });
  }
  gateway.dispatch({ kind: 'transaction', label, commands });
  // Each spawn applier rewrote its _id to the real handle; collect them.
  const handles: EntityHandle[] = [];
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i] as { _id?: number };
    if (typeof c._id === 'number' && c._id >= 0) handles.push(c._id as EntityHandle);
  }
  gateway.dispatch({ kind: 'setSelectionMany', ids: handles });
}

export function pasteClipboard(): void {
  if (clipboard.length === 0) return;
  spawnClipboard(`paste x${clipboard.length}`, (t) => ({ x: t.x + 0.5, z: t.z + 0.5 }));
}

// Paste so the clipboard's centroid lands at (wx,wz), preserving relative layout.
export function pasteClipboardAt(wx: number, wz: number): void {
  if (clipboard.length === 0) return;
  const pts = clipboard.map((c) => (c.components.Transform as { posX?: number; posZ?: number } | undefined) ?? { posX: 0, posZ: 0 });
  const cx = pts.reduce((s, t) => s + (t.posX ?? 0), 0) / pts.length;
  const cz = pts.reduce((s, t) => s + (t.posZ ?? 0), 0) / pts.length;
  spawnClipboard(`paste@ x${clipboard.length}`, (t) => ({ x: wx + (t.x - cx), z: wz + (t.z - cz) }));
}

export function duplicateEntity(handle: EntityHandle): void {
  const world = gateway.activeWorld;
  if (!entExists(world, handle)) return;
  // name/parent/components read from the active world (SSOT) via entity-state.
  gateway.dispatch({
    kind: 'spawnEntity',
    name: `${entName(world, handle)} copy`,
    parent: entParent(world, handle),
    components: structuredClone(entComponents(world, handle)),
  });
}
