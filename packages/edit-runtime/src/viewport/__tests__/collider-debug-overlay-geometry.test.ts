// collider-debug-overlay-geometry.test.ts — pure geometry lock for solo P7 round-31.
//
// Keeps Collider chrome a projection of authored data: shape/extents +
// Transform.world in, immediate-mode line endpoints out. No engine world/GPU.

import { describe, expect, it } from 'bun:test';

import {
  COLLIDER_SHAPE_CAPSULE,
  COLLIDER_SHAPE_CUBOID,
  COLLIDER_SHAPE_SPHERE,
  colliderWireSegments,
} from '../viewport-collider-geometry';

const IDENTITY = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

function hasSegment(
  segments: ReadonlyArray<{ readonly from: ArrayLike<number>; readonly to: ArrayLike<number> }>,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
): boolean {
  return segments.some((segment) => [0, 1, 2].every((axis) => (
    segment.from[axis] === from[axis] && segment.to[axis] === to[axis]
  )));
}

describe('colliderWireSegments', () => {
  it('draws the 12 asymmetric cuboid edges through world translation', () => {
    const segments = colliderWireSegments(
      { shape: COLLIDER_SHAPE_CUBOID, halfExtents: [1.25, 0.75, 0.5] },
      [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        4, 2, -3, 1,
      ],
    );
    expect(segments).toHaveLength(12);
    expect(hasSegment(segments, [2.75, 1.25, -3.5], [5.25, 1.25, -3.5])).toBe(true);
    expect(hasSegment(segments, [2.75, 2.75, -3.5], [2.75, 1.25, -3.5])).toBe(true);
  });

  it('projects cuboid endpoints through parent-style rotation and scale in Transform.world', () => {
    // Column-major world matrix: 90° about +Z, scale X by 2, translation [10, 20, 30].
    const segments = colliderWireSegments(
      { shape: COLLIDER_SHAPE_CUBOID, halfExtents: [1, 2, 3] },
      [
        0, 2, 0, 0,
        -1, 0, 0, 0,
        0, 0, 1, 0,
        10, 20, 30, 1,
      ],
    );
    expect(hasSegment(segments, [12, 18, 27], [12, 22, 27])).toBe(true);
  });

  it('uses three great-circle rings for a sphere', () => {
    const segments = colliderWireSegments({ shape: COLLIDER_SHAPE_SPHERE, radius: 2 }, IDENTITY);
    expect(segments).toHaveLength(48);
    expect(Array.from(segments[0]!.from)).toEqual([2, 0, 0]);
    for (const segment of segments) {
      for (const value of [...segment.from, ...segment.to]) expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('uses seam rings, rails, and hemisphere arcs for a capsule', () => {
    const segments = colliderWireSegments(
      { shape: COLLIDER_SHAPE_CAPSULE, radius: 0.5, halfHeight: 1 },
      IDENTITY,
    );
    expect(segments).toHaveLength(68);
    expect(hasSegment(segments, [0.5, -1, 0], [0.5, 1, 0])).toBe(true);
    expect(segments.some((segment) => Math.abs(segment.from[1]! - 1.5) < 1e-12 || Math.abs(segment.to[1]! - 1.5) < 1e-12)).toBe(true);
  });

  it('falls back safely for malformed collider or world values', () => {
    expect(() => colliderWireSegments({ shape: 999, halfExtents: [-1, Number.NaN] }, [1, 2, 3])).not.toThrow();
    const segments = colliderWireSegments({ shape: 'bad', halfExtents: [] }, null);
    expect(segments).toHaveLength(12);
    expect(hasSegment(segments, [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5])).toBe(true);
  });
});
