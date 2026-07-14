// viewport-camera.ts — orbit camera pure functions extracted from viewport.ts.
// @forgeax/editor-edit-runtime — deriveInputTarget + orbit advance (AC-01/AC-03 / plan-strategy D-5/D-8).
//
// These are pure functions: no DOM, no engine-runtime types, no side effects.
// The functions take explicit state (yaw/pitch/dist/target) and return new state
// or computed camera pose — the caller (createViewport factory) is responsible for
// writing the result to the engine World.
//
// Narrow Deps interface (D-8, Pipeline Isolation): follow run-lifecycle.ts paradigm —
// functions import only @forgeax/engine-math for quat/vec3, never engine-runtime or
// HTMLCanvasElement types. This keeps AC-03 unit tests dependency-free (no DOM/GPU).
//
// Camera math reuses fps's PROVEN engine convention: qCam = yaw·[0,1,0] x pitch·
// [1,0,0]; forward = qCam·[0,0,-1].

import { quat, vec3 } from '@forgeax/engine-math';
import type { Vec3 as EngineVec3 } from '@forgeax/engine-math';

import type { Vec3 } from './viewport-ray';

/** Quaternion [x, y, z, w] — the engine-native representation. */
export type Quat = [number, number, number, number];

// ── types ────────────────────────────────────────────────────────────────────

export type RunMode = 'edit' | 'play';
export type DisplayMode = 'scene' | 'game';
export type InputTarget = 'editor' | 'game';
export type ControlOwner = InputTarget;

/** Result of orbit camera pose computation — camera position + basis vectors + camera quaternion. */
export interface OrbitCameraResult {
  camPos: Vec3;
  fwd: Vec3;
  rgt: Vec3;
  upv: Vec3;
  /** Camera orientation quaternion [x, y, z, w] — ready for Transform.quat. */
  qCam: Quat;
}

/** Orbit state — the three scalar accumulators of user input. */
export interface OrbitState {
  yaw: number;
  pitch: number;
  dist: number;
}

// ── clamp constants (from viewport.ts orbit handlers) ────────────────────────

const PITCH_MIN = -1.5;  // ~-86 degrees
const PITCH_MAX = 1.5;   // ~+86 degrees
const DIST_MIN = 2;
const DIST_MAX = 300;

// ── shared buffer ────────────────────────────────────────────────────────────

const _tmpV3 = new Float32Array(3) as EngineVec3;

// ── pure functions ───────────────────────────────────────────────────────────

/**
 * Input ownership is derived from the simulation lifecycle plus an explicit
 * control lease. Display remains a camera/chrome concern: watching a game must
 * not silently grant it the keyboard.
 */
export function deriveInputTarget(run: RunMode, control: ControlOwner): InputTarget {
  return run === 'play' && control === 'game' ? 'game' : 'editor';
}

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

/** Advance orbit state with user input deltas, clamping pitch and distance.
 *  Returns the new yaw/pitch/dist — yaw is unbounded (full rotation allowed).
 *  deltaDist > 0 zooms in (reduces dist); deltaDist < 0 zooms out. */
export function advanceOrbit(
  yaw: number, pitch: number, dist: number,
  deltaYaw: number, deltaPitch: number, deltaDist: number,
): OrbitState {
  const newPitch = clampPitch(pitch + deltaPitch);
  const newDist = clampDist(dist - deltaDist);
  return { yaw: yaw + deltaYaw, pitch: newPitch, dist: newDist };
}

/** Compute camera position and basis vectors from orbit parameters.
 *  Uses the proven engine convention: qCam = yaw·[0,1,0] x pitch·[1,0,0];
 *  forward = qCam·[0,0,-1]; camPos = target - forward * dist. */
export function computeOrbitCamera(
  target: Vec3, yaw: number, pitch: number, dist: number,
): OrbitCameraResult {
  const qY = quat.create();
  const qP = quat.create();
  const qCam = quat.create();

  quat.fromAxisAngle(qY, [0, 1, 0], yaw);
  quat.fromAxisAngle(qP, [1, 0, 0], pitch);
  quat.multiply(qCam, qY, qP);

  const tv = (src: Vec3): Vec3 => {
    quat.transformVec3(_tmpV3, qCam, src as unknown as EngineVec3);
    return [_tmpV3[0]!, _tmpV3[1]!, _tmpV3[2]!];
  };

  const fwd = tv([0, 0, -1]);
  const rgt = tv([1, 0, 0]);
  const upv = tv([0, 1, 0]);

  const camPos: Vec3 = [
    target[0] - fwd[0] * dist,
    target[1] - fwd[1] * dist,
    target[2] - fwd[2] * dist,
  ];

  return { camPos, fwd, rgt, upv, qCam: [qCam[0]!, qCam[1]!, qCam[2]!, qCam[3]!] };
}