import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { createRuntimeUiGraph } from '@forgeax/editor-core';

const hostSession = readFileSync(resolve(import.meta.dir, '..', 'host-session.ts'), 'utf8');

describe('runtime cutover zero-work safety net', () => {
  it('keeps non-World surfaces outside the Play frame path', () => {
    expect(hostSession).not.toContain('notifyDocChanged();');
  });

  it('does no selector work for unchanged runtime churn and cleans stale state', () => {
    const graph = createRuntimeUiGraph();
    const oldWorld = { value: 7 };
    const nextWorld = { value: 8 };
    graph.bindWorld(oldWorld);
    const selector = graph.mount({
      key: 'runtime-cutover-zero-work',
      schema: { kind: 'primitive' as const },
      read: (world: unknown) => (world as { value: number }).value,
    });
    let notifications = 0;
    selector.subscribe(() => { notifications += 1; });

    expect(graph.publish()).toBe('published');
    for (let frame = 0; frame < 10; frame += 1) {
      expect(graph.publish()).toBe('published');
    }
    expect(notifications).toBe(1);
    expect(graph.stats()).toMatchObject({ cacheEntries: 1, listeners: 1, snapshotBytes: 8 });

    const oldGeneration = graph.stats().worldGeneration;
    selector.unsubscribe();
    graph.unbindWorld(oldWorld);
    graph.bindWorld(nextWorld);
    expect(graph.publish({ world: oldWorld, worldGeneration: oldGeneration })).toBe('stale');
    graph.unbindWorld(nextWorld);
    expect(graph.stats()).toMatchObject({ status: 'unbound', cacheEntries: 0, listeners: 0, snapshotBytes: 0 });
  });
});
