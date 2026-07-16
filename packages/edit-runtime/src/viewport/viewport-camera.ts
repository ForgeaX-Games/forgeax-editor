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
}

/** 飞行相机状态 — 绝对位姿（笛卡尔坐标，非球坐标）。 */
export interface FlyState {
  pos: Vec3;
  yaw: number;
  pitch: number;
}

/** 飞行速度常量（单位/秒）。 */
export const FLY_SPEED_DEFAULT = 8;
export const FLY_SPEED_MIN = 0.5;
export const FLY_SPEED_MAX = 100;
/** 滚轮每格速度倍率（UE5 标准）。 */
export const FLY_SPEED_STEP = 1.15;

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

// ── fly camera pure functions ────────────────────────────────────────────────

/** 将飞行速度限制在 [FLY_SPEED_MIN, FLY_SPEED_MAX] 内。 */
export function clampFlySpeed(speed: number): number {
  if (speed > FLY_SPEED_MAX) return FLY_SPEED_MAX;
  if (speed < FLY_SPEED_MIN) return FLY_SPEED_MIN;
  return speed;
}

/** 应用滚轮 delta 到飞行速度（UE5：滚轮上加速、滚轮下减速）。
 *  wheelDelta > 0 加速（每格 * FLY_SPEED_STEP），wheelDelta < 0 减速。 */
export function applyFlyWheelSpeed(speed: number, wheelDelta: number): number {
  if (wheelDelta === 0) return clampFlySpeed(speed);
  const steps = wheelDelta > 0 ? 1 : -1;
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
): FlyState {
  if (dt <= 0) return state;
  const step = speed * dt;

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
