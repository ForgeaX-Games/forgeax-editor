// skin-joints — the read face for enumerating a skinned character's joint names.
//
// socket-calibration M1 (doc §3.2 绑点标定): the parent-bone dropdown lists every
// joint of the character a prop attaches to. The engine stores joints as an
// `array<entity>` on the `Skin` component (Entity handles, no names), resolved at
// post-spawn time from `SkinAsset.jointPaths` by Name-component BFS. This helper
// projects that handle array to `{ name, handle }` pairs by reading each joint's
// `Name` from the world — the same read path `entName` already normalizes (a stale
// joint renders as `#<handle>` rather than `undefined`).
//
// The helper is a pure read over `gateway.activeWorld` and writes nothing: bone
// selection (reparenting the prop to the chosen joint) is a separate `reparent`
// op dispatched through the gateway (north-star §2: write = dispatch). It uses
// only the existing `entComponent` / `entParent` / `entName` read primitives, so
// it adds no new engine import to core and respects the editor DAG.
//
// Anchors:
//   socket-calibration M1 / doc §3.2 (parent-bone selection)
//   AGENTS.md anti-pattern #3 (socket = ChildOf + Transform; no Socket component)
//   AGENTS.md anti-pattern #5 (verify engine symbols — Skin is read by name via
//     the registered-component registry, not by importing a phantom token here)

import type { World } from '@forgeax/engine-ecs';
import { Children } from '@forgeax/engine-scene';
import type { EntityHandle } from './scene-types';
import { entComponent, entName, entParent } from '../store/entity-state';
import { quatToEuler } from '../util/euler-quat';

/** A joint selectable as a prop's parent bone: its Name and live Entity handle. */
export interface SkinJoint {
  readonly name: string;
  readonly handle: EntityHandle;
}

/** Walk the `ChildOf` chain from `entity` (inclusive) toward the root and return
 *  the first entity carrying a `Skin` component, or null if none is found. This is
 *  how a prop (ChildOf a bone) resolves the skinned character it belongs to: the
 *  Skin entity is the common ancestor of the joints, so the walk always reaches
 *  it before crossing the SceneInstance boundary. A depth cap guards against a
 *  malformed ChildOf loop without relying on a visited-set. */
export function findSkinEntity(world: World, entity: EntityHandle): EntityHandle | null {
  let cur: EntityHandle | null = entity;
  let depth = 0;
  while (cur !== null && depth < 1024) {
    if (entComponent(world, cur, 'Skin').ok) return cur;
    cur = entParent(world, cur);
    depth++;
  }
  return null;
}

/** Read `Skin.joints` on `skinEntity` and project each joint Entity handle to its
 *  Name. Joints without a Name (or a stale handle) resolve to `#<handle>` via
 *  `entName`'s normal fallback, so the dropdown never renders `undefined`. Returns
 *  an empty list when `skinEntity` has no Skin or its joints array is empty/absent. */
export function listSkinJoints(world: World, skinEntity: EntityHandle): SkinJoint[] {
  const skin = entComponent(world, skinEntity, 'Skin');
  if (!skin.ok) return [];
  const joints = (skin.value as { joints?: ArrayLike<number> }).joints;
  if (joints === undefined || joints.length === 0) return [];
  const out: SkinJoint[] = [];
  for (let i = 0; i < joints.length; i++) {
    const handle = joints[i];
    if (handle === undefined) continue;
    out.push({ name: entName(world, handle as EntityHandle), handle: handle as EntityHandle });
  }
  return out;
}

/** Convenience: given any entity in a character subtree, list that character's
 *  joints — resolve the Skin ancestor, then enumerate. Returns an empty list when
 *  the entity is not part of a skinned character (no Skin ancestor). */
export function listSkinJointsFor(world: World, entity: EntityHandle): SkinJoint[] {
  const skinEntity = findSkinEntity(world, entity);
  if (skinEntity === null) return [];
  return listSkinJoints(world, skinEntity);
}

