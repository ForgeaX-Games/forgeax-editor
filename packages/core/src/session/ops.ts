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
import type { SceneAsset } from '@forgeax/engine-types';
import {
  entExists,
  entParent,
  entName,
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

// ── Scene-asset collect (read side) ─────────────────────────────────────────
// Collect an entity's subtree into a self-contained SceneAsset POD via the
// engine's rootsToSceneAsset. This is a READ (registry + world), so it lives
// here — outside the gateway — while the WRITE (re-instantiate) goes through the
// instantiateSceneAsset document op / EngineFacade (invariant 7). Materials come
// back as GUID strings, so the POD is time/scene-safe: a clipboard entry copied
// now pastes correctly later (or into another scene) without dangling handles.
// This is the fidelity fix — the old entComponents→spawnComponentData path
// dropped the source MeshRenderer (invisible duplicate) and flattened the
// subtree; rootsToSceneAsset BFS-collects the whole subtree with materials.
function collectSubtree(handle: EntityHandle): SceneAsset | null {
  const collected = gateway.collectSceneAsset(handle);
  if (collected.ok) return collected.asset;
  // UI helpers remain void-returning for compatibility, but collection itself is
  // now public and structured through gateway.collectSceneAsset(). Keep the
  // warning so a human duplicate/copy gesture never becomes a mysterious no-op.
  console.warn(
    `[editor] duplicate/copy: scene-asset collect failed for entity ${handle} — ` +
    `${collected.error.code}: ${collected.error.hint}`,
  );
  return null;
}

// Pull a root entity's Transform.pos from a freshly-collected SceneAsset so paste
// offsets can preserve the clipboard's relative layout. The root is the entity
// with no ChildOf (rootsToSceneAsset strips ChildOf on roots).
function assetRootPos(asset: SceneAsset): [number, number, number] {
  for (const e of asset.entities) {
    const comps = e.components as Record<string, Record<string, unknown>> | undefined;
    if (comps && !comps.ChildOf) {
      const pos = (comps.Transform?.pos as number[] | undefined) ?? [0, 0, 0];
      return [pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? 0];
    }
  }
  return [0, 0, 0];
}

// Module-level clipboard: each entry is a self-contained SceneAsset POD (materials
// as GUID strings) + the source name. Paste re-instantiates via the scene-asset
// round-trip (preserving materials + subtree) at a small offset and selects them.
interface ClipEntry {
  name: string;
  asset: SceneAsset;
}
let clipboard: ClipEntry[] = [];

export function copySelected(handles: EntityHandle[]): number {
  clipboard = handles
    .map((handle) => {
      const world = gateway.activeWorld;
      if (!entExists(world, handle)) return null;
      const asset = collectSubtree(handle);
      if (asset === null) return null;
      return { name: entName(world, handle), asset };
    })
    .filter((c): c is ClipEntry => c !== null);
  return clipboard.length;
}

export function hasClipboard(): boolean {
  return clipboard.length > 0;
}

// shared paste helper. `translate` maps a clip entry's original root Transform
// (x,z) → the desired paste position; the delta becomes the op's posOffset so
// EVERY root in the subtree shifts together (relative layout preserved). One
// transaction → one undo; hierarchy is preserved (each entry round-trips its own
// subtree via instantiateSceneAsset).
function spawnClipboard(label: string, translate: (t: { x: number; z: number }) => { x: number; z: number }): void {
  if (clipboard.length === 0) return;
  const commands: EditorOp[] = clipboard.map((c) => {
    const [ox, , oz] = assetRootPos(c.asset);
    const moved = translate({ x: ox, z: oz });
    return {
      kind: 'instantiateSceneAsset',
      asset: c.asset,
      parent: null,
      posOffset: [moved.x - ox, 0, moved.z - oz],
      label: `paste ${c.name}`,
    } as EditorOp;
  });
  gateway.dispatch({ kind: 'transaction', label, commands });
  // Each instantiate applier rewrote _newRoots in place; collect the primary
  // root of each entry for post-paste selection.
  const handles: EntityHandle[] = [];
  for (const c of commands) {
    const roots = (c as { _newRoots?: number[] })._newRoots;
    if (roots && roots.length > 0) handles.push(roots[0] as EntityHandle);
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
  const pts = clipboard.map((c) => assetRootPos(c.asset));
  const cx = pts.reduce((s, p) => s + (p[0] ?? 0), 0) / pts.length;
  const cz = pts.reduce((s, p) => s + (p[2] ?? 0), 0) / pts.length;
  spawnClipboard(`paste@ x${clipboard.length}`, (t) => ({ x: wx + (t.x - cx), z: wz + (t.z - cz) }));
}

// Duplicate an entity (Hierarchy Duplicate / Ctrl+D): collect its subtree to a
// SceneAsset and re-instantiate it under the SAME parent as "{name} copy" (in
// place, no offset). Routing through the scene-asset round-trip preserves the
// entity's materials (the fixed bug: the old entComponents path lost MeshRenderer
// → invisible copy) AND its child subtree (the old single-entity path dropped it).
export function duplicateEntity(handle: EntityHandle): void {
  const cmd: EditorOp = { kind: 'duplicateEntity', entity: handle };
  const result = gateway.dispatch(cmd);
  if (!result.ok) {
    console.warn(`[editor] duplicate failed for entity ${handle} — ${result.error.code}: ${result.error.hint}`);
    return;
  }
  const roots = (cmd as { _newRoots?: number[] })._newRoots;
  if (roots && roots.length > 0) {
    gateway.dispatch({ kind: 'setSelection', id: roots[0] as EntityHandle });
  }
}
