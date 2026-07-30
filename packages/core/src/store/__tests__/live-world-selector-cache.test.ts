import { describe, expect, it } from 'bun:test';
import { LiveWorldSelectorGraph, type MountedSelector } from '../live-world-selector-graph';

function selector(key: string, reads: () => number): MountedSelector<number> {
  return { key, schema: { kind: 'primitive' }, read: reads };
}

describe('live world selector graph cache', () => {
  it('shares one read and one cache entry for same-key subscribers', () => {
    let reads = 0;
    const graph = new LiveWorldSelectorGraph();
    graph.bindWorld({ id: 'world' });
    const mounted = selector('position.x', () => ++reads);
    const first = graph.mount(mounted);
    const second = graph.mount(mounted);
    graph.publish();
    expect(reads).toBe(1);
    expect(first.getSnapshot()).toBe(second.getSnapshot());
    expect(graph.stats()).toMatchObject({ cacheEntries: 1, listeners: 2 });
  });

  it('releases cache, listeners, and bytes only after last unsubscribe', () => {
    const graph = new LiveWorldSelectorGraph();
    graph.bindWorld({ id: 'world' });
    const mounted = selector('value', () => 1);
    const first = graph.mount(mounted);
    const second = graph.mount(mounted);
    graph.publish();
    const bytes = graph.stats().snapshotBytes;
    first.unsubscribe();
    expect(graph.stats()).toMatchObject({ cacheEntries: 1, listeners: 1, snapshotBytes: bytes });
    second.unsubscribe();
    expect(graph.stats()).toMatchObject({ cacheEntries: 0, listeners: 0, snapshotBytes: 0 });
  });

  it('does not cache unmounted entities or components', () => {
    const graph = new LiveWorldSelectorGraph();
    graph.bindWorld({ id: 'world' });
    for (let i = 0; i < 1000; i++) {
      graph.publish();
    }
    expect(graph.stats()).toMatchObject({ cacheEntries: 0, listeners: 0, snapshotBytes: 0 });
  });
});
