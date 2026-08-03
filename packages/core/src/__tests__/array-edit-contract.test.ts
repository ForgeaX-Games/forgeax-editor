import { beforeAll, describe, expect, it } from 'bun:test';
import { AnimationPlayer } from '@forgeax/engine-animation';
import { applyCommand, createEditSession } from '../session/document';
import { _resetSchemaCache } from '../scene/schema';
import { planArrayEdit } from '../scene/array-edit';

beforeAll(() => {
  void AnimationPlayer;
  _resetSchemaCache();
});

describe('R0-03D array edit planning', () => {
  it('adds one slot across a producer-declared parallel group', () => {
    const plan = planArrayEdit(
      { component: 'AnimationPlayer', field: 'times', action: 'add', value: 0.25 },
      { clips: [], times: [], weights: [], speeds: [], nodeWeights: [], nodeTimes: [], nodeSpeeds: [] },
    );
    expect(plan).toEqual({
      ok: true,
      patch: { clips: [0], times: [0.25], weights: [1], speeds: [1] },
    });
  });

  it('reorders every member of the same group together', () => {
    const plan = planArrayEdit(
      { component: 'AnimationPlayer', field: 'weights', action: 'reorder', index: 0, toIndex: 1 },
      { clips: [10, 20], times: [1, 2], weights: [0.1, 0.2], speeds: [3, 4], nodeWeights: [], nodeTimes: [], nodeSpeeds: [] },
    );
    expect(plan).toEqual({
      ok: true,
      patch: { clips: [20, 10], times: [2, 1], weights: [0.2, 0.1], speeds: [4, 3] },
    });
  });

  it('rejects a path-local group mismatch before producing a patch', () => {
    const plan = planArrayEdit(
      { component: 'AnimationPlayer', field: 'times', action: 'update', index: 0, value: 0.5 },
      { clips: [], times: [0.1], weights: [], speeds: [], nodeWeights: [], nodeTimes: [], nodeSpeeds: [] },
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.fieldPath).toBe('AnimationPlayer.times');
  });
});

describe('R0-03D document field-path validation', () => {
  it('rejects unknown fields and parallel-array mismatch before engine update', () => {
    const session = createEditSession();
    const spawned = applyCommand(session, { kind: 'spawnEntity', name: 'R0-03D' });
    expect(spawned.ok).toBe(true);
    const entity = spawned.ok ? spawned.created[0]! : 0;
    const added = applyCommand(session, {
      kind: 'addComponent',
      entity,
      component: 'AnimationPlayer',
      value: { clips: [], times: [], weights: [], speeds: [], nodeWeights: [], nodeTimes: [], nodeSpeeds: [] },
    });
    expect(added.ok).toBe(true);

    const unknown = applyCommand(session, {
      kind: 'setComponent', entity, component: 'AnimationPlayer', patch: { notAField: [] },
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.details).toMatchObject({ fieldPath: 'AnimationPlayer.notAField' });

    const aligned = applyCommand(session, {
      kind: 'setComponent',
      entity,
      component: 'AnimationPlayer',
      patch: { clips: [0, 0], times: [0, 0], weights: [1, 1], speeds: [1, 1] },
    });
    expect(aligned.ok).toBe(true);

    const mismatch = applyCommand(session, {
      kind: 'setComponent', entity, component: 'AnimationPlayer', patch: { times: [0.5] },
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.details).toMatchObject({ fieldPath: 'AnimationPlayer.times', reason: 'parallel-array-length' });

    const valid = applyCommand(session, {
      kind: 'setComponent',
      entity,
      component: 'AnimationPlayer',
      patch: { clips: [], times: [], weights: [], speeds: [], nodeWeights: [], nodeTimes: [], nodeSpeeds: [] },
    });
    expect(valid.ok).toBe(true);
  });

  it('preserves fixed-array capacity as a field-path error', () => {
    const session = createEditSession();
    const spawned = applyCommand(session, { kind: 'spawnEntity', name: 'R0-03D-fixed' });
    expect(spawned.ok).toBe(true);
    const entity = spawned.ok ? spawned.created[0]! : 0;
    const invalid = applyCommand(session, { kind: 'setComponent', entity, component: 'Transform', patch: { pos: [1, 2] } });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.details).toMatchObject({ fieldPath: 'Transform.pos', reason: 'fixed-array-length' });
  });
});
