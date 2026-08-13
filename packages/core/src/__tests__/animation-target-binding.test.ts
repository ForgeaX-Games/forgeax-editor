import { describe, expect, it } from 'bun:test';
import {
  AnimationPlayer,
  AnimatedBy,
  AnimationTargetId,
  AnimationTargets,
} from '@forgeax/engine-animation';
import { World } from '@forgeax/engine-ecs';
import { SceneInstance } from '@forgeax/engine-render';
import { ChildOf, Name, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { EntityHandle } from '../scene/scene-types';
import {
  bindAllSceneAnimationTargets,
  bindSceneInstanceAnimationTargets,
  type AnimationTargetBindingOptions,
} from '../scene/animation-target-binding';
import { createEngineFacade } from '../io/engine-facade';

function spawnNode(world: World, name: string, parent?: EntityHandle): EntityHandle {
  const components: Array<{ component: unknown; data: Record<string, unknown> }> = [
    { component: Name, data: { value: name } },
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  ];
  if (parent !== undefined) components.push({ component: ChildOf, data: { parent } });
  return world.spawn(...(components as never[])).unwrap() as EntityHandle;
}

function makeImportedRig(withPlayer: boolean, withJoints = true, includeRootTarget = false, world = new World()): {
  world: World;
  sceneRoot: EntityHandle;
  rigRoot: EntityHandle;
  animationRoot: EntityHandle;
  skin: EntityHandle;
  joints: readonly EntityHandle[];
} {
  const rigRoot = spawnNode(world, 'rig');
  const spine = spawnNode(world, 'spine', rigRoot);
  const head = spawnNode(world, 'head', spine);
  const arm = spawnNode(world, 'arm', spine);
  const joints: EntityHandle[] = includeRootTarget ? [rigRoot, spine, head, arm] : [spine, head, arm];
  if (includeRootTarget) {
    world.addComponent(rigRoot, { component: AnimationTargetId, data: { value: '0'.repeat(32) } });
  }
  world.addComponent(spine, { component: AnimationTargetId, data: { value: 'a'.repeat(32) } });
  world.addComponent(head, { component: AnimationTargetId, data: { value: 'b'.repeat(32) } });
  world.addComponent(arm, { component: AnimationTargetId, data: { value: 'c'.repeat(32) } });

  const skin = spawnNode(world, 'fox');
  world.addComponent(skin, {
    component: Skin,
    data: { skeleton: 0 as never, joints: withJoints ? joints : [] },
  });
  if (withPlayer) {
    world.addComponent(skin, {
      component: AnimationPlayer,
      data: {
        clips: [],
        times: new Float32Array(0),
        weights: new Float32Array(0),
        speeds: new Float32Array(0),
      },
    });
  }

  const source = world.allocSharedRef('SceneAsset', { kind: 'scene', entities: [] });
  const state = world.allocUniqueRef('SceneInstanceState', {
    source,
    entityToLocalId: new Map<EntityHandle, number>([
      [rigRoot, 0],
      [spine, 1],
      [head, 2],
      [arm, 3],
      [skin, 4],
    ]),
    detachedLocalIds: new Set<number>(),
    overrides: new Map(),
    rootEntities: [rigRoot, skin],
    totalSlots: 5,
    mountTimeOverrides: [],
  });
  const sceneRoot = world
    .spawn({
      component: SceneInstance,
      data: { source, mapping: [rigRoot, spine, head, arm, skin], state },
    })
    .unwrap() as EntityHandle;
  world.addComponent(rigRoot, { component: ChildOf, data: { parent: sceneRoot } });
  world.addComponent(skin, { component: ChildOf, data: { parent: sceneRoot } });
  return {
    world,
    sceneRoot,
    rigRoot,
    animationRoot: includeRootTarget ? rigRoot : spine,
    skin,
    joints,
  };
}

function bind(
  fixture: ReturnType<typeof makeImportedRig>,
  options: Omit<AnimationTargetBindingOptions, 'mutation'> = {},
) {
  return bindSceneInstanceAnimationTargets(fixture.world, fixture.sceneRoot, {
    ...options,
    mutation: createEngineFacade(fixture.world),
  });
}

function makeSplitRootRig(): ReturnType<typeof makeImportedRig> {
  const fixture = makeImportedRig(true);
  const otherRoot = spawnNode(fixture.world, 'other-rig');
  const otherJoint = spawnNode(fixture.world, 'other-joint', otherRoot);
  fixture.world.addComponent(otherJoint, {
    component: AnimationTargetId,
    data: { value: 'd'.repeat(32) },
  });
  fixture.world.addComponent(otherRoot, { component: ChildOf, data: { parent: fixture.sceneRoot } });
  const instance = fixture.world.get(fixture.sceneRoot, SceneInstance).unwrap();
  fixture.world.set(fixture.sceneRoot, SceneInstance, {
    mapping: [...instance.mapping, otherRoot, otherJoint],
    state: instance.state,
  } as never);
  fixture.world.set(fixture.skin, Skin, {
    joints: [...fixture.joints, otherJoint],
  } as never);
  return { ...fixture, joints: [...fixture.joints, otherJoint] };
}

describe('imported animation target binding', () => {
  it('moves a Skin-owned player to the skeleton LCA and binds all joints', () => {
    const fixture = makeImportedRig(true);

    const first = bind(fixture);

    expect(first.changed).toBe(true);
    expect(first.failures).toEqual([]);
    expect(first.moved).toEqual([{ from: fixture.skin, to: fixture.animationRoot, targetCount: 3 }]);
    expect(fixture.world.get(fixture.skin, AnimationPlayer).ok).toBe(false);
    expect(fixture.world.get(fixture.animationRoot, AnimationPlayer).ok).toBe(true);
    expect([...fixture.world.get(fixture.animationRoot, AnimationTargets).unwrap().targets]).toEqual([...fixture.joints]);
    for (const joint of fixture.joints) {
      expect(fixture.world.get(joint, AnimatedBy).unwrap().player).toBe(fixture.animationRoot);
    }

    const second = bind(fixture);
    expect(second.changed).toBe(false);
    expect(second.failures).toEqual([]);
  });

  it('creates the empty player at the skeleton LCA when an importer omitted it', () => {
    const fixture = makeImportedRig(false);

    const result = bind(fixture, {
      ensurePlayerForSkin: true,
    });

    expect(result.failures).toEqual([]);
    expect(fixture.world.get(fixture.animationRoot, AnimationPlayer).ok).toBe(true);
    expect(fixture.world.get(fixture.skin, AnimationPlayer).ok).toBe(false);
    expect([...fixture.world.get(fixture.animationRoot, AnimationTargets).unwrap().targets]).toEqual([...fixture.joints]);
  });

  it('does not wait for the late Skin.joints resolver in a single-Skin import', () => {
    const fixture = makeImportedRig(true, false);

    const result = bind(fixture);

    expect(result.failures).toEqual([]);
    expect(result.moved).toEqual([{ from: fixture.skin, to: fixture.animationRoot, targetCount: 3 }]);
    expect([...fixture.world.get(fixture.animationRoot, AnimationTargets).unwrap().targets]).toEqual([...fixture.joints]);
  });

  it('keeps a player on a mapped skeleton root when that root is itself a target', () => {
    const fixture = makeImportedRig(true, true, true);

    const result = bind(fixture);

    expect(result.failures).toEqual([]);
    expect(result.moved).toEqual([{ from: fixture.skin, to: fixture.rigRoot, targetCount: 4 }]);
    expect(fixture.world.get(fixture.rigRoot, AnimationPlayer).ok).toBe(true);
    expect(fixture.world.get(fixture.sceneRoot, AnimationPlayer).ok).toBe(false);
    expect([...fixture.world.get(fixture.rigRoot, AnimationTargets).unwrap().targets]).toEqual([...fixture.joints]);
  });

  it('fails closed when one Skin spans multiple mapped roots with no persistable LCA', () => {
    const fixture = makeSplitRootRig();

    const result = bind(fixture);

    expect(result.failures.some((failure) => failure.code === 'animation-target-outside-player-root')).toBe(true);
    expect(fixture.world.get(fixture.skin, AnimationPlayer).ok).toBe(true);
    expect(fixture.world.get(fixture.sceneRoot, AnimationPlayer).ok).toBe(false);
  });

  it('scopes fallback skins and targets when old and staged scenes coexist', () => {
    const world = new World();
    const oldScene = makeImportedRig(true, true, false, world);
    const stagedScene = makeImportedRig(false, false, false, world);

    const reports = bindAllSceneAnimationTargets(world, {
      ensurePlayerForSkin: true,
      mutation: createEngineFacade(world),
    }, [stagedScene.sceneRoot]);

    expect(reports.flatMap((report) => report.failures)).toEqual([]);
    expect(world.get(stagedScene.animationRoot, AnimationPlayer).ok).toBe(true);
    expect(world.get(stagedScene.joints[0]!, AnimatedBy).unwrap().player).toBe(stagedScene.animationRoot);
    expect(world.get(oldScene.joints[0]!, AnimatedBy).ok).toBe(false);
  });

  it('replaces a zero-handle placeholder with an authored player', () => {
    const fixture = makeImportedRig(true, true, true);
    fixture.world.set(fixture.skin, AnimationPlayer, {
      clips: [7 as never],
      times: new Float32Array([0]),
      weights: new Float32Array([1]),
      speeds: new Float32Array([1]),
    });
    fixture.world.addComponent(fixture.rigRoot, {
      component: AnimationPlayer,
      data: {
        clips: [0 as never],
        times: new Float32Array([0]),
        weights: new Float32Array([1]),
        speeds: new Float32Array([1]),
      },
    });

    const result = bind(fixture);
    const player = fixture.world.get(fixture.rigRoot, AnimationPlayer).unwrap() as { clips: ArrayLike<number> };

    expect(result.failures).toEqual([]);
    expect(player.clips[0]).toBe(7);
    expect(fixture.world.get(fixture.skin, AnimationPlayer).ok).toBe(false);
  });

  it('reports a live second-player ownership conflict instead of claiming success', () => {
    const fixture = makeImportedRig(true);
    fixture.world.set(fixture.skin, AnimationPlayer, {
      clips: [7 as never],
      times: new Float32Array([0]),
      weights: new Float32Array([1]),
      speeds: new Float32Array([1]),
    });
    fixture.world.addComponent(fixture.rigRoot, {
      component: AnimationPlayer,
      data: {
        clips: [8 as never],
        times: new Float32Array([0]),
        weights: new Float32Array([1]),
        speeds: new Float32Array([1]),
      },
    });

    const result = bind(fixture);

    expect(result.failures.some((failure) => failure.code === 'animation-target-player-conflict')).toBe(true);
    expect(result.players).toContain(fixture.animationRoot);
    expect(result.players).not.toContain(fixture.rigRoot);
  });
});
