// viewport-gizmo-geometry.ts — pure gizmo + parameter-gizmo geometry factored out
// of viewport.ts (M6 / AC-08 / plan-strategy §2 D-5).
//
// WHAT THIS IS
//   The createViewport factory in viewport.ts had grown to ~1010 lines because the
//   pure geometry that BUILDS the gizmo/param-gizmo point sets lived inline in the
//   closure next to the engine-writing wiring. This file lifts that geometry out:
//   the axis/plane/ring layout constants, the cone-mesh vertex builder, and the
//   dotted-wireframe point generators for Light range/spot cones and Camera frusta.
//   viewport.ts now imports these and stays focused on the engine wiring + the
//   pointer/gizmo interaction state machine.
//
// WHY PURE (same discipline as viewport-ray.ts / viewport-camera.ts, D-8)
//   Every function here is pure: it takes explicit numbers/tuples and returns
//   Vec3 point arrays or typed-array mesh data — no DOM, no engine World, no
//   EngineFacade, no closure state. The caller (createViewport) owns the engine
//   writes (engine.set / spawn / allocSharedRef); this file only computes WHERE
//   things go. That keeps the reader's concept count down and lets the geometry be
//   reasoned about in isolation. Imports are limited to @forgeax/engine-math (quat/
//   vec3) + the sibling pure module viewport-ray (Vec3/num/orthoBasis).
//
// OOS-1 / OOS-3 (zero behavior change, no semantic rewrite)
//   Every body below is the VERBATIM math previously inline in viewport.ts
//   (ensureCone vertex loop, addSeg/circlePts/forwardOf, and the light/camera
//   branches of updateParamGizmo). Only the surrounding orchestration (getSelection,
//   entComponents, isAuxVisible, placeDots) stays in viewport.ts. This is a pure
//   MOVE, not a rewrite — the sister loop world-partition rewrites the camera-pose
//   WRITE path (viewport.ts:167) and the pick path, neither of which lives here, so
//   this extraction adds no conflict surface to the controlled intersection (AC-10).
//
// Anchors:
//   (forward) plan-strategy feat-20260709-editor-large-file-di-decompose-wave2-c-domain-scen
//     plan-id; AC-05 (zero behavior) + AC-08 (edit-runtime max_file_loc drop from
//     viewport.ts 1010) + AC-07 (bidirectional anchors) + AC-10 (viewport three-file
//     controlled intersection — extracted off the world-partition hotspots) + OOS-3
//     (no viewport semantic rewrite); plan-strategy §2 D-5 (M6 tail) + §8 naming.
//   (backward) this geometry was factored into viewport.ts during the
//     `refactor: rename engine/ to viewport/` history feat (#76); the gizmo/param-
//     gizmo design (axis bars/rings, light/camera wireframes) shipped with the
//     viewport's original interaction landing.

import { quat, vec3 } from '@forgeax/engine-math';
import type { Vec3 as EngineVec3 } from '@forgeax/engine-math';

import { type Vec3, num, orthoBasis } from './viewport-ray';

// ── shared constants ──────────────────────────────────────────────────────────

/** Degrees -> radians (euler fields on the editor Transform are degrees). */
export const DEG2RAD = Math.PI / 180;

/** The three world axes with their gizmo tint colors (X red / Y green / Z blue). */
export const AXES: { axis: Vec3; color: [number, number, number] }[] = [
  { axis: [1, 0, 0], color: [1.0, 0.25, 0.2] },  // X red
  { axis: [0, 1, 0], color: [0.3, 1.0, 0.35] },  // Y green
  { axis: [0, 0, 1], color: [0.3, 0.55, 1.0] },  // Z blue
];

/** Plane handle descriptor: ax/ay index into x/y/z; `normal` is the third axis
 *  (the plane's normal, for ray∩plane drag); `mat` selects the tint material. */
export type PlaneHandle = { ax: number; ay: number; normal: Vec3; mat: number };

