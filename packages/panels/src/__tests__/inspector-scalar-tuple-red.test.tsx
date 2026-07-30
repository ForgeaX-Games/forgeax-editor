import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { createRuntimeUiGraph } from '@forgeax/editor-core';
import { createInspectorFieldSelector } from '@forgeax/editor-core';

const panel = readFileSync(resolve(import.meta.dir, '..', 'Inspector.tsx'), 'utf8');

describe('Inspector scalar and tuple field contracts', () => {
  it('keeps scalar and vector leaves on the mounted selector path', () => {
    expect(panel).toContain('createInspectorFieldSelector');
    expect(panel).toContain("shape: { kind: axis === undefined ? 'scalar' : 'array' }");
    expect(panel).toContain('onCommit={setField}');
    expect(panel).toContain('dispatchMutation({ kind: \'setComponent\'');
  });

  it('normalizes tuple-like field snapshots without sharing the source array', () => {
    const world = { field: [1, 2, 3] };
    const graph = createRuntimeUiGraph();
    graph.bindWorld(world);
    const mounted = createInspectorFieldSelector(graph, {
      entity: 1,
      component: 'Transform',
      field: 'pos',
      shape: { kind: 'tuple' },
      read: (value) => (value as typeof world).field,
    }).mount();

    graph.publish();
    const snapshot = mounted.getSnapshot();
    expect(snapshot?.status).toBe('available');
    if (snapshot?.status !== 'available') return;
    expect(snapshot.value).toEqual([1, 2, 3]);
    expect(snapshot.value).not.toBe(world.field);
  });
});
