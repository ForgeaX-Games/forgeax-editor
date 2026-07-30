import { describe, expect, it } from 'bun:test';
import { createRuntimeUiGraph, type EntityHandle } from '@forgeax/editor-core';
import { createHierarchyStructureSelector, type HierarchyEntitySummary } from '../hierarchy-state';

const row: HierarchyEntitySummary = { id: 1 as EntityHandle, name: 'Static', typeId: 'entity', mobility: 'static', childIds: [] };

describe('Hierarchy static structure projection', () => {
  it('keeps projection identity and mounted row identity stable at a static epoch', () => {
    const graph = createRuntimeUiGraph();
    let reads = 0;
    const world = { value: { structureEpoch: 4, rows: [row] } };
    graph.bindWorld(world);
    const selector = createHierarchyStructureSelector(graph, (value) => {
      reads += 1;
      return (value as typeof world).value;
    });
    const mounted = selector.mount();
    let commits = 0;
    mounted.subscribe(() => commits++);
    graph.publish();
    const first = mounted.getSnapshot();
    graph.publish();
    expect(mounted.getSnapshot()).toBe(first);
    expect(selector.stats().projectionRebuilds).toBe(1);
    expect(commits).toBe(1);
    expect(reads).toBe(2);
    mounted.unsubscribe();
    expect(graph.stats()).toMatchObject({ cacheEntries: 0, listeners: 0 });
  });
});
