import { describe, expect, it } from 'bun:test';
import { createRuntimeUiGraph, type EntityHandle } from '@forgeax/editor-core';
import { createHierarchyStructureSelector, type HierarchyEntitySummary } from '../hierarchy-state';

const h = (id: number) => id as EntityHandle;
const row = (id: number, name: string): HierarchyEntitySummary => ({
  id: h(id), name, typeId: 'entity', mobility: 'static', childIds: [],
});

function source(rows: readonly HierarchyEntitySummary[], structureEpoch: number) {
  return { rows, structureEpoch };
}

describe('Hierarchy runtime selector lifecycle', () => {
  it('rejects old World publishes and exposes the new generation after A to B to A', () => {
    const graph = createRuntimeUiGraph();
    const worldA = { value: source([row(1, 'A')], 1) };
    const worldB = { value: source([row(2, 'B')], 1) };
    graph.bindWorld(worldA);
    const selector = createHierarchyStructureSelector(graph, (world) => (world as typeof worldA).value);
    const first = selector.mount();
    let notifications = 0;
    first.subscribe(() => notifications++);
    graph.publish();
    const generationA = graph.stats().worldGeneration;
    expect(first.getSnapshot()?.rows.map((item) => item.name)).toEqual(['A']);

    graph.unbindWorld(worldA);
    graph.bindWorld(worldB);
    const generationB = graph.stats().worldGeneration;
    expect(generationB).toBeGreaterThan(generationA);
    expect(graph.publish({ world: worldA, worldGeneration: generationA })).toBe('stale');
    expect(notifications).toBe(1);

    const secondSelector = createHierarchyStructureSelector(graph, (world) => (world as typeof worldB).value);
    const second = secondSelector.mount();
    graph.publish();
    expect(second.getSnapshot()?.rows.map((item) => item.name)).toEqual(['B']);
    second.unsubscribe();

    graph.unbindWorld(worldB);
    graph.bindWorld(worldA);
    const thirdSelector = createHierarchyStructureSelector(graph, (world) => (world as typeof worldA).value);
    const third = thirdSelector.mount();
    graph.publish();
    expect(third.getSnapshot()?.rows.map((item) => item.name)).toEqual(['A']);
    expect(graph.stats()).toMatchObject({ listeners: 1, cacheEntries: 1 });
    first.unsubscribe();
    third.unsubscribe();
    expect(graph.stats()).toMatchObject({ listeners: 0, cacheEntries: 0, snapshotBytes: 0 });
  });

  it('returns to a clean baseline after panel close and reopen', () => {
    const graph = createRuntimeUiGraph();
    const active = { value: source([row(4, 'Panel')], 1) };
    graph.bindWorld(active);
    const selector = createHierarchyStructureSelector(graph, (world) => (world as typeof active).value);
    const mounted = selector.mount();
    graph.publish();
    mounted.unsubscribe();
    expect(graph.stats()).toMatchObject({ listeners: 0, cacheEntries: 0, snapshotBytes: 0 });

    const reopened = selector.mount();
    graph.publish();
    expect(reopened.getSnapshot()?.rows.map((item) => item.name)).toEqual(['Panel']);
    reopened.unsubscribe();
    expect(graph.stats()).toMatchObject({ listeners: 0, cacheEntries: 0, snapshotBytes: 0 });
  });
});
