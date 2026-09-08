// gizmo-overlay-geometry — solid, frame-local geometry for editor chrome.
//
// The transform and parameter Gizmos are not authored scene entities. This
// module keeps their visual geometry as CPU-side triangles so the editor can
// submit them through its scene-after overlay RenderFeature without adding
// MeshFilter/MeshRenderer components to either world.

import { quat } from '@forgeax/engine-math';
import { srgbChannelToLinear } from '@forgeax/engine-types';

import type { Vec3 } from './viewport-ray';

export type GizmoOverlayColor = readonly [number, number, number, number];

/** Convert an authored editor tint to the linear HDR overlay color domain. */
export function overlayColorFromSrgb(
  color: readonly [number, number, number],
): [number, number, number, number] {
  return [
    srgbChannelToLinear(color[0]!),
    srgbChannelToLinear(color[1]!),
    srgbChannelToLinear(color[2]!),
    1,
  ];
}

export interface GizmoOverlayVertex {
  readonly position: Vec3;
  readonly color: GizmoOverlayColor;
}

type Quat = readonly [number, number, number, number];

const CUBE_CORNERS: readonly Vec3[] = [
  [-0.5, -0.5, -0.5],
  [0.5, -0.5, -0.5],
  [0.5, 0.5, -0.5],
  [-0.5, 0.5, -0.5],
  [-0.5, -0.5, 0.5],
  [0.5, -0.5, 0.5],
  [0.5, 0.5, 0.5],
  [-0.5, 0.5, 0.5],
];

// Winding is immaterial to the overlay (culling is disabled), but keeping
// complete faces makes this helper useful for both boxes and plane handles.
const CUBE_TRIANGLES: readonly [number, number, number][] = [
  [0, 2, 1], [0, 3, 2],
  [4, 5, 6], [4, 6, 7],
  [0, 1, 5], [0, 5, 4],
  [3, 7, 6], [3, 6, 2],
  [1, 2, 6], [1, 6, 5],
  [0, 4, 7], [0, 7, 3],
];

/** Quaternion that rotates a cone's local +Y to each world axis. */
export const TIP_QUAT: readonly Quat[] = [
  [0, 0, -0.70710678, 0.70710678], // X: +Y → +X
  [0, 0, 0, 1],                     // Y: +Y → +Y
  [0.70710678, 0, 0, 0.70710678],   // Z: +Y → +Z
];

function transformPoint(center: Vec3, scale: Vec3, rotation: Quat, local: Vec3): Vec3 {
  const scaled: Vec3 = [
    local[0] * scale[0],
    local[1] * scale[1],
    local[2] * scale[2],
  ];
  const rotated = new Float32Array(3) as Parameters<typeof quat.transformVec3>[0];
  quat.transformVec3(rotated, rotation, scaled as Parameters<typeof quat.transformVec3>[2]);
  return [
    center[0] + rotated[0]!,
    center[1] + rotated[1]!,
    center[2] + rotated[2]!,
  ];
}

function appendTriangle(
  out: GizmoOverlayVertex[],
  center: Vec3,
  scale: Vec3,
  rotation: Quat,
  color: GizmoOverlayColor,
  a: Vec3,
  b: Vec3,
  c: Vec3,
): void {
  out.push(
    { position: transformPoint(center, scale, rotation, a), color },
    { position: transformPoint(center, scale, rotation, b), color },
    { position: transformPoint(center, scale, rotation, c), color },
  );
}

/** Append a transformed unit cube as 12 filled triangles. */
export function appendOverlayBox(
  out: GizmoOverlayVertex[],
  center: Vec3,
  scale: Vec3,
  rotation: Quat,
  color: GizmoOverlayColor,
): void {
  for (const [a, b, c] of CUBE_TRIANGLES) {
    appendTriangle(
      out,
      center,
      scale,
      rotation,
      color,
      CUBE_CORNERS[a]!,
      CUBE_CORNERS[b]!,
      CUBE_CORNERS[c]!,
    );
  }
}

/**
 * Append a closed cone whose local apex is +Y and whose base is the unit
 * circle at Y=0. This matches the original translate-arrow mesh.
 */
export function appendOverlayCone(
  out: GizmoOverlayVertex[],
  center: Vec3,
  scale: Vec3,
  rotation: Quat,
  color: GizmoOverlayColor,
): void {
  const segments = 16;
  const apex: Vec3 = [0, 1, 0];
  const base: Vec3 = [0, 0, 0];
  const ring = (index: number): Vec3 => {
    const theta = (index / segments) * Math.PI * 2;
    return [Math.cos(theta), 0, Math.sin(theta)];
  };

  for (let index = 0; index < segments; index += 1) {
    const a = ring(index);
    const b = ring((index + 1) % segments);
    appendTriangle(out, center, scale, rotation, color, apex, a, b);
    appendTriangle(out, center, scale, rotation, color, base, b, a);
  }
}

/** Multiply two quaternions: out = a * b. */
export function multiplyOverlayQuaternions(a: Quat, b: Quat): [number, number, number, number] {
  const out = quat.create();
  quat.multiply(out, a, b);
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}
