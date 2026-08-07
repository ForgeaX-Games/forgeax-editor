// socket-calibration M1 — skin-joints read face (doc §3.2 绑点标定).
//
// Pins the three read helpers against a hand-built skinned character subtree:
//   root(Skin) ─ boneA ─ boneB
//                 └─ prop            (ChildOf boneA)
// `findSkinEntity` walks prop → boneA → root and returns root; `listSkinJoints`
// projects Skin.joints to {name,handle}; `listSkinJointsFor` chains both. A prop
// with no Skin ancestor yields an empty list (non-skinned scene branch).
//
// Anchors:
//   socket-calibration M1 / doc §3.2 (parent-bone selection)

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { Name, Transform, ChildOf } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { EntityHandle } from '../scene/scene-types';
import {
  findSkinEntity,
  listSkinJoints,
  listSkinJointsFor,
} from '../scene/skin-joints';

function spawn(
  world: World,
  name: string,
  parent?: EntityHandle,
  extra?: { component: unknown; data: Record<string, unknown> },
): EntityHandle {
  const comps: Array<{ component: unknown; data: Record<string, unknown> }> = [
    { component: Name, data: { value: name } },
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  ];
  if (parent !== undefined) comps.push({ component: ChildOf, data: { parent } });
  if (extra !== undefined) comps.push(extra);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = world.spawn(...(comps as any));
  if (!r.ok) throw new Error(`spawn failed: ${String(r.error)}`);
  return r.value as EntityHandle;
}

describe('socket-calibration M1 — skin-joints read face', () => {
  it('findSkinEntity walks the ChildOf chain to the Skin ancestor (inclusive of self)', () => {
    const world = new World();
    const root = spawn(world, 'Character', undefined, {
      component: Skin,
      data: { skeleton: 0, joints: [] },
    });
    const boneA = spawn(world, 'spine', root);
    const prop = spawn(world, 'sword', boneA);
    expect(findSkinEntity(world, prop)).toBe(root);
    expect(findSkinEntity(world, boneA)).toBe(root);
    expect(findSkinEntity(world, root)).toBe(root);
  });

  it('findSkinEntity returns null when no Skin ancestor exists', () => {
    const world = new World();
    const orphan = spawn(world, 'Prop');
    expect(findSkinEntity(world, orphan)).toBeNull();
  });

  it('listSkinJoints projects Skin.joints handles to {name,handle} pairs', () => {
    const world = new World();
    const boneA = spawn(world, 'spine');
    const boneB = spawn(world, 'arm');
    const root = spawn(world, 'Character', undefined, {
      component: Skin,
      data: { skeleton: 0, joints: [boneA, boneB] },
    });
    const joints = listSkinJoints(world, root);
    expect(joints).toHaveLength(2);
    expect(joints[0]!.name).toBe('spine');
    expect(joints[0]!.handle).toBe(boneA);
    expect(joints[1]!.name).toBe('arm');
    expect(joints[1]!.handle).toBe(boneB);
  });

  it('listSkinJoints returns [] for an entity without Skin or empty joints', () => {
    const world = new World();
    const plain = spawn(world, 'Prop');
    expect(listSkinJoints(world, plain)).toEqual([]);
    const root = spawn(world, 'Character', undefined, {
      component: Skin,
      data: { skeleton: 0, joints: [] },
    });
    expect(listSkinJoints(world, root)).toEqual([]);
  });

  it('listSkinJointsFor chains findSkinEntity + listSkinJoints for a prop', () => {
    const world = new World();
    const root = spawn(world, 'Character');
    const boneA = spawn(world, 'spine', root);
    const boneB = spawn(world, 'arm', root);
    // Add Skin after the bones exist so joints can reference their handles.
    const skinR = world.addComponent(root, { component: Skin, data: { skeleton: 0 as never, joints: [boneA, boneB] } });
    if (!skinR.ok) throw new Error(`add Skin failed: ${String(skinR.error)}`);
    const prop = spawn(world, 'sword', boneA);
    const joints = listSkinJointsFor(world, prop);
    expect(joints.map((j) => j.name)).toEqual(['spine', 'arm']);
  });

  it('listSkinJointsFor returns [] for a prop outside any skinned character', () => {
    const world = new World();
    const prop = spawn(world, 'looseProp');
    expect(listSkinJointsFor(world, prop)).toEqual([]);
  });
});
