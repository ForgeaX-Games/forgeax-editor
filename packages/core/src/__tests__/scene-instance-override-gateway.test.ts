// SceneInstance Gateway contract — engine-owned source/mapping/override state
// projected through one public read model and one document write path.

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { Name, Transform } from '@forgeax/engine-scene';
import { SceneInstance } from '@forgeax/engine-render';
import { AnimationPlayer } from '@forgeax/engine-animation';
import type { SceneAsset, SceneEntity } from '@forgeax/engine-types';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import type { EntityHandle } from '../scene/scene-types';

void SceneInstance;
void AnimationPlayer;

function makeSceneAsset(): SceneAsset {
  const entity: SceneEntity = {
    localId: 0 as SceneEntity['localId'],
    components: {
      Name: { value: 'Mounted Box' },
      Transform: { pos: [1, 2, 3], scale: [1, 1, 1] },
      AnimationPlayer: {
        clips: [], times: [], weights: [], speeds: [],
        nodeWeights: [], nodeTimes: [], nodeSpeeds: [], paused: false, looping: true,
      },
    },
  };
  return { kind: 'scene', entities: [entity] };
}

function setup(): { gateway: EditGateway; world: World; root: EntityHandle; member: EntityHandle } {
  const world = new World();
  const assetHandle = world.allocSharedRef('SceneAsset', makeSceneAsset());
  const instantiated = world.instantiateScene(assetHandle);
  if (!instantiated.ok) throw new Error(`scene instantiate failed: ${String(instantiated.error)}`);
  const state = world.getSceneInstanceState(instantiated.value.root);
  if (!state.ok) throw new Error(`scene state read failed: ${String(state.error)}`);
  const member = state.value.entityToLocalId.keys().next().value;
  if (member === undefined) throw new Error('scene instance has no member');
  const session = createEditSession();
  session.world = world;
  return { gateway: new EditGateway(session), world, root: instantiated.value.root, member };
}

describe('SceneInstance Gateway public contract', () => {
  it('discovers, reads, overrides, reverts, and undoes a member field', () => {
    const { gateway, world, root, member } = setup();
    const read = gateway.sceneInstanceReadModel(root);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.root).toBe(root);
    expect(read.value.source.kind).toBe('scene');
    expect(read.value.members).toEqual([{ entity: member, localId: 0, name: 'Mounted Box', detached: false }]);
    expect(read.value.overrides).toEqual([]);
    expect(JSON.parse(JSON.stringify(read.value))).toEqual(read.value);

    const set = gateway.dispatch({
      kind: 'setSceneOverride',
      root,
      member,
      component: 'Transform',
      field: 'pos',
      value: [7, 8, 9],
    }, 'ai');
    expect(set.ok).toBe(true);
    const changed = world.get(member, Transform);
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(Array.from(changed.value.pos)).toEqual([7, 8, 9]);
    const afterSet = gateway.sceneInstanceReadModel(root);
    expect(afterSet.ok).toBe(true);
    if (!afterSet.ok) return;
    expect(afterSet.value.overrides).toEqual([{
      member,
      localId: 0,
      component: 'Transform',
      field: 'pos',
      value: [7, 8, 9],
    }]);
    expect(gateway.auditLog().at(-1)?.origin).toBe('ai');

    expect(gateway.undo()).toBe(true);
    const afterUndo = gateway.sceneInstanceReadModel(root);
    expect(afterUndo.ok).toBe(true);
    if (!afterUndo.ok) return;
    expect(afterUndo.value.overrides).toEqual([]);

    const setAgain = gateway.dispatch({ kind: 'setSceneOverride', root, member, component: 'Transform', field: 'pos', value: [4, 5, 6] });
    expect(setAgain.ok).toBe(true);
    const reverted = gateway.dispatch({ kind: 'removeSceneOverride', root, member, component: 'Transform', field: 'pos' });
    expect(reverted.ok).toBe(true);
    const afterRevert = gateway.sceneInstanceReadModel(root);
    expect(afterRevert.ok).toBe(true);
    if (!afterRevert.ok) return;
    expect(afterRevert.value.overrides).toEqual([]);
    const restored = world.get(member, Transform);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(Array.from(restored.value.pos)).toEqual([1, 2, 3]);

    expect(gateway.undo()).toBe(true);
    const afterRevertUndo = gateway.sceneInstanceReadModel(root);
    expect(afterRevertUndo.ok).toBe(true);
    if (!afterRevertUndo.ok) return;
    expect(afterRevertUndo.value.overrides[0]?.value).toEqual([4, 5, 6]);
  });

  it('finds the instance from a member and rejects a non-member target structurally', () => {
    const { gateway, root, member } = setup();
    const byMember = gateway.sceneInstanceForMember(member);
    expect(byMember.ok).toBe(true);
    if (!byMember.ok) return;
    expect(byMember.value.root).toBe(root);

    const rejected = gateway.dispatch({ kind: 'setSceneOverride', root, member: 999999, component: 'Transform', field: 'pos', value: [0, 0, 0] });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.code).toBe('SET_FAILED');
    expect(gateway.auditLog()).toEqual([]);
  });

  it('projects a grouped setComponent write as one complete AnimationPlayer override group', () => {
    const { gateway, world, root, member } = setup();
    const set = gateway.dispatch({
      kind: 'setComponent',
      entity: member,
      component: 'AnimationPlayer',
      patch: { clips: [0, 0], times: [2, 3], weights: [0.5, 0.25], speeds: [2, 0.5] },
    }, 'ai');
    expect(set.ok).toBe(true);
    const player = world.get(member, AnimationPlayer);
    expect(player.ok).toBe(true);
    if (!player.ok) return;
    expect(Array.from(player.value.clips as unknown as readonly number[])).toEqual([0, 0]);
    expect(Array.from(player.value.times)).toEqual([2, 3]);
    expect(Array.from(player.value.weights)).toEqual([0.5, 0.25]);
    expect(Array.from(player.value.speeds)).toEqual([2, 0.5]);
    const read = gateway.sceneInstanceReadModel(root);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.overrides.filter((override) => override.component === 'AnimationPlayer')).toHaveLength(4);

    expect(gateway.undo()).toBe(true);
    const restored = world.get(member, AnimationPlayer);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(Array.from(restored.value.clips as unknown as readonly number[])).toEqual([]);
    expect(Array.from(restored.value.times)).toEqual([]);
  });
});
