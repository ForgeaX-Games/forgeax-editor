import { describe, expect, it } from 'bun:test';
import { FrameEnd } from '@forgeax/engine-ecs';
import { createRuntimeUiGraph } from '@forgeax/editor-core';
import { createLiveWorldFrameEndPublisher } from '../run-lifecycle';

describe('live world FrameEnd publisher lifecycle', () => {
  it('registers one publisher for the active World and publishes only at FrameEnd', () => {
    const calls: string[] = [];
    const graph = {
      bindWorld: (world: unknown) => { calls.push(`bind:${String(world)}`); return 4; },
      unbindWorld: (world: unknown) => { calls.push(`unbind:${String(world)}`); return true; },
      publish: () => { calls.push('publish'); return 'published' as const; },
    };
    const systems: string[] = [];
    const world = {
      addSystem: (schedule: typeof FrameEnd, descriptor: { name: string; fn: () => void }) => {
        systems.push(`${schedule.name}:${descriptor.name}`);
        return { ok: true as const };
      },
      removeSystem: (schedule: typeof FrameEnd, name: string) => {
        systems.push(`remove:${schedule.name}:${name}`);
        return { ok: true as const };
      },
    };
    const publisher = createLiveWorldFrameEndPublisher(graph);
    publisher.bind(world);
    expect(systems).toEqual(['FrameEnd:editor-runtime-ui-publisher']);
    publisher.publishFrameEnd();
    expect(calls).toEqual(['bind:[object Object]', 'publish']);
    publisher.unbind(world);
    expect(calls).toEqual(['bind:[object Object]', 'publish', 'unbind:[object Object]']);
    expect(systems).toContain('remove:FrameEnd:editor-runtime-ui-publisher');
  });

  it('keeps cleanup running when an adjacent teardown operation throws', () => {
    const publisher = createLiveWorldFrameEndPublisher({
      bindWorld: () => 1,
      unbindWorld: () => { throw new Error('teardown'); },
      publish: () => 'published' as const,
    });
    expect(() => publisher.unbind({
      addSystem: () => ({ ok: true }),
      removeSystem: () => { throw new Error('teardown'); },
    })).not.toThrow();
  });

  it('returns publisher, listener, cache, and snapshot bytes to baseline for ten cycles', () => {
    const graph = createRuntimeUiGraph();
    let frameEndA: (() => void) | undefined;
    let frameEndB: (() => void) | undefined;
    const worldA = {
      value: 1,
      addSystem: (_schedule: typeof FrameEnd, descriptor: { name: string; fn: () => void }) => {
        frameEndA = descriptor.fn;
        return { ok: true as const };
      },
      removeSystem: () => { throw new Error('adjacent teardown'); },
    };
    const worldB = {
      value: 2,
      addSystem: (_schedule: typeof FrameEnd, descriptor: { name: string; fn: () => void }) => {
        frameEndB = descriptor.fn;
        return { ok: true as const };
      },
      removeSystem: () => ({ ok: true as const }),
    };
    const publisher = createLiveWorldFrameEndPublisher(graph);
    const selector = (key: string) => ({
      key,
      schema: { kind: 'primitive' as const },
      read: (world: unknown) => (world as { value: number }).value,
    });
    const assertBaseline = (): void => {
      expect(graph.stats()).toMatchObject({ status: 'unbound', cacheEntries: 0, listeners: 0, snapshotBytes: 0 });
    };

    assertBaseline();
    for (let round = 0; round < 10; round += 1) {
      publisher.bind(worldA);
      const generationA = graph.stats().worldGeneration;
      const first = graph.mount(selector(`cycle-a-${round}`));
      let firstNotifications = 0;
      first.subscribe(() => { firstNotifications += 1; });
      frameEndA?.();
      expect(first.getSnapshot()).toBe(1);
      expect(firstNotifications).toBe(1);
      first.unsubscribe();
      expect(graph.stats()).toMatchObject({ status: 'bound', cacheEntries: 0, listeners: 0, snapshotBytes: 0 });

      publisher.bind(worldB);
      const generationB = graph.stats().worldGeneration;
      const second = graph.mount(selector(`cycle-b-${round}`));
      let secondNotifications = 0;
      second.subscribe(() => { secondNotifications += 1; });
      frameEndB?.();
      expect(second.getSnapshot()).toBe(2);
      expect(secondNotifications).toBe(1);
      expect(graph.publish({ world: worldA, worldGeneration: generationA })).toBe('stale');
      expect(secondNotifications).toBe(1);
      expect(graph.stats().worldGeneration).toBe(generationB);
      second.unsubscribe();
      publisher.unbind(worldB);
      assertBaseline();

      publisher.bind(worldA);
      const reopened = graph.mount(selector(`reopened-${round}`));
      frameEndA?.();
      expect(reopened.getSnapshot()).toBe(1);
      reopened.unsubscribe();
      publisher.unbind(worldA);
      assertBaseline();
    }
  });
});
