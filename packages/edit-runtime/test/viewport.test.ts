import { test, expect } from 'bun:test';
import {
  ndcFromClient,
  rayDirection,
  rayAABB,
  rayPlaneY,
  rayPlane,
  orthoBasis,
  angleOnAxis,
  closestAxisT,
  entityBox,
  type Vec3,
} from '../src/engine/viewport';

test('ndcFromClient maps pixels to [-1,1] with Y up', () => {
  expect(ndcFromClient(50, 50, 100, 100)).toEqual([0, 0]);
  expect(ndcFromClient(0, 0, 100, 100)).toEqual([-1, 1]);
  expect(ndcFromClient(100, 100, 100, 100)).toEqual([1, -1]);
});

test('rayDirection: center ray is forward; edge ray tilts by tan(fov/2)·aspect', () => {
  const fwd: Vec3 = [0, 0, -1], rgt: Vec3 = [1, 0, 0], up: Vec3 = [0, 1, 0];
  expect(rayDirection(fwd, rgt, up, 0, 0, Math.PI / 3, 1)).toEqual([0, 0, -1]);
  // ndcX=1, fov=90° → tan(45°)=1, aspect=1 → dir ∝ (1,0,-1) normalized
  const d = rayDirection(fwd, rgt, up, 1, 0, Math.PI / 2, 1);
  expect(d[0]).toBeCloseTo(Math.SQRT1_2, 5);
  expect(d[2]).toBeCloseTo(-Math.SQRT1_2, 5);
});

test('rayAABB: hit returns entry distance; miss returns null', () => {
  const o: Vec3 = [0, 0, 10];
  expect(rayAABB(o, [0, 0, -1], [0, 0, 0], [1, 1, 1])).toBeCloseTo(9, 6);
  expect(rayAABB(o, [0, 0, -1], [5, 0, 0], [1, 1, 1])).toBeNull(); // off to the side
  // ray pointing away from the box
  expect(rayAABB(o, [0, 0, 1], [0, 0, 0], [1, 1, 1])).toBeNull();
});

test('rayAABB picks the nearer of two boxes', () => {
  const o: Vec3 = [0, 0, 10], d: Vec3 = [0, 0, -1];
  const near = rayAABB(o, d, [0, 0, 2], [0.5, 0.5, 0.5]);
  const far = rayAABB(o, d, [0, 0, -5], [0.5, 0.5, 0.5]);
  expect(near).not.toBeNull();
  expect(far).not.toBeNull();
  expect(near! < far!).toBe(true);
});

test('rayPlaneY: intersects ground; parallel/away → null', () => {
  expect(rayPlaneY([0, 10, 0], [0, -1, 0], 0)).toEqual([0, 0, 0]);
  expect(rayPlaneY([2, 10, 3], [0, -1, 0], 0)).toEqual([2, 0, 3]);
  expect(rayPlaneY([0, 10, 0], [1, 0, 0], 0)).toBeNull();   // parallel
  expect(rayPlaneY([0, 10, 0], [0, 1, 0], 0)).toBeNull();   // pointing up, plane below
});

test('closestAxisT: parameter along an axis at the point nearest the ray', () => {
  // ray straight down at x=5 over the X axis through origin → nearest axis point x=5.
  expect(closestAxisT([5, 10, 0], [0, -1, 0], [0, 0, 0], [1, 0, 0])).toBeCloseTo(5, 6);
  // ray down at x=-3 → t=-3 along +X axis.
  expect(closestAxisT([-3, 10, 0], [0, -1, 0], [0, 0, 0], [1, 0, 0])).toBeCloseTo(-3, 6);
  // moving the axis origin shifts t by the same amount (relative motion).
  expect(closestAxisT([5, 10, 0], [0, -1, 0], [2, 0, 0], [1, 0, 0])).toBeCloseTo(3, 6);
});

test('rayPlane: hits an arbitrary plane; parallel → null', () => {
  // plane through origin, normal +X; ray down the -X axis from x=5 → hits origin.
  expect(rayPlane([5, 0, 0], [-1, 0, 0], [0, 0, 0], [1, 0, 0])).toEqual([0, 0, 0]);
  // ray parallel to the plane → null
  expect(rayPlane([5, 1, 0], [0, 0, -1], [0, 0, 0], [1, 0, 0])).toBeNull();
});

test('orthoBasis: returns two unit vectors orthogonal to the axis and each other', () => {
  for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vec3[]) {
    const [u, v] = orthoBasis(axis);
    const d = (p: Vec3, q: Vec3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
    expect(d(u, axis)).toBeCloseTo(0, 6);
    expect(d(v, axis)).toBeCloseTo(0, 6);
    expect(d(u, v)).toBeCloseTo(0, 6);
    expect(Math.hypot(u[0], u[1], u[2])).toBeCloseTo(1, 6);
  }
});

test('angleOnAxis: rotation about Y advances the in-plane angle', () => {
  const center: Vec3 = [0, 0, 0], axis: Vec3 = [0, 1, 0];
  // two cursor rays hitting the y=0 plane at different points → different angles.
  const a1 = angleOnAxis([3, 10, 0], [0, -1, 0], center, axis);
  const a2 = angleOnAxis([0, 10, 3], [0, -1, 0], center, axis);
  expect(a1).not.toBeNull();
  expect(a2).not.toBeNull();
  expect(Math.abs((a2 as number) - (a1 as number))).toBeGreaterThan(0.1); // moved around the ring
  // ray parallel to the rotation plane → null (caller skips)
  expect(angleOnAxis([3, 0, 0], [1, 0, 0], center, axis)).toBeNull();
});

test('entityBox: center from position, half from scale, thin slabs padded', () => {
  const b = entityBox({ x: 1, y: 2, z: 3, scaleX: 4, scaleY: 0.04, scaleZ: 6 });
  expect(b.center).toEqual([1, 2, 3]);
  expect(b.half[0]).toBeCloseTo(2, 6);
  expect(b.half[1]).toBeCloseTo(0.05, 6); // padded up from 0.02
  expect(b.half[2]).toBeCloseTo(3, 6);
  // missing scale defaults to unit cube
  expect(entityBox({ x: 0, y: 0, z: 0 }).half).toEqual([0.5, 0.5, 0.5]);
});
