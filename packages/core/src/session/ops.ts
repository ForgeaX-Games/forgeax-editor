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
import { Transform } from '@forgeax/engine-runtime';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import type { World } from '@forgeax/engine-ecs';

// ── Transaction forward-reference placeholder allocator ─────────────────────
// A negative counter mints unique placeholder handles for entities a transaction
// spawns and then references before they exist (groupSelected). The document
// applier's DocAliasMap maps each negative placeholder to the real engine handle
// once the spawn runs. Real engine handles are always non-negative, so the sign
// disambiguates. Module-level and monotonic — never collides with a live handle.
let _placeholderSeq = -1;
function nextPlaceholder(): number { return _placeholderSeq--; }

// ── World-position-preserving reparent (P0-1) ───────────────────────────────
// A reparent changes a node's PARENT but should keep its WORLD transform put
// (UE/Godot "keep world transform"): local TRS is re-expressed under the new
// parent so `parent.world × newLocal === childWorld`. Without this, dropping a
// node under a moved/rotated/scaled parent makes it jump. We read the resolved
// `Transform.world` mat4 (SSOT, written by propagate), compute
// newLocal = inverse(newParentWorld) × childWorld, decompose to TRS, and write
// it in the SAME transaction as the reparent (atomic, single undo).

interface LocalTRS {
  pos: number[];
  quat: number[];
  scale: number[];
}

/** Copy of the resolved world mat4 (column-major 16 floats), or null when the
 *  handle has no Transform. Copied out because the engine view is transient. */
function readWorldMatrix(world: World, handle: EntityHandle): Float32Array | null {
  const r = world.get(handle, Transform);
  if (!r.ok) return null;
  const w = (r.value as { world?: ArrayLike<number> }).world;
  if (!w || w.length < 16) return null;
  const out = new Float32Array(16);
  for (let i = 0; i < 16; i++) out[i] = w[i] as number;
  return out;
}

/** Local TRS for `child` so its WORLD transform is preserved once parented under
 *  `newParent` (null = root, parent world = identity). null when child has no
 *  Transform (nothing to preserve — the caller just reparents). */
function computePreservedLocal(
  world: World,
  child: EntityHandle,
  newParent: EntityHandle | null,
): LocalTRS | null {
  const childWorld = readWorldMatrix(world, child);
  if (!childWorld) return null;
  let newLocal: Float32Array = childWorld;
  if (newParent !== null) {
    const parentWorld = readWorldMatrix(world, newParent);
    if (parentWorld) {
      const inv = mat4.create();
      // invert() returns identity for a singular (zero-scale) parent — the
      // node then inherits the parent's degenerate frame, an acceptable edge.
      mat4.invert(inv, parentWorld);
      const local = mat4.create();
      mat4.multiply(local, inv, childWorld);
      newLocal = local as unknown as Float32Array;
    }
  }
  const t = vec3.create();
  const s = vec3.create();
  const r = quat.create();
  mat4.decompose(t, r, s, newLocal);
  return {
    pos: [t[0] as number, t[1] as number, t[2] as number],
    quat: [r[0] as number, r[1] as number, r[2] as number, r[3] as number],
    scale: [s[0] as number, s[1] as number, s[2] as number],
  };
}

/** The ops that reparent `child` under `parent` while preserving its world
 *  transform: setComponent(Transform local) BEFORE the reparent, then the
 *  reparent. Computed from the CURRENT world (call before the transaction runs;
 *  the new parent is not moving, so its world is stable across the transaction). */
function reparentPreserveOps(
  world: World,
  child: EntityHandle,
  parent: EntityHandle | null,
): EditorOp[] {
  const local = computePreservedLocal(world, child, parent);
  const ops: EditorOp[] = [];
  if (local) ops.push({ kind: 'setComponent', entity: child, component: 'Transform', patch: local });
  ops.push({ kind: 'reparent', entity: child, parent });
  return ops;
}

export function reparentEntity(child: EntityHandle, parent: EntityHandle | null): void {
  const world = gateway.activeWorld;
  if (parent !== null && isSelfOrDescendant(world, child, parent)) return;
  const curParent = entParent(world, child);
  if (curParent === parent) return;
  // World-preserving reparent = setComponent(local) + reparent in one undo step.
  gateway.dispatch({ kind: 'transaction', label: `reparent ${child}`, commands: reparentPreserveOps(world, child, parent) });
}

// Reparent several nodes under `parent` in ONE undo step, each preserving its
// world transform (P0-3 multi-select drag). Skips nodes that would create a
// cycle (parent is self/descendant) or are already under `parent`. Locals are
// all computed from the pre-transaction world (the target parent is stationary).
export function reparentMany(children: EntityHandle[], parent: EntityHandle | null): void {
  const world = gateway.activeWorld;
  const commands: EditorOp[] = [];
  for (const child of children) {
    if (!entExists(world, child)) continue;
    if (parent !== null && isSelfOrDescendant(world, child, parent)) continue;
    if (entParent(world, child) === parent) continue;
    commands.push(...reparentPreserveOps(world, child, parent));
  }
  if (commands.length === 0) return;
  gateway.dispatch({ kind: 'transaction', label: `reparent x${children.length}`, commands });
}

// ── Drop-position reparent (P0-5 / P0-6) ────────────────────────────────────
// `reparentAt` places `child` relative to a drop target. The Hierarchy drop
// handler resolves the TARGET PARENT from the pointer position (drop inside a
// row → that row is the parent; drop on a row's top/bottom edge → the row's
// parent, i.e. become a sibling — including the root level when the row is a
// root). This function moves `child` under `parent` (append), preserving world
// transform, in a single undo step.
//
// PRECISE SIBLING INDEX IS DEFERRED (engine limitation): the `Children` mirror
// prunes with a SWAP-REMOVE (unordered), and once the mirror empties, re-adding
// `ChildOf` does not repopulate it — so the editor cannot rebuild an exact
// sibling order. True "insert at index N" needs an engine-level ordered command
// (a stable prune or a `reorderChild`/insert-index API). `before` is accepted
// for a future engine-backed implementation but currently only distinguishes
// "same parent (append)" from a cross-parent move.
export function reparentAt(
  child: EntityHandle,
  parent: EntityHandle | null,
  _before: EntityHandle | null,
): void {
  const world = gateway.activeWorld;
  if (!entExists(world, child)) return;
  reparentEntity(child, parent);
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
    { kind: 'spawnEntity', name: 'Group', parent, components: { Transform: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } }, _id: groupRef },
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
    const t = comps.Transform as { pos?: number[] } | undefined;
    if (t) {
      const pos = t.pos ?? [0, 0, 0];
      const moved = translate({ x: pos[0] ?? 0, z: pos[2] ?? 0 });
      t.pos = [moved.x, pos[1] ?? 0, moved.z];
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
  const pts = clipboard.map((c) => (c.components.Transform as { pos?: number[] } | undefined)?.pos ?? [0, 0, 0]);
  const cx = pts.reduce((s, p) => s + (p[0] ?? 0), 0) / pts.length;
  const cz = pts.reduce((s, p) => s + (p[2] ?? 0), 0) / pts.length;
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
