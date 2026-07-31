// R0-06E — repeated Play/Stop world-fork regression.
//
// This is the headless owner test for the public lifecycle contract exercised by
// e2e/play-stop-world-fork.spec.ts. A single successful fork is not enough: the
// dangerous regressions are cumulative (edit-world entity creep, a stale play
// handle resolving to a newly-created edit entity, or a listener retained per
// cycle). Keep the fixture deliberately non-trivial: authored hierarchy + a
// runtime child, queried through one function that survives every pointer swap.
//
// Anchors: R0-06E; AC-05 world drop; AC-06 edit isolation; AC-09 active-world
// reads; AC-14 structured stale handle; P2/P4/P7/P9.

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { Name, Transform, ChildOf } from '@forgeax/engine-scene';
import type { EntityHandle } from '../scene/scene-types';
import { EditGateway } from '../io/gateway';
import { createEditSession, childrenOf } from '../session/document';
import { entComponent, entName, worldEntityHandles } from '../store/entity-state';

const CYCLE_COUNT = 10;

function spawn(world: World, name: string, parent?: EntityHandle): EntityHandle {
  const components: Array<{ component: unknown; data: Record<string, unknown> }> = [
    { component: Name, data: { value: name } },
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  ];
  if (parent !== undefined) components.push({ component: ChildOf, data: { parent } });
  const result = world.spawn(...(components as never[]));
  if (!result.ok) throw new Error(`spawn failed: ${String(result.error)}`);
  return result.value as EntityHandle;
}

function names(world: World): string[] {
  return worldEntityHandles(world)
    .map((entity) => entName(world, entity))
    .sort();
}

describe('R0-06E repeated Play/Stop world fork', () => {
  it('keeps the authored world stable, rejects every stale play handle, and emits one lifecycle notification per transition', () => {
    const session = createEditSession();
    const editWorld = new World();
    session.world = editWorld;
    const editRoot = spawn(editWorld, 'EditRoot');
    spawn(editWorld, 'EditChild', editRoot);
    const gateway = new EditGateway(session);
    const query = gateway.buildQueryFn();
    const baselineNames = names(editWorld);
    const baselineCount = worldEntityHandles(editWorld).length;
    const notifications: Array<'starting' | 'play' | 'edit' | 'failed'> = [];
    const unsubscribe = gateway.subscribe(() => { notifications.push(gateway.playPhase); });
    const playWorlds = new Set<World>();

    for (let cycle = 1; cycle <= CYCLE_COUNT; cycle += 1) {
      const playWorld = new World();
      playWorlds.add(playWorld);

      // Force a generation difference from the authored slot-0 handle. Without
      // this, identical raw (slot, generation) values could mask a stale-handle
      // check by accidentally resolving to EditRoot.
      const throwaway = spawn(playWorld, `Throwaway-${cycle}`);
      playWorld.despawn(throwaway);
      const playRoot = spawn(playWorld, `PlayRoot-${cycle}`);
      const childThrowaway = spawn(playWorld, `ChildThrowaway-${cycle}`);
      playWorld.despawn(childThrowaway);
      const playChild = spawn(playWorld, `PlayChild-${cycle}`, playRoot);
      gateway.enterPlay(playWorld);

      expect(gateway.mode).toBe('play');
      expect(gateway.activeWorld).toBe(playWorld);
      expect(query({ with: ['Name'] })).toMatchObject({
        ok: true,
        rows: expect.arrayContaining([
          expect.objectContaining({ Name: { value: `PlayRoot-${cycle}` } }),
          expect.objectContaining({ Name: { value: `PlayChild-${cycle}` } }),
        ]),
      });
      expect(entComponent(gateway.activeWorld, playChild, 'Transform')).toMatchObject({ ok: true });
      expect(childrenOf(gateway.activeWorld, playRoot)).toContain(playChild);

      gateway.exitPlay();

      expect(gateway.mode).toBe('edit');
      expect(gateway.activeWorld).toBe(editWorld);
      expect(worldEntityHandles(editWorld)).toHaveLength(baselineCount);
      expect(names(editWorld)).toEqual(baselineNames);
      const stale = entComponent(gateway.activeWorld, playChild, 'Transform');
      expect(stale).toMatchObject({
        ok: false,
        error: { code: 'stale-entity-handle', objectRefs: { entity: { kind: 'entity', id: String(playChild) } } },
      });
    }

    unsubscribe();
    expect(playWorlds.size).toBe(CYCLE_COUNT);
    expect(notifications).toHaveLength(CYCLE_COUNT * 2);
    expect(notifications.filter((phase) => phase === 'play')).toHaveLength(CYCLE_COUNT);
    expect(notifications.filter((phase) => phase === 'edit')).toHaveLength(CYCLE_COUNT);
    expect(notifications).not.toContain('starting');
    expect(gateway.auditLog()).toEqual([]);
  });
});
