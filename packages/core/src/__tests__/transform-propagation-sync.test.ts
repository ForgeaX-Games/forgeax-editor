import { describe, expect, it, beforeEach } from 'bun:test';
import { registerPropagateTransforms, Transform, Name } from '@forgeax/engine-scene';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import type { EditSession } from '../types';
import type { EntityHandle } from '../scene/scene-types';
import { opAffectsWorldTransform } from '../scene/transform-propagation-sync';
import { createCoreTestWorld } from './fixtures/world';

describe('transform propagation sync after document writes', () => {
  let gw: EditGateway;
  let entity: EntityHandle;

  beforeEach(() => {
    const session = createEditSession();
    const world = createCoreTestWorld();
    registerPropagateTransforms(world);
    session.world = world as unknown as EditSession['world'];
    gw = new EditGateway(session);
    const spawned = world.spawn(
      { component: Name, data: { value: 'Entity' } },
      { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    );
    if (!spawned.ok) throw new Error('spawn failed');
    entity = spawned.value as EntityHandle;
  });

  it('opAffectsWorldTransform matches Transform setComponent', () => {
    expect(opAffectsWorldTransform({ kind: 'setComponent', entity, component: 'Transform', patch: { pos: [1, 0, 0] } })).toBe(true);
    expect(opAffectsWorldTransform({ kind: 'setComponent', entity, component: 'Name', patch: { value: 'A' } })).toBe(false);
  });

  it('setComponent Transform updates Transform.world before the next world.update()', () => {
    const world = gw.activeWorld;
    const before = world.get(entity, Transform);
    expect(before.ok).toBe(true);
    if (before.ok) {
      expect(before.value.world[12]).toBe(0);
    }

    const r = gw.dispatch({ kind: 'setComponent', entity, component: 'Transform', patch: { pos: [3, 4, 5] } });
    expect(r.ok).toBe(true);

    const after = world.get(entity, Transform);
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.value.pos[0]).toBe(3);
      expect(after.value.world[12]).toBeCloseTo(3);
      expect(after.value.world[13]).toBeCloseTo(4);
      expect(after.value.world[14]).toBeCloseTo(5);
    }
  });
});
