import { describe, expect, it } from 'bun:test';
import { createRuntimeUiGraph } from '../../io/runtime-ui-diagnostics';
import { mountTransformEulerLiveSelector } from '../transform-euler-live-selector';

describe('mountTransformEulerLiveSelector', () => {
  it('derives euler degrees once per publish from readQuat', () => {
    const world = { quat: new Float32Array([0, 0.3826834, 0, 0.9238795]) };
    const graph = createRuntimeUiGraph();
    graph.bindWorld(world);
    const selector = mountTransformEulerLiveSelector(graph, {
      entity: 7,
      readQuat: (w) => {
        const q = (w as typeof world).quat;
        return [q[0]!, q[1]!, q[2]!, q[3]!];
      },
    });
    const mounted = selector.mount();
    graph.publish();
    const snap = mounted.getSnapshot();
    expect(snap?.status).toBe('available');
    if (snap?.status !== 'available') return;
    expect(Math.abs(snap.value.rotY)).toBeCloseTo(45, 0);
    expect(Math.abs(snap.value.rotX)).toBeCloseTo(0, 0);
    expect(Math.abs(snap.value.rotZ)).toBeCloseTo(0, 0);
  });

  it('notifies subscribers when quat changes in-place before republish', () => {
    const world = { quat: new Float32Array([0, 0, 0, 1]) };
    const graph = createRuntimeUiGraph();
    graph.bindWorld(world);
    const mounted = mountTransformEulerLiveSelector(graph, {
      entity: 1,
      readQuat: (w) => {
        const q = (w as typeof world).quat;
        return [q[0]!, q[1]!, q[2]!, q[3]!];
      },
    }).mount();
    let n = 0;
    mounted.subscribe(() => n++);
    graph.publish();
    n = 0;
    world.quat[1] = 0.3826834;
    world.quat[3] = 0.9238795;
    graph.publish();
    expect(n).toBeGreaterThan(0);
    const snap = mounted.getSnapshot();
    expect(snap?.status).toBe('available');
    if (snap?.status !== 'available') return;
    expect(Math.abs(snap.value.rotY)).toBeCloseTo(45, 0);
  });
});
