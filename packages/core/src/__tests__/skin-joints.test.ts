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
  findJointRoot,
  findFacingPivot,
  readFacingYaw,
  listSkinSockets,
  FACING_PIVOT_NAME,
} from '../scene/skin-joints';
import { summarizeCalibration } from '../scene/calibration-projection';

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

// ── socket-calibration M2 — joint root / facing pivot / sockets / projection ──
//
// Tree used below:
//   root(Skin) ─ boneSpine ─ boneArm
//                └─ propSword        (ChildOf boneSpine; a socket)
//   boneArm has a child bone (a joint, NOT a socket) and propShield (a socket).
// A separate FacingPivot is inserted above the joint root to test the read.

describe('socket-calibration M2 — joint root, facing pivot, sockets, projection', () => {
  function buildSkinnedCharacter(world: World): {
    skin: EntityHandle;
    boneSpine: EntityHandle;
    boneArm: EntityHandle;
    boneHand: EntityHandle;
    propSword: EntityHandle;
    propShield: EntityHandle;
  } {
    const skin = spawn(world, 'Character');
    const boneSpine = spawn(world, 'spine', skin);
    const boneArm = spawn(world, 'arm', boneSpine);
    const boneHand = spawn(world, 'hand', boneArm);
    const propSword = spawn(world, 'sword', boneSpine);
    const propShield = spawn(world, 'shield', boneHand);
    const skinR = world.addComponent(skin, {
      component: Skin,
      data: { skeleton: 0 as never, joints: [boneSpine, boneArm, boneHand] },
    });
    if (!skinR.ok) throw new Error(`add Skin failed: ${String(skinR.error)}`);
    return { skin, boneSpine, boneArm, boneHand, propSword, propShield };
  }

  it('findJointRoot returns the lowest common ancestor of all joints', () => {
    const world = new World();
    const { skin, boneSpine } = buildSkinnedCharacter(world);
    // All joints (spine, arm, hand) descend from spine → spine is the LCA.
    expect(findJointRoot(world, skin)).toBe(boneSpine);
  });

  it('findJointRoot returns null for a Skin with no joints', () => {
    const world = new World();
    const skin = spawn(world, 'Character', undefined, {
      component: Skin,
      data: { skeleton: 0, joints: [] },
    });
    expect(findJointRoot(world, skin)).toBeNull();
  });

  it('findFacingPivot returns null when no FacingPivot exists above the joint root', () => {
    const world = new World();
    const { skin, boneSpine } = buildSkinnedCharacter(world);
    expect(findFacingPivot(world, boneSpine)).toBeNull();
    expect(readFacingYaw(world, skin)).toBeNull();
  });

  it('findFacingPivot + readFacingYaw read a pivot inserted above the joint root', () => {
    const world = new World();
    const { skin, boneSpine } = buildSkinnedCharacter(world);
    // Insert a FacingPivot above the joint root (spine): reparent spine under pivot.
    const pivot = spawn(world, FACING_PIVOT_NAME, undefined, {
      component: Transform,
      data: {
        // eulerToQuat(0, 90, 0) ≈ [0, sin(45°), 0, cos(45°)] = [0, 0.7071, 0, 0.7071]
        pos: [0, 0, 0],
        quat: [0, 0.70710678, 0, 0.70710678],
        scale: [1, 1, 1],
      },
    });
    const reparentR = world.addComponent(boneSpine, { component: ChildOf, data: { parent: pivot } });
    if (!reparentR.ok) throw new Error(`reparent failed: ${String(reparentR.error)}`);
    expect(findFacingPivot(world, boneSpine)).toBe(pivot);
    // 90° yaw → read back ~90 (quatToEuler rounds to 1e-4).
    expect(readFacingYaw(world, skin)).toBeCloseTo(90, 1);
  });

  it('listSkinSockets enumerates props (non-joint children of joints) with local TRS', () => {
    const world = new World();
    const { skin, propSword, propShield } = buildSkinnedCharacter(world);
    // Give the sword a distinct local pos so the projection carries it.
    const tfR = world.set(propSword, Transform, { pos: [2, 1, 0] } as never);
    if (!tfR.ok) throw new Error(`set Transform failed: ${String(tfR.error)}`);
    const sockets = listSkinSockets(world, skin);
    expect(sockets.map((s) => s.propName).sort()).toEqual(['shield', 'sword']);
    const sword = sockets.find((s) => s.propName === 'sword')!;
    expect(sword.boneName).toBe('spine');
    expect(sword.pos).toEqual([2, 1, 0]);
    const shield = sockets.find((s) => s.propName === 'shield')!;
    expect(shield.boneName).toBe('hand');
  });

  it('summarizeCalibration projects every skinned character to pure-numeric JSON', () => {
    const world = new World();
    const { skin, boneSpine, propSword } = buildSkinnedCharacter(world);
    // Author a facing pivot + a socket TRS.
    const pivot = spawn(world, FACING_PIVOT_NAME, undefined, {
      component: Transform,
      data: { pos: [0, 0, 0], quat: [0, 0.70710678, 0, 0.70710678], scale: [1, 1, 1] },
    });
    const reparentR = world.addComponent(boneSpine, { component: ChildOf, data: { parent: pivot } });
    if (!reparentR.ok) throw new Error(`reparent failed: ${String(reparentR.error)}`);
    const setR = world.set(propSword, Transform, { pos: [2, 1, 0] } as never);
    if (!setR.ok) throw new Error(`set Transform failed: ${String(setR.error)}`);

    const proj = summarizeCalibration(world);
    expect(proj.schemaVersion).toBe('calibration-v1');
    expect(proj.characters).toHaveLength(1);
    const ch = proj.characters[0]!;
    expect(ch.name).toBe('Character');
    expect(ch.facingYawDeg).toBeCloseTo(90, 1);
    const sword = ch.sockets.find((s) => s.name === 'sword')!;
    expect(sword.bone).toBe('spine');
    expect(sword.pos).toEqual([2, 1, 0]);
    // No entity handles leak into the projection.
    const json = JSON.stringify(proj);
    expect(json).not.toContain('handle');
    expect(json).not.toContain('EntityHandle');
  });

  it('summarizeCalibration returns empty characters for a scene with no Skin', () => {
    const world = new World();
    spawn(world, 'looseProp');
    const proj = summarizeCalibration(world);
    expect(proj.characters).toEqual([]);
  });
});
