import { describe, expect, it } from 'bun:test';
import { createRuntimeUiGraph } from '@forgeax/editor-core';
import {
  createHierarchyStructureSelector,
  type HierarchyEntitySummary,
} from '../hierarchy-state';
import type { EntityHandle } from '@forgeax/editor-core';

const h = (id: number) => id as EntityHandle;

function world(rows: readonly HierarchyEntitySummary[], structureEpoch = 1) {
  return { structureEpoch, rows };
}

describe('Hierarchy runtime structure selector', () => {
  it('keeps static identity but rebuilds when row content changes at the same structure epoch', () => {
    const graph = createRuntimeUiGraph();
    const current = { value: world([{ id: h(1), name: 'Root', typeId: 'entity', mobility: 'static', childIds: [] }]) };
    graph.bindWorld(current);
    const selector = createHierarchyStructureSelector(graph, (value) => (value as typeof current).value);
    const mounted = selector.mount();
    graph.publish();
    const first = mounted.getSnapshot();
    graph.publish();
    expect(mounted.getSnapshot()).toBe(first);
    expect(selector.stats().projectionRebuilds).toBe(1);
    current.value = world([{ id: h(1), name: 'Renamed', typeId: 'entity', mobility: 'static', childIds: [] }]);
    graph.publish();
    expect(mounted.getSnapshot()?.rows[0]?.name).toBe('Renamed');
    expect(selector.stats().projectionRebuilds).toBe(2);
    current.value = world([{ id: h(1), name: 'Root', typeId: 'entity', mobility: 'static', childIds: [] }], 2);
    graph.publish();
    expect(selector.stats().projectionRebuilds).toBe(3);
    mounted.unsubscribe();
  });

  it('publishes keyed spawn, despawn, add/remove, reparent and reorder changes', () => {
    const graph = createRuntimeUiGraph();
    const current = { value: world([] as HierarchyEntitySummary[]) };
    graph.bindWorld(current);
    const selector = createHierarchyStructureSelector(graph, (value) => (value as typeof current).value);
    const mounted = selector.mount();
    graph.publish();
    current.value = world([
      { id: h(2), name: 'B', typeId: 'entity', mobility: 'movable', childIds: [] },
      { id: h(1), name: 'A', typeId: 'group', mobility: 'static', childIds: [h(2)] },
    ], 2);
    graph.publish();
    expect(mounted.getSnapshot()?.rows.map((row) => row.id)).toEqual([h(2), h(1)]);
    current.value = world([
      { id: h(1), name: 'A renamed', typeId: 'generic', mobility: 'stationary', childIds: [] },
    ], 3);
    graph.publish();
    expect(mounted.getSnapshot()?.rows).toEqual([
      { id: h(1), name: 'A renamed', typeId: 'generic', mobility: 'stationary', childIds: [] },
    ]);
    mounted.unsubscribe();
  });

  it('keeps a static selection recoverable when the selected entity becomes stale', () => {
    const graph = createRuntimeUiGraph();
    const current = { value: world([{ id: h(7), name: 'Selected', typeId: 'entity', mobility: 'static', childIds: [] }]) };
    graph.bindWorld(current);
    const selector = createHierarchyStructureSelector(graph, (value) => (value as typeof current).value);
    const mounted = selector.mount();
    graph.publish();
    expect(selector.resolveSelection(h(7))).toEqual({ ok: true, id: h(7) });
    current.value = world([], 2);
    graph.publish();
    expect(selector.resolveSelection(h(7))).toMatchObject({ ok: false, code: 'stale-entity-selection', retryable: true });
    mounted.unsubscribe();
  });
});