/** Plane handles (translate only): drag two axes at once. */
export const PLANES: PlaneHandle[] = [
  { ax: 0, ay: 1, normal: [0, 0, 1], mat: 2 }, // XY plane (Z-normal, blue tint)
  { ax: 1, ay: 2, normal: [1, 0, 0], mat: 0 }, // YZ plane (X-normal, red tint)
  { ax: 0, ay: 2, normal: [0, 1, 0], mat: 1 }, // XZ plane (Y-normal, green tint)
];

/** Cube segments per rotation ring. */
export const RING_SEG = 24;

/** Quaternion that rotates the cone's local +Y to point down each world axis. */
export const TIP_QUAT: [number, number, number, number][] = [
  [0, 0, -0.70710678, 0.70710678], // X: +Y → +X
  [0, 0, 0, 1],                     // Y: identity
  [0.70710678, 0, 0, 0.70710678],   // Z: +Y → +Z
];

// ── shared scratch buffer (pure geometry only, called sequentially) ────────────
const _gv3 = new Float32Array(3) as EngineVec3;

// ── pure mesh + point builders ────────────────────────────────────────────────

/** Cone mesh data (apex at +Y, base ring at Y=0, closed) for the translate
 *  arrowheads. Unlit material ignores normals/uv, so those are dummy. Interleaved
 *  layout is [px,py,pz, nx,ny,nz, u,v]. Caller wraps it via meshFromInterleaved. */
export function buildConeMeshData(): { vertices: Float32Array; indices: Uint16Array } {
  const SEG = 16;
  const v: number[] = [];
  const push = (x: number, y: number, z: number): void => { v.push(x, y, z, 0, 1, 0, 0, 0); };
  push(0, 1, 0);  // 0: apex
  push(0, 0, 0);  // 1: base center
  for (let i = 0; i < SEG; i++) { const t = (i / SEG) * Math.PI * 2; push(Math.cos(t), 0, Math.sin(t)); }
  const idx: number[] = [];
  for (let i = 0; i < SEG; i++) {
    const a = 2 + i, b = 2 + ((i + 1) % SEG);
    idx.push(0, a, b);  // side face
    idx.push(1, b, a);  // base cap
  }
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}

/** Append `n`+1 evenly-spaced points along the segment a→b into `out`. */
export const addSeg = (out: Vec3[], a: Vec3, b: Vec3, n = 10): void => {
  for (let i = 0; i <= n; i++) { const k = i / n; out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]); }
};

/** `n` points around a circle of radius `r` centered at `center` in the plane
 *  spanned by orthonormal u/v. */
export const circlePts = (center: Vec3, u: Vec3, v: Vec3, r: number, n = 40): Vec3[] => {
  const o: Vec3[] = [];
  for (let j = 0; j < n; j++) { const th = (j / n) * Math.PI * 2, c = Math.cos(th) * r, s = Math.sin(th) * r; o.push([center[0] + u[0] * c + v[0] * s, center[1] + u[1] * c + v[1] * s, center[2] + u[2] * c + v[2] * s]); }
  return o;
};

/** Forward vector (local -Z) of an editor Transform's euler rotation (XYZ order). */
export function forwardOf(t?: Record<string, number>): Vec3 {
  const q = quat.create();
  quat.fromEuler(q, num(t?.rotX, 0) * DEG2RAD, num(t?.rotY, 0) * DEG2RAD, num(t?.rotZ, 0) * DEG2RAD, 'XYZ');
  const o = new Float32Array(3) as EngineVec3; quat.transformVec3(o, q, [0, 0, -1] as unknown as EngineVec3);
  return [o[0]!, o[1]!, o[2]!];
}

/** Dotted-wireframe points visualizing a selected Light's range/spot cone.
 *  directional → arrow; spot → base circle + 4 cone edges; point → 3 axis rings.
 *  `t` supplies the euler rotation for the spot direction; `dist` scales the arrow. */
