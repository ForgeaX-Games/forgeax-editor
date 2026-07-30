import { describe, expect, it } from 'bun:test';
import { createRuntimeUiGraph } from '../../io/runtime-ui-diagnostics';
import { createInspectorFieldSelector, type InspectorFieldShape } from '../live-world-field-selectors';

const shape = (kind: InspectorFieldShape['kind']): InspectorFieldShape => ({ kind });

describe('Inspector field selectors', () => {
  it('reads scalar, tuple, vector, color, quaternion, and arrays from the mounted graph', () => {
    const world = {
      scalar: 3,
      tuple: [1, 2],
      vector: [1, 2, 3],
      color: [0.1, 0.2, 0.3, 1],
      quaternion: new Float32Array([0, 0, 0, 1]),
      array: [4, 5],
    };
    const graph = createRuntimeUiGraph();
    graph.bindWorld(world);
    const scalar = createInspectorFieldSelector(graph, { entity: 1, component: 'Test', field: 'scalar', shape: shape('scalar'), read: (w) => (w as typeof world).scalar });
    const tuple = createInspectorFieldSelector(graph, { entity: 1, component: 'Test', field: 'tuple', shape: shape('tuple'), read: (w) => (w as typeof world).tuple });
    const vector = createInspectorFieldSelector(graph, { entity: 1, component: 'Test', field: 'vector', shape: shape('vector'), read: (w) => (w as typeof world).vector });
    const color = createInspectorFieldSelector(graph, { entity: 1, component: 'Test', field: 'color', shape: shape('color'), read: (w) => (w as typeof world).color });
    const quaternion = createInspectorFieldSelector(graph, { entity: 1, component: 'Test', field: 'quaternion', shape: shape('quaternion'), read: (w) => (w as typeof world).quaternion });
    const array = createInspectorFieldSelector(graph, { entity: 1, component: 'Test', field: 'array', shape: shape('array'), read: (w) => (w as typeof world).array });
    const mounted = [scalar, tuple, vector, color, quaternion, array].map((selector) => selector.mount());

    graph.publish();

    expect(mounted.map((item) => item.getSnapshot()?.status)).toEqual(['available', 'available', 'available', 'available', 'available', 'available']);
    expect(mounted[0]?.getSnapshot()).toMatchObject({ value: 3 });
    expect(mounted[1]?.getSnapshot()).toMatchObject({ value: [1, 2] });
    expect(mounted[4]?.getSnapshot()).toMatchObject({ value: [0, 0, 0, 1] });
  });

  it('observes in-place TypedArray/POD writes without copying unmounted fields', () => {
    const world = { bytes: new Uint8Array([1, 2]), pod: { x: 1, y: 2 } };
    const graph = createRuntimeUiGraph();
    graph.bindWorld(world);
    const bytes = createInspectorFieldSelector(graph, { entity: 1, component: 'Test', field: 'bytes', shape: shape('typed-array'), read: (w) => (w as typeof world).bytes });
    const pod = createInspectorFieldSelector(graph, { entity: 1, component: 'Test', field: 'pod', shape: shape('pod'), read: (w) => (w as typeof world).pod });
    const bytesMounted = bytes.mount();
    const podMounted = pod.mount();
    let bytesNotifications = 0;
    let podNotifications = 0;
    bytesMounted.subscribe(() => bytesNotifications++);
    podMounted.subscribe(() => podNotifications++);
    graph.publish();
    bytesNotifications = 0;
    podNotifications = 0;
    world.bytes[0] = 9;
    world.pod.x = 4;
    graph.publish();
    expect(bytesMounted.getSnapshot()).toMatchObject({ value: [9, 2] });
    expect(podMounted.getSnapshot()).toMatchObject({ value: { x: 4, y: 2 } });
    expect(bytesNotifications).toBe(1);
    expect(podNotifications).toBe(1);
    expect(graph.stats().cacheEntries).toBe(2);
  });

  it('returns structured unavailable snapshots for unknown schema and stale reads', () => {
    const graph = createRuntimeUiGraph();
    const world = { value: 1 };
    graph.bindWorld(world);
    const unknown = createInspectorFieldSelector(graph, { entity: 1, component: 'Test', field: 'mystery', shape: shape('unknown'), read: () => ({ value: 1 }) });
    const stale = createInspectorFieldSelector(graph, { entity: 9, component: 'Test', field: 'value', shape: shape('scalar'), read: () => { throw new Error('stale entity'); } });
    const unknownMounted = unknown.mount();
    const staleMounted = stale.mount();
    graph.publish();
    expect(unknownMounted.getSnapshot()).toMatchObject({ status: 'unavailable', code: 'selector-value-shape-unsupported', retryable: true });
    expect(staleMounted.getSnapshot()).toMatchObject({ status: 'unavailable', retryable: true });
  });
});
