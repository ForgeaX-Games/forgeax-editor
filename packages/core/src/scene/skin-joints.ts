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
import type { EntityHandle } from './scene-types';
import { entComponent, entName, entParent } from '../store/entity-state';

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