export function lightGizmoPoints(
  light: Record<string, unknown>, center: Vec3, t: Record<string, number> | undefined, dist: number,
): Vec3[] {
  const pts: Vec3[] = [];
  const type = (light.type as string) ?? 'point';
  if (type === 'directional') {
    const d = (light.direction as number[] | undefined) ?? [];
    vec3.normalize(_gv3, [num(d[0], -0.4), num(d[1], -1), num(d[2], -0.3)]);
    const dir: Vec3 = [_gv3[0]!, _gv3[1]!, _gv3[2]!];
    const len = Math.max(2, dist * 0.18);
    const tip: Vec3 = [center[0] + dir[0] * len, center[1] + dir[1] * len, center[2] + dir[2] * len];
    addSeg(pts, center, tip, 16);
    const [u, v] = orthoBasis(dir);
    const back = len * 0.18;
    for (const s of [u, v, [-u[0], -u[1], -u[2]] as Vec3, [-v[0], -v[1], -v[2]] as Vec3]) {
      addSeg(pts, tip, [tip[0] - dir[0] * back + s[0] * back, tip[1] - dir[1] * back + s[1] * back, tip[2] - dir[2] * back + s[2] * back], 5);
    }
  } else if (type === 'spot') {
    const range = num(light.range as number, 0) || 6;
    const half = num(light.spotAngle as number, 30) * DEG2RAD;
    const fwd = forwardOf(t);
    const [u, v] = orthoBasis(fwd);
    const baseC: Vec3 = [center[0] + fwd[0] * range, center[1] + fwd[1] * range, center[2] + fwd[2] * range];
    const br = Math.tan(half) * range;
    pts.push(...circlePts(baseC, u, v, br, 36));
    for (let j = 0; j < 4; j++) { const th = (j / 4) * Math.PI * 2, c = Math.cos(th) * br, s = Math.sin(th) * br; addSeg(pts, center, [baseC[0] + u[0] * c + v[0] * s, baseC[1] + u[1] * c + v[1] * s, baseC[2] + u[2] * c + v[2] * s], 10); }
  } else { // point (or unknown) → range sphere = 3 axis rings
    const range = num(light.range as number, 0) || 3;
    for (const a of AXES) { const [u, v] = orthoBasis(a.axis); pts.push(...circlePts(center, u, v, range, 36)); }
  }
  return pts;
}

/** Dotted-wireframe points visualizing a selected Camera's frustum (near+far
 *  rectangles + connecting edges). `far` is clamped so it stays on-screen; `aspect`
 *  is the viewport aspect ratio (0 falls back to 1). */
export function cameraGizmoPoints(
  cam: Record<string, unknown>, center: Vec3, t: Record<string, number> | undefined, dist: number, aspect: number,
): Vec3[] {
  const pts: Vec3[] = [];
  const fov = num(cam.fov as number, 60) * DEG2RAD;
  const near = num(cam.near as number, 0.1);
  const far = Math.min(num(cam.far as number, 1000), dist * 4 + 30); // clamp so it stays on-screen
  const fwd = forwardOf(t);
  const [right, up] = orthoBasis(fwd);
  const rect = (depth: number): Vec3[] => {
    const hh = Math.tan(fov / 2) * depth, hw = hh * (aspect || 1);
    const cC: Vec3 = [center[0] + fwd[0] * depth, center[1] + fwd[1] * depth, center[2] + fwd[2] * depth];
    const corner = (sx: number, sy: number): Vec3 => [cC[0] + right[0] * hw * sx + up[0] * hh * sy, cC[1] + right[1] * hw * sx + up[1] * hh * sy, cC[2] + right[2] * hw * sx + up[2] * hh * sy];
    return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  };
  const n4 = rect(near), f4 = rect(far);
  for (let i = 0; i < 4; i++) { addSeg(pts, n4[i]!, n4[(i + 1) % 4]!, 6); addSeg(pts, f4[i]!, f4[(i + 1) % 4]!, 8); addSeg(pts, n4[i]!, f4[i]!, 10); }
  return pts;
}