// ── socket-calibration M2 (doc §3.4 朝向标定 / §3.6 数据导出) ─────────────────
//
// FacingCorrection reuses the engine's own rig-driving contract (skin.ts:45-46):
// "to move the rig, parent the joint root (or any common ancestor of the joints
// in Skin.joints[]) to your driving entity." A yaw on that driving entity
// propagates through propagateTransforms into every joint's Transform.world,
// thence into the skinning palette, yawing the whole mesh. The Skin entity's own
// Transform is ignored at render (post-bug-20260615), so the driving entity must
// sit ABOVE the joint root — the editor inserts a dedicated pivot entity named
// `FACING_PIVOT_NAME` directly above the joint root when one does not yet exist.
// No new component, no sidecar format: the pivot is just Name + Transform +
// ChildOf, the same primitives a socket (prop ChildOf a bone + Transform) uses
// (AGENTS.md anti-pattern #3 — output is a scene, not a sidecar).

/** Conventional Name of a facing-correction pivot entity. The tool identifies
 *  its own pivot by this name (the same way the engine resolves joints by Name);
 *  it is a weak scene-level convention, not a new component or file format. */
export const FACING_PIVOT_NAME = 'FacingPivot';

/** The joint root = the lowest common ancestor of all `Skin.joints[]`. This is
 *  the entity the engine contract says to parent to a driving entity for rig-
 *  level motion. Returns null when the Skin has no joints. When all joints share
 *  a single ancestor chain the LCA is the deepest entity whose parent is no
 *  longer an ancestor of every joint. A depth cap guards against malformed loops. */
export function findJointRoot(world: World, skinEntity: EntityHandle): EntityHandle | null {
  const skin = entComponent(world, skinEntity, 'Skin');
  if (!skin.ok) return null;
  const joints = (skin.value as { joints?: ArrayLike<number> }).joints;
  if (joints === undefined || joints.length === 0) return null;

  // Ancestor set of joints[0] (inclusive of itself).
  const firstChain: EntityHandle[] = [];
  let cur: EntityHandle | null = joints[0] as EntityHandle;
  let depth = 0;
  while (cur !== null && depth < 1024) {
    firstChain.push(cur);
    cur = entParent(world, cur);
    depth++;
  }
  let common = new Set(firstChain);

  // Intersect with each other joint's ancestor chain.
  for (let i = 1; i < joints.length; i++) {
    const handle = joints[i] as EntityHandle;
    const chain = new Set<EntityHandle>();
    let c: EntityHandle | null = handle;
    let d = 0;
    while (c !== null && d < 1024) {
      chain.add(c);
      c = entParent(world, c);
      d++;
    }
    common = new Set([...common].filter((e) => chain.has(e)));
    if (common.size === 0) return null;
  }

  // The LCA is the deepest common ancestor: the common entity that is NOT the
  // direct parent of any other common entity (the chain root→…→LCA is totally
  // ordered by depth, so exactly one common entity has no common child — that
  // one is the deepest). A single-element common set (only the scene root is a
  // shared ancestor) yields that element as the LCA.
  const commonArr = [...common];
  const lca = commonArr.find(
    (e) => !commonArr.some((o) => o !== e && entParent(world, o) === e),
  );
  return lca ?? null;
}

/** Find an existing facing pivot: the direct parent of `jointRoot` when that
 *  parent is named `FACING_PIVOT_NAME`. Returns null when no pivot exists above
 *  the joint root (the parent is some other entity, or the joint root is a root).
 *  Only the DIRECT parent is checked so the pivot stays scoped to the rig and
 *  does not accidentally match an unrelated ancestor further up the scene. */
export function findFacingPivot(world: World, jointRoot: EntityHandle): EntityHandle | null {
  const parent = entParent(world, jointRoot);
  if (parent === null) return null;
  return entName(world, parent) === FACING_PIVOT_NAME ? parent : null;
}

