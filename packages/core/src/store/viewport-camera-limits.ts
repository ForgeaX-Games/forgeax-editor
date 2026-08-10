// viewport-camera-limits — editor-camera view constants + clamps (SSOT).
//
// Extracted from edit-runtime's viewport-camera.ts so that BOTH the camera
// math (edit-runtime, engine-adjacent) and the viewport-preferences store
// (core, session state next to gizmo-pivot) share one definition — core cannot
// import edit-runtime (DAG), so the numbers live here. viewport-camera.ts
// re-exports everything for its existing importers.

export type CameraProjection = 'perspective' | 'orthographic';

/** UE-style viewport view identity. The six axis names are orthographic
 *  presets; 'perspective' is the perspective camera; 'orthographic' labels a
 *  free (non-axis-aligned) orthographic camera and is derive-only — it is not
 *  a settable cameraSetView preset. */
export type ViewportView =
  | CameraProjection
  | 'top' | 'bottom' | 'left' | 'right' | 'front' | 'back';

/** 飞行速度常量（单位/秒）。 */
export const FLY_SPEED_DEFAULT = 8;
export const FLY_SPEED_MIN = 0.5;
export const FLY_SPEED_MAX = 100;
/** Shift-held temporary flight multiplier. */
export const FLY_BOOST_MULTIPLIER = 2;

/** Perspective / orthographic editor-camera defaults and bounds. */
export const FOV_DEFAULT = Math.PI / 3;
export const FOV_MIN = (20 * Math.PI) / 180;
export const FOV_MAX = (120 * Math.PI) / 180;
export const ORTHO_HALF_HEIGHT_DEFAULT = 10;
export const ORTHO_HALF_HEIGHT_MIN = 0.1;
export const ORTHO_HALF_HEIGHT_MAX = 10000;

const PITCH_MIN = -1.5;  // ~-86 degrees
const PITCH_MAX = 1.5;   // ~+86 degrees
const DIST_MIN = 2;
const DIST_MAX = 300;

/** Clamp pitch to the allowed range for orbit camera (prevents gimbal lock). */
export function clampPitch(pitch: number): number {
  if (pitch > PITCH_MAX) return PITCH_MAX;
  if (pitch < PITCH_MIN) return PITCH_MIN;
  return pitch;
}

/** Clamp distance to the allowed range for orbit camera. */
export function clampDist(dist: number): number {
  if (dist > DIST_MAX) return DIST_MAX;
  if (dist < DIST_MIN) return DIST_MIN;
  return dist;
}

/** Clamp perspective FOV and reject non-finite inputs at the math boundary. */
export function clampFov(fov: number): number {
  if (!Number.isFinite(fov)) return FOV_DEFAULT;
  if (fov > FOV_MAX) return FOV_MAX;
  if (fov < FOV_MIN) return FOV_MIN;
  return fov;
}

/** Clamp orthographic half-height and reject non-finite inputs. */
export function clampOrthoHalfHeight(halfHeight: number): number {
  if (!Number.isFinite(halfHeight)) return ORTHO_HALF_HEIGHT_DEFAULT;
  if (halfHeight > ORTHO_HALF_HEIGHT_MAX) return ORTHO_HALF_HEIGHT_MAX;
  if (halfHeight < ORTHO_HALF_HEIGHT_MIN) return ORTHO_HALF_HEIGHT_MIN;
  return halfHeight;
}

/** 将飞行速度限制在 [FLY_SPEED_MIN, FLY_SPEED_MAX] 内。 */
export function clampFlySpeed(speed: number): number {
  if (speed > FLY_SPEED_MAX) return FLY_SPEED_MAX;
  if (speed < FLY_SPEED_MIN) return FLY_SPEED_MIN;
  return speed;
}
