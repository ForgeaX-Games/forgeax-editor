// viewport-camera.ts — orbit + fly camera pure functions extracted from viewport.ts.
// @forgeax/editor-edit-runtime — deriveInputTarget + orbit advance + fly advance
// (AC-01/AC-03 / plan-strategy D-5/D-8).
//
// These are pure functions: no DOM, no engine-runtime types, no side effects.
// The functions take explicit state (yaw/pitch/dist/target for orbit;
// pos/yaw/pitch for fly) and return new state or computed camera pose — the caller
// (createViewport factory) is responsible for writing the result to the engine World.
//
// Narrow Deps interface (D-8, Pipeline Isolation): follow run-lifecycle.ts paradigm —
// functions import only @forgeax/engine-math for quat/vec3, never engine-runtime or
// HTMLCanvasElement types. This keeps AC-03 unit tests dependency-free (no DOM/GPU).
//
// Camera math reuses fps's PROVEN engine convention: qCam = yaw·[0,1,0] x pitch·
// [1,0,0]; forward = qCam·[0,0,-1].

import { quat, vec3 } from '@forgeax/engine-math';
import type { Vec3 as EngineVec3 } from '@forgeax/engine-math';
// Camera view limits (FOV / fly-speed / ortho bounds + clamps) live in
// @forgeax/editor-core (store/viewport-camera-limits.ts): core hosts the
// viewport-preferences session store and cannot import this package (DAG), so
// the SSOT moved there. This module re-exports the full set so existing
// importers keep working unchanged.
import {
  clampDist, clampFov, clampFlySpeed, clampOrthoHalfHeight, clampPitch,
  FLY_BOOST_MULTIPLIER, ORTHO_HALF_HEIGHT_MIN,
  type CameraProjection,
} from '@forgeax/editor-core';
export {
  clampDist, clampFov, clampFlySpeed, clampOrthoHalfHeight, clampPitch,
  FLY_BOOST_MULTIPLIER, FLY_SPEED_DEFAULT, FLY_SPEED_MAX, FLY_SPEED_MIN,
  FOV_DEFAULT, FOV_MAX, FOV_MIN,
  ORTHO_HALF_HEIGHT_DEFAULT, ORTHO_HALF_HEIGHT_MAX, ORTHO_HALF_HEIGHT_MIN,
  type CameraProjection,
} from '@forgeax/editor-core';

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

// ── fly camera types & constants ─────────────────────────────────────────────

/** WASD/QE 飞行输入的键态快照（纯数据，无 DOM 依赖）。 */
export interface FlyInput {
  forward: boolean;   // W
  backward: boolean;  // S
  left: boolean;      // A
  right: boolean;     // D
  up: boolean;        // E
  down: boolean;      // Q
  /** Temporary UE-style speed boost while Shift is held. */
  boost?: boolean;
}

/** 飞行相机状态 — 绝对位姿（笛卡尔坐标，非球坐标）。 */
export interface FlyState {
  pos: Vec3;
  yaw: number;
  pitch: number;
}

/** 滚轮每格速度倍率（UE5 标准）。 */
export const FLY_SPEED_STEP = 1.15;

export const FOV_STEP = (5 * Math.PI) / 180;
export const ORTHO_ZOOM_STEP = 1.1;

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

/**
 * Apply a signed view-zoom step. Positive delta means zoom in, matching wheel
 * up and the Z shortcut; negative delta means zoom out.
 */
export function adjustFov(fov: number, delta: number): number {
  return clampFov(clampFov(fov) - delta * FOV_STEP);
}

export function adjustOrthoHalfHeight(halfHeight: number, delta: number): number {
  const current = clampOrthoHalfHeight(halfHeight);
  return clampOrthoHalfHeight(current * Math.pow(ORTHO_ZOOM_STEP, -delta));
}

/** Keep the first orthographic view visually close to the perspective framing. */
export function deriveOrthoHalfHeight(dist: number, fov: number): number {
  return clampOrthoHalfHeight(Math.max(ORTHO_HALF_HEIGHT_MIN, dist * Math.tan(clampFov(fov) / 2)));
}

