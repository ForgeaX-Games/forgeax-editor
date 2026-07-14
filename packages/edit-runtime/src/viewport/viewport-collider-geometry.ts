// viewport-collider-geometry.ts — pure authored-Collider wireframe geometry.
//
// The editor viewport uses engine-debug-draw's immediate-mode line overlay as
// chrome, not authored ECS mesh entities. This module computes the overlay's
// local shape geometry and projects it through Transform.world; the injected
// runtime bridge owns world reads and debugDraw.line() side effects.
//
// solo P7 round-31: a Collider can simulate in Play but was invisible while
// authoring. The engine already owns the on-top debug-draw renderer. Keeping
// this geometry pure makes the projection testable without DOM/GPU/world state.

import { mat4, vec3 } from '@forgeax/engine-math';
import type { Mat4Like, Vec3 } from '@forgeax/engine-math';

export type ColliderWireSegment = {
  readonly from: Vec3;
  readonly to: Vec3;
};

export const COLLIDER_SHAPE_CUBOID = 0;
export const COLLIDER_SHAPE_SPHERE = 1;
export const COLLIDER_SHAPE_CAPSULE = 2;

const IDENTITY_WORLD: Mat4Like = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

const RING_SEGMENTS = 16;
const CAPSULE_ARC_SEGMENTS = 8;

/**
 * Build a selected Collider's wireframe in scene-world coordinates.
 *
 * `Collider` schema defaults are deliberately repeated as fallbacks only: the
 * engine component remains the authoritative descriptor; this function merely
 * guards an incomplete/stale read from crashing an editor frame.
 */
export function colliderWireSegments(
  collider: Readonly<Record<string, unknown>>,
  transformWorld: unknown,
): ColliderWireSegment[] {
  const world = validWorld(transformWorld) ? transformWorld : IDENTITY_WORLD;
  const shape = finite(collider.shape, COLLIDER_SHAPE_CUBOID);
  const local = shape === COLLIDER_SHAPE_SPHERE
    ? sphereSegments(radiusOf(collider))
    : shape === COLLIDER_SHAPE_CAPSULE
      ? capsuleSegments(halfHeightOf(collider), radiusOf(collider))
      : cuboidSegments(halfExtentsOf(collider));
  return local.map(({ from, to }) => ({
    from: transformPoint(world, from),
    to: transformPoint(world, to),
  }));
}

function cuboidSegments(half: Vec3): ColliderWireSegment[] {
  const hx = half[0]!;
  const hy = half[1]!;
  const hz = half[2]!;
  const corners: Vec3[] = [
    point(-hx, -hy, -hz), point(hx, -hy, -hz), point(hx, hy, -hz), point(-hx, hy, -hz),
    point(-hx, -hy, hz), point(hx, -hy, hz), point(hx, hy, hz), point(-hx, hy, hz),
  ];
  const edges: ReadonlyArray<readonly [number, number]> = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  return edges.map(([a, b]) => ({ from: corners[a]!, to: corners[b]! }));
}

function sphereSegments(radius: number): ColliderWireSegment[] {
  const segments: ColliderWireSegment[] = [];
  appendCircle(segments, point(0, 0, 0), point(1, 0, 0), point(0, 1, 0), radius, RING_SEGMENTS);
  appendCircle(segments, point(0, 0, 0), point(1, 0, 0), point(0, 0, 1), radius, RING_SEGMENTS);
  appendCircle(segments, point(0, 0, 0), point(0, 1, 0), point(0, 0, 1), radius, RING_SEGMENTS);
  return segments;
}

/** Capsule local axis is +Y, matching Rapier ColliderDesc.capsule(halfHeight, radius). */
function capsuleSegments(halfHeight: number, radius: number): ColliderWireSegment[] {
  const segments: ColliderWireSegment[] = [];
  const top = point(0, halfHeight, 0);
  const bottom = point(0, -halfHeight, 0);

  // Cylinder seam rings and its four longitudinal silhouette rails.
  appendCircle(segments, top, point(1, 0, 0), point(0, 0, 1), radius, RING_SEGMENTS);
  appendCircle(segments, bottom, point(1, 0, 0), point(0, 0, 1), radius, RING_SEGMENTS);
  for (const [x, z] of [[radius, 0], [-radius, 0], [0, radius], [0, -radius]] as const) {
    segments.push({ from: point(x, -halfHeight, z), to: point(x, halfHeight, z) });
  }

  // Four great-circle hemisphere arcs (two orthogonal planes, upper + lower).
  appendHemisphereArc(segments, halfHeight, radius, 'x', 1);
  appendHemisphereArc(segments, halfHeight, radius, 'x', -1);
  appendHemisphereArc(segments, halfHeight, radius, 'z', 1);
  appendHemisphereArc(segments, halfHeight, radius, 'z', -1);
  return segments;
}

function appendHemisphereArc(
  out: ColliderWireSegment[],
  halfHeight: number,
  radius: number,
  axis: 'x' | 'z',
  upper: 1 | -1,
): void {
  let previous: Vec3 | undefined;
  for (let i = 0; i <= CAPSULE_ARC_SEGMENTS; i += 1) {
    const theta = (i / CAPSULE_ARC_SEGMENTS) * Math.PI;
    const horizontal = radius * Math.cos(theta);
    const vertical = radius * Math.sin(theta);
    const y = upper * (halfHeight + vertical);
    const next = axis === 'x' ? point(horizontal, y, 0) : point(0, y, horizontal);
    if (previous) out.push({ from: previous, to: next });
    previous = next;
  }
}

function appendCircle(
  out: ColliderWireSegment[],
  center: Vec3,
  u: Vec3,
  v: Vec3,
  radius: number,
  count: number,
): void {
  let previous: Vec3 | undefined;
  let first: Vec3 | undefined;
  for (let i = 0; i < count; i += 1) {
    const theta = (i / count) * Math.PI * 2;
    const c = Math.cos(theta) * radius;
    const s = Math.sin(theta) * radius;
    const next = point(
      center[0]! + u[0]! * c + v[0]! * s,
      center[1]! + u[1]! * c + v[1]! * s,
      center[2]! + u[2]! * c + v[2]! * s,
    );
    if (previous) out.push({ from: previous, to: next });
    else first = next;
    previous = next;
  }
  if (previous && first) out.push({ from: previous, to: first });
}

function point(x: number, y: number, z: number): Vec3 {
  return vec3.create(x, y, z);
}

function halfExtentsOf(collider: Readonly<Record<string, unknown>>): Vec3 {
  const values = collider.halfExtents as ArrayLike<unknown> | undefined;
  return point(
    nonNegative(values?.[0], 0.5),
    nonNegative(values?.[1], 0.5),
    nonNegative(values?.[2], 0.5),
  );
}

function radiusOf(collider: Readonly<Record<string, unknown>>): number {
  return nonNegative(collider.radius, 0.5);
}

function halfHeightOf(collider: Readonly<Record<string, unknown>>): number {
  return nonNegative(collider.halfHeight, 0.5);
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function validWorld(value: unknown): value is Mat4Like {
  if (value == null || typeof value !== 'object' || !('length' in value)) return false;
  const matrix = value as ArrayLike<unknown>;
  if (matrix.length !== 16) return false;
  for (let i = 0; i < 16; i += 1) {
    if (typeof matrix[i] !== 'number' || !Number.isFinite(matrix[i] as number)) return false;
  }
  return true;
}

/** Apply the engine's column-major Transform.world matrix to a local point. */
function transformPoint(world: Mat4Like, local: Vec3): Vec3 {
  return mat4.transformPoint(vec3.create(), world, local);
}
