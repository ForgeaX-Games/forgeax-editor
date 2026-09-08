// bounds-overlay.test.ts — pure geometry lock for the Mesh preview Bounds gizmo.
//
// The engine DebugDraw owns rendering/flush. This locks the editor bridge: the
// preview assembly's current subject AABB is read once per frame and projected
// to a single DebugDraw.aabb call; all non-applicable states are genuine no-ops.

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import type { DebugDraw } from '@forgeax/engine-debug-draw';
import type { ColorLike, Vec3 } from '@forgeax/engine-math';

import { installBoundsOverlay, type BoundsOverlayAabb } from '../bounds-overlay';

type Box = {
  readonly min: Vec3;
  readonly max: Vec3;
  readonly color: readonly number[];
};

function makeHarness() {
  const world = new World();
  let aabb: BoundsOverlayAabb = [-1, -2, -3, 4, 5, 6];
  let visible = true;
  const boxes: Box[] = [];
  const debugDraw = {
    aabb(min: Vec3, max: Vec3, color: ColorLike) {
      boxes.push({ min, max, color: Array.from(color) });
    },
  } satisfies Pick<DebugDraw, 'aabb'>;
  installBoundsOverlay({
    world,
    debugDraw,
    getAabb: () => aabb,
    isVisible: () => visible,
  });
  return {
    boxes,
    tick: () => world.update(1 / 60).unwrap(),
    setAabb: (value: BoundsOverlayAabb) => { aabb = value; },
    setVisible: (value: boolean) => { visible = value; },
  };
}

describe('installBoundsOverlay', () => {
  it('emits one DebugDraw.aabb call per frame from the current subject AABB without a world write', () => {
    const h = makeHarness();
    h.tick();
    expect(h.boxes).toHaveLength(1);
    expect(Array.from(h.boxes[0]!.min)).toEqual([-1, -2, -3]);
    expect(Array.from(h.boxes[0]!.max)).toEqual([4, 5, 6]);
    expect(h.boxes[0]!.color).toEqual([0.35, 0.85, 0.55, 1]);

    h.boxes.length = 0;
    h.setAabb([0, 0, 0, 2, 2, 2]);
    h.tick();
    expect(h.boxes).toHaveLength(1);
    expect(Array.from(h.boxes[0]!.min)).toEqual([0, 0, 0]);
    expect(Array.from(h.boxes[0]!.max)).toEqual([2, 2, 2]);
  });

  it('is a no-op with no subject AABB, hidden overlay, or missing DebugDraw', () => {
    const h = makeHarness();
    h.setAabb(null); h.tick();
    expect(h.boxes).toHaveLength(0);

    h.setAabb([0, 0, 0, 1, 1, 1]);
    h.setVisible(false); h.tick();
    expect(h.boxes).toHaveLength(0);

    h.setVisible(true);
    const world = new World();
    expect(() => installBoundsOverlay({
      world,
      debugDraw: undefined,
      getAabb: () => [0, 0, 0, 1, 1, 1],
      isVisible: () => true,
    })).not.toThrow();
    world.update(1 / 60).unwrap();
  });
});