/** Read the facing yaw (degrees, XYZ euler Y component) of the pivot above
 *  `skinEntity`'s joint root. Returns null when no FacingPivot exists (no
 *  correction authored yet). Pure read — the write goes through the gateway. */
export function readFacingYaw(world: World, skinEntity: EntityHandle): number | null {
  const jointRoot = findJointRoot(world, skinEntity);
  if (jointRoot === null) return null;
  const pivot = findFacingPivot(world, jointRoot);
  if (pivot === null) return null;
  const tf = entComponent(world, pivot, 'Transform');
  if (!tf.ok) return 0;
  const quat = (tf.value as { quat?: ArrayLike<number> }).quat;
  if (quat === undefined || quat.length < 4) return 0;
  const e = quatToEuler(
    quat[0] as number,
    quat[1] as number,
    quat[2] as number,
    quat[3] as number,
  );
  return e.rotY;
}

/** A socket = a prop parented to a bone: a child of some joint that is NOT itself
 *  a joint of the same Skin. This is the authored socket TRS (the prop's local
 *  Transform relative to its parent bone) the export projection emits as pure
 *  numbers (doc §3.6 数据导出). A bone may carry both child bones (joints) and
 *  child props; only the non-joint children are sockets. */
export interface SkinSocket {
  readonly boneName: string;
  readonly boneHandle: EntityHandle;
  readonly propHandle: EntityHandle;
  readonly propName: string;
  readonly pos: readonly [number, number, number];
  readonly quat: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
}

/** Enumerate every socket (prop-on-bone) under a skinned character: for each
 *  joint in `Skin.joints[]`, its children that are not themselves joints become
 *  sockets carrying their local TRS. Returns an empty list when the Skin has no
 *  joints or no prop children. Pure read over `gateway.activeWorld`. */
export function listSkinSockets(world: World, skinEntity: EntityHandle): SkinSocket[] {
  const skin = entComponent(world, skinEntity, 'Skin');
  if (!skin.ok) return [];
  const joints = (skin.value as { joints?: ArrayLike<number> }).joints;
  if (joints === undefined || joints.length === 0) return [];
  const jointSet = new Set<EntityHandle>();
  for (let i = 0; i < joints.length; i++) {
    const h = joints[i];
    if (h !== undefined) jointSet.add(h as EntityHandle);
  }
  const out: SkinSocket[] = [];
  for (let i = 0; i < joints.length; i++) {
    const boneHandle = joints[i] as EntityHandle | undefined;
    if (boneHandle === undefined) continue;
    const ch = world.get(boneHandle, Children);
    if (!ch.ok) continue;
    const raw = (ch.value as { entities: number[] | Uint32Array }).entities;
    const kids: number[] = Array.isArray(raw) ? raw : Array.from(raw as Uint32Array);
    for (const kid of kids) {
      const propHandle = kid as EntityHandle;
      if (jointSet.has(propHandle)) continue; // a child bone, not a prop
      const tf = entComponent(world, propHandle, 'Transform');
      if (!tf.ok) continue;
      const v = tf.value as {
        pos?: ArrayLike<number>;
        quat?: ArrayLike<number>;
        scale?: ArrayLike<number>;
      };
      out.push({
        boneName: entName(world, boneHandle),
        boneHandle,
        propHandle,
        propName: entName(world, propHandle),
        pos: [
          (v.pos?.[0] as number) ?? 0,
          (v.pos?.[1] as number) ?? 0,
          (v.pos?.[2] as number) ?? 0,
        ],
        quat: [
          (v.quat?.[0] as number) ?? 0,
          (v.quat?.[1] as number) ?? 0,
          (v.quat?.[2] as number) ?? 0,
          (v.quat?.[3] as number) ?? 1,
        ],
        scale: [
          (v.scale?.[0] as number) ?? 1,
          (v.scale?.[1] as number) ?? 1,
          (v.scale?.[2] as number) ?? 1,
        ],
      });
    }
  }
  return out;
}
