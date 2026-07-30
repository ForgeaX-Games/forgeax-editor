import { describe, expect, it } from 'bun:test';
import { createRuntimeUiGraph, createInspectorFieldSelector } from '@forgeax/editor-core';

describe('Inspector TypedArray and POD recovery', () => {
  it('publishes an immutable TypedArray snapshot with a byte estimate', () => {
    const world = { bytes: new Uint8Array([1, 2, 3]) };
    const graph = createRuntimeUiGraph();
    graph.bindWorld(world);
    const mounted = createInspectorFieldSelector(graph, {
      entity: 1,
      component: 'MeshRenderer',
      field: 'weights',
      shape: { kind: 'typed-array' },
      read: (value) => (value as typeof world).bytes,
    }).mount();

    graph.publish();
    const first = mounted.getSnapshot();
    expect(first?.status).toBe('available');
    if (first?.status !== 'available') return;
    expect(first.value as unknown as readonly number[]).toEqual([1, 2, 3]);
    expect(first.bytes).toBe(24);

    world.bytes[1] = 9;
    graph.publish();
    const second = mounted.getSnapshot();
    expect(second?.status).toBe('available');
    if (second?.status !== 'available') return;
    expect(second.value as unknown as readonly number[]).toEqual([1, 9, 3]);
    expect(second.value as unknown as readonly number[]).not.toBe(first.value);
  });

  it('returns an executable unavailable result for an unknown schema', () => {
    const graph = createRuntimeUiGraph();
    graph.bindWorld({ value: 1 });
    const mounted = createInspectorFieldSelector(graph, {
      entity: 1,
      component: 'MeshRenderer',
      field: 'mystery',
      shape: { kind: 'unknown', reason: 'schema is not available' },
      read: () => ({ value: 1 }),
    }).mount();

    graph.publish();
    expect(mounted.getSnapshot()).toMatchObject({
      status: 'unavailable',
      code: 'selector-value-shape-unsupported',
      retryable: true,
    });
  });
});
