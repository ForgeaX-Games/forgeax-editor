import { describe, expect, it } from 'bun:test';
import { LiveWorldSelectorGraph, type MountedSelector } from '../live-world-selector-graph';

const mounted: MountedSelector<number> = {
  key: 'health',
  schema: { kind: 'primitive' },
  read: (world) => (world as { health: number }).health,
};

describe('live world selector graph lifecycle', () => {
  it('binds and unbinds with a monotonic generation', () => {
    const graph = new LiveWorldSelectorGraph();
    const world = { health: 1 };
    expect(graph.bindWorld(world)).toBe(1);
    expect(graph.unbindWorld(world)).toBe(true);
    expect(graph.stats()).toMatchObject({ status: 'unbound', worldGeneration: 2 });
    expect(graph.bindWorld(world)).toBe(3);
  });

  it('does not let an expected-world mismatch unbind the current world', () => {
    const graph = new LiveWorldSelectorGraph();
    const current = { health: 1 };
    graph.bindWorld(current);
    expect(graph.unbindWorld({ health: 2 })).toBe(false);
    expect(graph.stats().status).toBe('bound');
  });

  it('rejects late publishes from an old generation', () => {
    const graph = new LiveWorldSelectorGraph();
    const oldWorld = { health: 1 };
    graph.bindWorld(oldWorld);
    const oldGeneration = graph.stats().worldGeneration;
    graph.unbindWorld(oldWorld);
    const currentWorld = { health: 2 };
    graph.bindWorld(currentWorld);
    const listener = graph.mount(mounted);
    let notifications = 0;
    listener.subscribe(() => notifications++);
    expect(graph.publish({ world: oldWorld, worldGeneration: oldGeneration })).toBe('stale');
    expect(notifications).toBe(0);
    expect(graph.publish()).toBe('published');
    expect(listener.getSnapshot()).toBe(2);
  });

  it('makes dispose idempotent and preserves cleanup after a listener error', () => {
    const graph = new LiveWorldSelectorGraph();
    graph.bindWorld({ health: 1 });
    const listener = graph.mount(mounted);
    listener.subscribe(() => { throw new Error('adjacent teardown'); });
    expect(() => graph.dispose()).not.toThrow();
    expect(() => graph.dispose()).not.toThrow();
    expect(graph.stats()).toMatchObject({ status: 'disposed', cacheEntries: 0, listeners: 0 });
  });
});
