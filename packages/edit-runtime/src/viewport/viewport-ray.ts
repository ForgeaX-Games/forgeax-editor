// viewport-ray.ts — pure geometry functions factored out of viewport.ts.
// @forgeax/editor-edit-runtime — 8 ray/AABB/plane utilities + entityBox (AC-01 / plan-strategy D-5).
//
// These are pure functions: no DOM, no engine-runtime types, no side effects.
// They were extracted from viewport.ts (was 976 lines) to keep the DI factory
// (createViewport) focused on wiring while testable geometry lives here.
// The original 17 exports from ./viewport stay reachable through the
// re-export barrel in viewport.ts — viewport.test.ts needs zero changes.

import type { Vec3 as EngineVec3 } from '@forgeax/engine-math';
import { ray, vec3 } from '@forgeax/engine-math';

// ── types ────────────────────────────────────────────────────────────────────

export type Vec3 = [number, number, number];

// Box3Like is derived from the engine's rayAabbIntersects signature so this
// stays SSOT-tied to the engine (no divergent local copy).
type Box3Like = Parameters<typeof ray.rayAabbIntersects>[1];

// ── shared buffers ───────────────────────────────────────────────────────────

// Reusable Float32Array buffer for engine vec3 operations (tuple<->typed-array bridge).
// Single buffer is safe here: normalize/cross are called sequentially in the pure
// geometry section, never concurrently. vec3.dot needs no buffer (returns scalar).
const _v3 = new Float32Array(3) as EngineVec3;

/** Safe numeric fallback: return `v` if finite number, else `d`. */
export const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ── pure geometry (exported for tests) ───────────────────────────────────────

/** Pixel position -> normalized device coords in [-1,1], Y up. */
export function ndcFromClient(x: number, y: number, w: number, h: number): [number, number] {
  return [(x / w) * 2 - 1, 1 - (y / h) * 2];
}

/** Ray direction through an NDC point given the camera basis + vertical FOV. */
export function rayDirection(
  forward: Vec3, right: Vec3, up: Vec3,
  ndcX: number, ndcY: number, fovY: number, aspect: number,
): Vec3 {
  const t = Math.tan(fovY / 2);
  vec3.normalize(_v3, [
    forward[0] + right[0] * ndcX * t * aspect + up[0] * ndcY * t,
    forward[1] + right[1] * ndcX * t * aspect + up[1] * ndcY * t,
    forward[2] + right[2] * ndcX * t * aspect + up[2] * ndcY * t,
  ]);
  return [_v3[0]!, _v3[1]!, _v3[2]!];
}

/** Ray vs axis-aligned box (center + half-extents). Returns entry distance or null.
 *  Thin adapter over engine rayAabbIntersects — center+half -> Box3Like. */
export function rayAABB(origin: Vec3, dir: Vec3, center: Vec3, half: Vec3): number | null {
  const boxMin = new Float32Array(3) as EngineVec3;
  const boxMax = new Float32Array(3) as EngineVec3;
  vec3.sub(boxMin, center, half);
  vec3.add(boxMax, center, half);
  const box3Like: Box3Like = [
    boxMin[0]!, boxMin[1]!, boxMin[2]!,
    boxMax[0]!, boxMax[1]!, boxMax[2]!,
  ];

  const rayLike = new Float32Array(6);
  rayLike[0] = origin[0]; rayLike[1] = origin[1]; rayLike[2] = origin[2];
  rayLike[3] = dir[0];    rayLike[4] = dir[1];    rayLike[5] = dir[2];

  const r = ray.rayAabbIntersects(rayLike, box3Like);
  return r.hit ? r.tmin : null;
}

/** Ray vs horizontal plane y = planeY. Returns the world hit point or null. */
export function rayPlaneY(origin: Vec3, dir: Vec3, planeY: number): Vec3 | null {
  if (Math.abs(dir[1]) < 1e-9) return null;
  const t = (planeY - origin[1]) / dir[1];
  if (t < 0) return null;
  return [origin[0] + dir[0] * t, planeY, origin[2] + dir[2] * t];
}

/** Parameter `t` along an axis line (axisO + t*axisU) at the point closest to the
 *  cursor ray. Used by the move gizmo to constrain a drag to one axis. */
export function closestAxisT(rayO: Vec3, rayD: Vec3, axisO: Vec3, axisU: Vec3): number {
  const w0: Vec3 = [rayO[0] - axisO[0], rayO[1] - axisO[1], rayO[2] - axisO[2]];
  const a = vec3.dot(rayD, rayD), b = vec3.dot(rayD, axisU), c = vec3.dot(axisU, axisU);
  const d = vec3.dot(rayD, w0), e = vec3.dot(axisU, w0);
  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-9) return -e / (c || 1); // ray parallel to axis -> project origin
  return (a * e - b * d) / denom;
}

/** Ray vs an arbitrary plane (point + normal). Returns the hit point or null. */
export function rayPlane(origin: Vec3, dir: Vec3, point: Vec3, normal: Vec3): Vec3 | null {
  const denom = vec3.dot(dir, normal);
  if (Math.abs(denom) < 1e-9) return null;
  const t = vec3.dot([point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]], normal) / denom;
  if (t < 0) return null;
  return [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
}

/** Two orthonormal vectors spanning the plane perpendicular to `axis`. */
export function orthoBasis(axis: Vec3): [Vec3, Vec3] {
  vec3.normalize(_v3, axis);
  const a: Vec3 = [_v3[0]!, _v3[1]!, _v3[2]!];
  const ref: Vec3 = Math.abs(a[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  vec3.cross(_v3, ref, a); vec3.normalize(_v3, _v3);
  const u: Vec3 = [_v3[0]!, _v3[1]!, _v3[2]!];
  vec3.cross(_v3, a, u);
  return [u, [_v3[0]!, _v3[1]!, _v3[2]!]];
}

/** Signed angle (radians) of the cursor ray's hit on the plane perpendicular to `axis`
 *  through `center`, measured in that plane. null if the ray is parallel to the plane. */
export function angleOnAxis(rayO: Vec3, rayD: Vec3, center: Vec3, axis: Vec3): number | null {
  const hit = rayPlane(rayO, rayD, center, axis);
  if (!hit) return null;
  const [u, v] = orthoBasis(axis);
  const d: Vec3 = [hit[0] - center[0], hit[1] - center[1], hit[2] - center[2]];
  return Math.atan2(vec3.dot(d, v), vec3.dot(d, u));
}

/** A doc entity's world AABB (center + half) from its Transform. */
export function entityBox(t: { x?: number; y?: number; z?: number; scaleX?: number; scaleY?: number; scaleZ?: number }): { center: Vec3; half: Vec3 } {
  const sx = Math.abs(num(t.scaleX, 1)), sy = Math.abs(num(t.scaleY, 1)), sz = Math.abs(num(t.scaleZ, 1));
  // pad razor-thin slabs (neon strips, floor) so they stay clickable.
  const pad = 0.05;
  return {
    center: [num(t.x, 0), num(t.y, 0), num(t.z, 0)],
    half: [Math.max(sx / 2, pad), Math.max(sy / 2, pad), Math.max(sz / 2, pad)],
  };
}