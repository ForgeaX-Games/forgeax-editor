// Gizmo rotate drag: axis-angle delta composed onto the grab-start local quaternion.
// SSOT for inspector-transform-live-sync.md §8.4 — do not increment euler components.

import { quat, type Quat, type QuatLike } from '@forgeax/engine-math';
import type { Vec3 } from './viewport-ray';

/** Apply a gizmo ring drag: `out = normalize( axisAngle(axis, Δθ) * startQuat )`. */
export function composeGizmoRotationDelta(
  startQuat: QuatLike,
  axis: Vec3,
  deltaRadians: number,
  out: Quat = quat.create(),
): Quat {
  return quat.rotateAxis(out, startQuat, axis, deltaRadians);
}
