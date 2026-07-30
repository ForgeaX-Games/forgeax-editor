import { describe, expect, it } from 'bun:test';
import { createRuntimeUiGraph, type EntityHandle } from '@forgeax/editor-core';
import { createHierarchyStructureSelector, type HierarchyEntitySummary } from '../hierarchy-state';

const h = (id: number) => id as EntityHandle;
const entity = (id: number, name: string): HierarchyEntitySummary => ({ id: h(id), name, typeId: 'entity', mobility: 'static', childIds: [] });

describe('Hierarchy stale selection', () => {
  it('does not let a late old-generation publish restore selection in A to B to A', () => {
    const graph = createRuntimeUiGraph();
    const worldA = { value: { structureEpoch: 1, rows: [entity(1, 'A')] } };
    const worldB = { value: { structureEpoch: 1, rows: [entity(2, 'B')] } };
    graph.bindWorld(worldA);
    const selectorA = createHierarchyStructureSelector(graph, (value) => (value as typeof worldA).value);
    const mountedA = selectorA.mount();
    graph.publish();
    const oldGeneration = graph.stats().worldGeneration;
    graph.unbindWorld(worldA);
    graph.bindWorld(worldB);
    const selectorB = createHierarchyStructureSelector(graph, (value) => (value as typeof worldB).value);
    const mountedB = selectorB.mount();
    expect(graph.publish({ world: worldA, worldGeneration: oldGeneration })).toBe('stale');
    graph.publish();
    expect(mountedB.getSnapshot()?.rows.map((item) => item.name)).toEqual(['B']);
    expect(selectorB.resolveSelection(h(1))).toMatchObject({ ok: false, code: 'stale-entity-selection', retryable: true });
    mountedA.unsubscribe();
    mountedB.unsubscribe();
  });
});