/** Minimum view scale so a gizmo sitting exactly on the camera still gets a
 *  non-degenerate size (and never NaN/Infinity downstream). */
export const GIZMO_VIEW_SCALE_MIN = 1e-3;

/** World-units scale factor for editor gizmos so they keep a constant on-screen
 *  size (UE parity — gizmo-ue-parity plan §4.2).
 *  - perspective: the camera→anchor distance. The gizmo reads the LIVE camera
 *    position every update, so fly roaming no longer freezes the size on a
 *    stale orbit `dist` (previous bug: size jumped at fly end).
 *  - orthographic: distance is meaningless (parallel projection), so convert
 *    the ortho half-height back to the perspective distance that would frame
 *    the same height — the inverse of deriveOrthoHalfHeight. Zooming an ortho
 *    view now keeps the gizmo at a constant screen size too.
 *  Non-finite inputs fall back to a safe default instead of poisoning gizmo math. */
export function gizmoViewScale(
  projection: CameraProjection,
  camPos: Vec3,
  anchor: Vec3,
  orthoHalfHeight: number,
  fov: number,
): number {
  if (projection === 'orthographic') {
    return clampOrthoHalfHeight(orthoHalfHeight) / Math.tan(clampFov(fov) / 2);
  }
  const d = Math.hypot(camPos[0] - anchor[0], camPos[1] - anchor[1], camPos[2] - anchor[2]);
  return Number.isFinite(d) && d > GIZMO_VIEW_SCALE_MIN ? d : GIZMO_VIEW_SCALE_MIN;
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

// ── fly camera pure functions ────────────────────────────────────────────────

/** 应用滚轮 delta 到飞行速度（UE5：滚轮上加速、滚轮下减速）。
 *  wheelDelta > 0 加速（每格 * FLY_SPEED_STEP），wheelDelta < 0 减速。 */
export function applyFlyWheelSpeed(speed: number, wheelDelta: number, stepScale = 1): number {
  if (wheelDelta === 0) return clampFlySpeed(speed);
  const scale = Number.isFinite(stepScale) ? Math.max(0, stepScale) : 1;
  const steps = (wheelDelta > 0 ? 1 : -1) * scale;
  const factor = Math.pow(FLY_SPEED_STEP, steps);
  return clampFlySpeed(speed * factor);
}

/**
 * Advance fly state with keyboard input over dt seconds.
 * - forward/backward: 沿相机 forward 轴移动
 * - left/right: 沿相机 right 轴移动
 * - up/down: 沿世界 up 轴移动（UE5 行为，Q=down/E=up）
 * yaw/pitch 由鼠标 delta 直接更新（不在此函数处理，由 advanceFlyLook 处理）。
 */
export function advanceFly(
  state: FlyState,
  input: FlyInput,
  speed: number,
  dt: number,
  boostMultiplier = FLY_BOOST_MULTIPLIER,
): FlyState {
  if (dt <= 0) return state;
  const boost = Number.isFinite(boostMultiplier)
    ? Math.max(1, boostMultiplier)
    : FLY_BOOST_MULTIPLIER;
  const step = speed * (input.boost ? boost : 1) * dt;

  // 计算基向量（复用 orbit 的 quat 逻辑，但只需 fwd/rgt，up 取世界 [0,1,0]）
  const qY = quat.create();
  const qP = quat.create();
  const qCam = quat.create();
  quat.fromAxisAngle(qY, [0, 1, 0], state.yaw);
  quat.fromAxisAngle(qP, [1, 0, 0], state.pitch);
  quat.multiply(qCam, qY, qP);

  const tv = (src: Vec3): Vec3 => {
    quat.transformVec3(_tmpV3, qCam, src as unknown as EngineVec3);
    return [_tmpV3[0]!, _tmpV3[1]!, _tmpV3[2]!];
  };

  const fwd = tv([0, 0, -1]);
  const rgt = tv([1, 0, 0]);
  // 世界 up，不受相机 pitch 影响 —— UE5 惯例
  const worldUp: Vec3 = [0, 1, 0];

  let dx = 0, dy = 0, dz = 0;
  if (input.forward)  { dx += fwd[0]; dy += fwd[1]; dz += fwd[2]; }
  if (input.backward) { dx -= fwd[0]; dy -= fwd[1]; dz -= fwd[2]; }
  if (input.right)    { dx += rgt[0]; dy += rgt[1]; dz += rgt[2]; }
  if (input.left)     { dx -= rgt[0]; dy -= rgt[1]; dz -= rgt[2]; }
  if (input.up)       { dx += worldUp[0]; dy += worldUp[1]; dz += worldUp[2]; }
  if (input.down)     { dx -= worldUp[0]; dy -= worldUp[1]; dz -= worldUp[2]; }

  // 归一化方向向量（防止斜向移动加速）
  const len = Math.hypot(dx, dy, dz);
  if (len > 1e-6) {
    const inv = step / len;
    dx *= inv; dy *= inv; dz *= inv;
  } else {
    dx = 0; dy = 0; dz = 0;
  }

  return {
    pos: [state.pos[0] + dx, state.pos[1] + dy, state.pos[2] + dz],
    yaw: state.yaw,
    pitch: state.pitch,
  };
}

/**
 * Advance fly look direction with mouse delta (右键拖拽视角旋转).
 * pitch 会被 clamp 到与 orbit 相同的范围。
 */
export function advanceFlyLook(
  state: FlyState,
  deltaYaw: number,
  deltaPitch: number,
): FlyState {
  return {
    pos: state.pos,
    yaw: state.yaw + deltaYaw,
    pitch: clampPitch(state.pitch + deltaPitch),
  };
}

/** Compute camera position and basis for fly mode. camPos = state.pos (直接使用). */
export function computeFlyCamera(state: FlyState): OrbitCameraResult {
  const qY = quat.create();
  const qP = quat.create();
  const qCam = quat.create();
  quat.fromAxisAngle(qY, [0, 1, 0], state.yaw);
  quat.fromAxisAngle(qP, [1, 0, 0], state.pitch);
  quat.multiply(qCam, qY, qP);

  const tv = (src: Vec3): Vec3 => {
    quat.transformVec3(_tmpV3, qCam, src as unknown as EngineVec3);
    return [_tmpV3[0]!, _tmpV3[1]!, _tmpV3[2]!];
  };

  const fwd = tv([0, 0, -1]);
  const rgt = tv([1, 0, 0]);
  const upv = tv([0, 1, 0]);

  return {
    camPos: [state.pos[0], state.pos[1], state.pos[2]],
    fwd, rgt, upv,
    qCam: [qCam[0]!, qCam[1]!, qCam[2]!, qCam[3]!],
  };
}

/**
 * 从 orbit 状态推导 fly 起始状态（进入 fly 模式时调用）：
 * - fly.pos = orbit 的相机位置 (target - fwd * dist)
 * - fly.yaw / fly.pitch = orbit 的 yaw / pitch（视角连续）
 */
export function orbitToFly(target: Vec3, yaw: number, pitch: number, dist: number): FlyState {
  const { camPos } = computeOrbitCamera(target, yaw, pitch, dist);
  return { pos: camPos, yaw, pitch };
}

/**
 * 从 fly 状态推导 orbit 目标点（退出 fly 模式时调用）：
 * - 保留 fly 的 yaw/pitch/dist（dist 使用传入的 previousDist，避免飞行时距离信息丢失）
 * - orbit.target = fly.pos + fwd * dist  （target 落在相机前方 dist 处）
 * 这样切换回 orbit 后，相机位置保持不变（camPos = target - fwd*dist = fly.pos）。
 */
export function flyToOrbit(fly: FlyState, previousDist: number): { target: Vec3; yaw: number; pitch: number; dist: number } {
  const dist = clampDist(previousDist);
  const { fwd } = computeFlyCamera(fly);
  const target: Vec3 = [
    fly.pos[0] + fwd[0] * dist,
    fly.pos[1] + fwd[1] * dist,
    fly.pos[2] + fwd[2] * dist,
  ];
  return { target, yaw: fly.yaw, pitch: fly.pitch, dist };
}
