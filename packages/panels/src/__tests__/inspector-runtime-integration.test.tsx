import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { createInspectorFieldSelector, createRuntimeUiGraph } from '@forgeax/editor-core';

const panel = readFileSync(resolve(import.meta.dir, '..', 'Inspector.tsx'), 'utf8');

describe('Inspector runtime integration recovery', () => {
  it('keeps the panel on the mounted selector and generation boundary', () => {
    expect(panel).toContain('createInspectorFieldSelector');
    expect(panel).toContain('useSyncExternalStore');
    expect(panel).toContain('worldGeneration');
    expect(panel).toContain('selectionGeneration');
    expect(panel).toContain('readOnly');
  });

  it('recovers a field after A to B generation replacement without stale value leakage', () => {
    const worldA = { value: 3 };
    const worldB = { value: 8 };
    const graph = createRuntimeUiGraph();
    graph.bindWorld(worldA);
    const selector = createInspectorFieldSelector(graph, {
      entity: 1,
      component: 'Transform',
      field: 'value',
      shape: { kind: 'scalar' },
      read: (world) => (world as { value: number }).value,
    });
    const mounted = selector.mount();
    let notifications = 0;
    mounted.subscribe(() => notifications++);
    graph.publish();
    expect(mounted.getSnapshot()).toMatchObject({ status: 'available', value: 3 });
    const oldGeneration = graph.stats().worldGeneration;
    graph.unbindWorld(worldA);
    graph.bindWorld(worldB);
    expect(graph.publish({ world: worldA, worldGeneration: oldGeneration })).toBe('stale');
    const replacement = createInspectorFieldSelector(graph, {
      entity: 1,
      component: 'Transform',
      field: 'value',
      shape: { kind: 'scalar' },
      read: (world) => (world as { value: number }).value,
    }).mount();
    graph.publish();
    expect(replacement.getSnapshot()).toMatchObject({ status: 'available', value: 8 });
    expect(notifications).toBe(1);
  });

  it('keeps local selector failures executable and isolated', () => {
    const graph = createRuntimeUiGraph();
    graph.bindWorld({ value: 1 });
    const failing = createInspectorFieldSelector(graph, {
      entity: 1,
      component: 'Transform',
      field: 'missing',
      shape: { kind: 'unknown', reason: 'schema is not available' },
      read: () => 1,
    }).mount();
    const healthy = createInspectorFieldSelector(graph, {
      entity: 1,
      component: 'Transform',
      field: 'value',
      shape: { kind: 'scalar' },
      read: (world) => (world as { value: number }).value,
    }).mount();
    graph.publish();
    expect(failing.getSnapshot()).toMatchObject({ status: 'unavailable', retryable: true });
    expect(healthy.getSnapshot()).toMatchObject({ status: 'available', value: 1 });
  });
});
