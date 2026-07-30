import { describe, expect, it } from 'bun:test';
import { createRuntimeUiGraph, type EntityHandle } from '@forgeax/editor-core';
import { createHierarchyStructureSelector, type HierarchyEntitySummary } from '../hierarchy-state';

const h = (id: number) => id as EntityHandle;
const entity = (id: number, name: string, childIds: readonly EntityHandle[] = [], mobility: HierarchyEntitySummary['mobility'] = 'static'): HierarchyEntitySummary => ({
  id: h(id), name, typeId: childIds.length ? 'group' : 'entity', mobility, childIds,
});

describe('Hierarchy structure boundaries', () => {
  it('consumes one keyed tree after spawn, despawn, reparent, reorder, and summary changes', () => {
    const graph = createRuntimeUiGraph();
    const world = { value: { structureEpoch: 1, rows: [entity(1, 'A'), entity(2, 'B')] } };
    graph.bindWorld(world);
    const selector = createHierarchyStructureSelector(graph, (value) => (value as typeof world).value);
    const mounted = selector.mount();
    graph.publish();

    world.value = { structureEpoch: 2, rows: [entity(2, 'B', [h(3)]), entity(3, 'C', [], 'movable')] };
    graph.publish();
    expect(mounted.getSnapshot()?.rows).toEqual([
      entity(2, 'B', [h(3)]),
      entity(3, 'C', [], 'movable'),
    ]);
    expect(new Set(mounted.getSnapshot()?.rows.map((item) => item.id)).size).toBe(2);
    mounted.unsubscribe();
  });
});
