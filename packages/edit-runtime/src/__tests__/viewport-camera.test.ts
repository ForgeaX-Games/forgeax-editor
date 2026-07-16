// viewport-camera.test.ts — unit tests for orbit camera pure functions (AC-03).
// plan-strategy D-8: narrow deps interface, no DOM/GPU imports.
import { test, expect } from 'bun:test';
import {
  deriveInputTarget,
  clampPitch,
  clampDist,
  advanceOrbit,
  computeOrbitCamera,
  clampFlySpeed,
  applyFlyWheelSpeed,
  advanceFly,
  advanceFlyLook,
  computeFlyCamera,
  orbitToFly,
  flyToOrbit,
  FLY_SPEED_MIN,
  FLY_SPEED_MAX,
  FLY_SPEED_STEP,
  type OrbitState,
  type OrbitCameraResult,
  type FlyState,
  type FlyInput,
} from '../viewport/viewport-camera';
import type { Vec3 } from '../viewport/viewport-ray';

// ── deriveInputTarget (AC-03, plan-strategy D-5) ────────────────────────────

test('deriveInputTarget: Play needs an explicit game control lease', () => {
  expect(deriveInputTarget('play', 'game')).toBe('game');
  expect(deriveInputTarget('play', 'editor')).toBe('editor');
});

test('deriveInputTarget: an edit lifecycle never routes input to game', () => {
  expect(deriveInputTarget('edit', 'game')).toBe('editor');
  expect(deriveInputTarget('edit', 'editor')).toBe('editor');
});

// ── clampPitch ──────────────────────────────────────────────────────────────

test('clampPitch: within range passes through', () => {
  expect(clampPitch(0)).toBe(0);
  expect(clampPitch(0.5)).toBe(0.5);
  expect(clampPitch(-0.8)).toBe(-0.8);
});

test('clampPitch: clamps at upper bound (Math.PI/2 ~1.57, but max is 1.5)', () => {
  expect(clampPitch(1.5)).toBe(1.5);
  expect(clampPitch(1.55)).toBe(1.5);
  expect(clampPitch(2.0)).toBe(1.5);
});

test('clampPitch: clamps at lower bound', () => {
  expect(clampPitch(-1.5)).toBe(-1.5);
  expect(clampPitch(-1.55)).toBe(-1.5);
  expect(clampPitch(-2.0)).toBe(-1.5);
});

// ── clampDist ────────────────────────────────────────────────────────────────

test('clampDist: within range passes through', () => {
  expect(clampDist(10)).toBe(10);
  expect(clampDist(50)).toBe(50);
});

test('clampDist: clamps at lower bound (2)', () => {
  expect(clampDist(2)).toBe(2);
  expect(clampDist(1)).toBe(2);
  expect(clampDist(0)).toBe(2);
});

test('clampDist: clamps at upper bound (300)', () => {
  expect(clampDist(300)).toBe(300);
  expect(clampDist(350)).toBe(300);
  expect(clampDist(1000)).toBe(300);
});

// ── advanceOrbit ─────────────────────────────────────────────────────────────

test('advanceOrbit: accumulates yaw without bound', () => {
  const result = advanceOrbit(1.0, 0, 10, 0.5, 0, 0);
  expect(result.yaw).toBeCloseTo(1.5, 6);
});

test('advanceOrbit: accumulates pitch with clamp at upper bound', () => {
  // pitch at 1.4 + delta 0.2 = 1.6 -> clamped to 1.5
  const result = advanceOrbit(0, 1.4, 10, 0, 0.2, 0);
  expect(result.pitch).toBe(1.5);
});

test('advanceOrbit: accumulates pitch with clamp at lower bound', () => {
  // pitch at -1.4 + delta -0.2 = -1.6 -> clamped to -1.5
  const result = advanceOrbit(0, -1.4, 10, 0, -0.2, 0);
  expect(result.pitch).toBe(-1.5);
});

test('advanceOrbit: positive deltaDist zooms in (reduces dist) with clamp', () => {
  // dist=10 + deltaDist=1.0 means reduce dist
  const result = advanceOrbit(0, 0, 10, 0, 0, 1.0);
  expect(result.dist).toBeCloseTo(9, 6);
});

test('advanceOrbit: negative deltaDist zooms out (increases dist) with clamp', () => {
  // dist=10 + deltaDist=-1.0 means increase dist
  const result = advanceOrbit(0, 0, 10, 0, 0, -1.0);
  expect(result.dist).toBeCloseTo(11, 6);
});

test('advanceOrbit: dist clamps at min (2)', () => {
  const result = advanceOrbit(0, 0, 2.5, 0, 0, 1.0);
  expect(result.dist).toBe(2);
});

test('advanceOrbit: dist clamps at max (300)', () => {
  const result = advanceOrbit(0, 0, 299, 0, 0, -2.0);
  expect(result.dist).toBe(300);
});

test('advanceOrbit: returns OrbitState shape with all three fields', () => {
  const result = advanceOrbit(0.5, -0.3, 20, 0.1, 0.05, 0);
  expect(result).toHaveProperty('yaw');
  expect(result).toHaveProperty('pitch');
  expect(result).toHaveProperty('dist');
  expect(typeof result.yaw).toBe('number');
  expect(typeof result.pitch).toBe('number');
  expect(typeof result.dist).toBe('number');
});

// ── computeOrbitCamera ──────────────────────────────────────────────────────

test('computeOrbitCamera: default framing — origin target, yaw=0, pitch=0, dist=5', () => {
  const target: Vec3 = [0, 0, 0];
  const result = computeOrbitCamera(target, 0, 0, 5);
  // yaw=0, pitch=0: camera looks down -Z, positioned at z=5
  expect(result.camPos[0]).toBeCloseTo(0, 6);
  expect(result.camPos[1]).toBeCloseTo(0, 6);
  expect(result.camPos[2]).toBeCloseTo(5, 6);
  expect(result.fwd[0]).toBeCloseTo(0, 6);
  expect(result.fwd[1]).toBeCloseTo(0, 6);
  expect(result.fwd[2]).toBeCloseTo(-1, 6);
  expect(result.rgt[0]).toBeCloseTo(1, 6);
  expect(result.upv[1]).toBeCloseTo(1, 6);
});

test('computeOrbitCamera: yaw=90deg rotates right vector forward', () => {
  const target: Vec3 = [0, 0, 0];
  const result = computeOrbitCamera(target, Math.PI / 2, 0, 5);
  // yaw=90deg around Y: fwd rotates to -X, cam at x=+5
  expect(result.camPos[0]).toBeCloseTo(5, 6);
  expect(result.camPos[2]).toBeCloseTo(0, 6);
  // forward is -X direction (quat-based camera: camPos = target - fwd * dist)
  expect(result.fwd[0]).toBeCloseTo(-1, 4);
  expect(result.fwd[1]).toBeCloseTo(0, 6);
  expect(result.fwd[2]).toBeCloseTo(0, 6);
});

test('computeOrbitCamera: pitch=-45deg tilts camera up', () => {
  const target: Vec3 = [0, 2, 0];
  const result = computeOrbitCamera(target, 0, -Math.PI / 4, 10);
  // pitch negative = camera above, looking somewhat down
  // forward should have positive Y component (camera is above target looking down)
  expect(result.camPos[1]).toBeGreaterThan(target[1]);
});

test('computeOrbitCamera: all result vectors are unit length', () => {
  const target: Vec3 = [1, 2, 3];
  const result = computeOrbitCamera(target, 1.2, -0.4, 8);
  const len = (v: Vec3) => Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  expect(len(result.fwd)).toBeCloseTo(1, 6);
  expect(len(result.rgt)).toBeCloseTo(1, 6);
  expect(len(result.upv)).toBeCloseTo(1, 6);
});

test('computeOrbitCamera: camPos = target - fwd * dist', () => {
  const target: Vec3 = [1, 2, 3];
  const dist = 10;
  const result = computeOrbitCamera(target, 0.3, -0.2, dist);
  // camPos should satisfy camPos + fwd * dist = target
  const reconstructed: Vec3 = [
    result.camPos[0] + result.fwd[0] * dist,
    result.camPos[1] + result.fwd[1] * dist,
    result.camPos[2] + result.fwd[2] * dist,
  ];
  expect(reconstructed[0]).toBeCloseTo(target[0], 6);
  expect(reconstructed[1]).toBeCloseTo(target[1], 6);
  expect(reconstructed[2]).toBeCloseTo(target[2], 6);
});

test('computeOrbitCamera: forward/right/up form an orthonormal basis', () => {
  const target: Vec3 = [0, 0, 0];
  const result = computeOrbitCamera(target, 0.7, -0.5, 12);
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  expect(dot(result.fwd, result.rgt)).toBeCloseTo(0, 6);
  expect(dot(result.fwd, result.upv)).toBeCloseTo(0, 6);
  expect(dot(result.rgt, result.upv)).toBeCloseTo(0, 6);
});

test('computeOrbitCamera: OrbitCameraResult has correct shape (incl. qCam)', () => {
  const result = computeOrbitCamera([0, 0, 0], 0, 0, 5);
  expect(result).toHaveProperty('camPos');
  expect(result).toHaveProperty('fwd');
  expect(result).toHaveProperty('rgt');
  expect(result).toHaveProperty('upv');
  expect(result).toHaveProperty('qCam');
  expect(Array.isArray(result.camPos)).toBe(true);
  expect(result.camPos).toHaveLength(3);
  expect(Array.isArray(result.qCam)).toBe(true);
  expect(result.qCam).toHaveLength(4);
});

// ── clampFlySpeed / applyFlyWheelSpeed ──────────────────────────────────────

test('clampFlySpeed: within range passes through', () => {
  expect(clampFlySpeed(8)).toBe(8);
  expect(clampFlySpeed(1)).toBe(1);
});

test('clampFlySpeed: clamps at min/max', () => {
  expect(clampFlySpeed(0.1)).toBe(FLY_SPEED_MIN);
  expect(clampFlySpeed(200)).toBe(FLY_SPEED_MAX);
});

test('applyFlyWheelSpeed: positive delta scales up by FLY_SPEED_STEP', () => {
  const speed = 8;
  expect(applyFlyWheelSpeed(speed, 1)).toBeCloseTo(speed * FLY_SPEED_STEP, 4);
  expect(applyFlyWheelSpeed(speed, 100)).toBeCloseTo(speed * FLY_SPEED_STEP, 4);
});

test('applyFlyWheelSpeed: negative delta scales down', () => {
  const speed = 8;
  expect(applyFlyWheelSpeed(speed, -1)).toBeCloseTo(speed / FLY_SPEED_STEP, 4);
});

test('applyFlyWheelSpeed: zero delta returns current speed (clamped)', () => {
  expect(applyFlyWheelSpeed(8, 0)).toBe(8);
  expect(applyFlyWheelSpeed(1000, 0)).toBe(FLY_SPEED_MAX);
});

// ── advanceFly (movement) ───────────────────────────────────────────────────

const emptyInput: FlyInput = {
  forward: false, backward: false, left: false, right: false, up: false, down: false,
};

test('advanceFly: no input returns same position', () => {
  const state: FlyState = { pos: [1, 2, 3], yaw: 0, pitch: 0 };
  const result = advanceFly(state, emptyInput, 8, 1 / 60);
  expect(result.pos[0]).toBeCloseTo(1, 6);
  expect(result.pos[1]).toBeCloseTo(2, 6);
  expect(result.pos[2]).toBeCloseTo(3, 6);
});

test('advanceFly: dt <= 0 returns same state (early return)', () => {
  const state: FlyState = { pos: [1, 2, 3], yaw: 0, pitch: 0 };
  const result = advanceFly(state, { ...emptyInput, forward: true }, 8, 0);
  expect(result).toBe(state);
});

test('advanceFly: forward at yaw=0,pitch=0 moves along -Z', () => {
  // fwd = qCam·[0,0,-1] with identity quat = [0,0,-1]
  const state: FlyState = { pos: [0, 0, 0], yaw: 0, pitch: 0 };
  const result = advanceFly(state, { ...emptyInput, forward: true }, 10, 1);
  expect(result.pos[0]).toBeCloseTo(0, 6);
  expect(result.pos[1]).toBeCloseTo(0, 6);
  expect(result.pos[2]).toBeCloseTo(-10, 6);
});

test('advanceFly: backward reverses forward direction', () => {
  const state: FlyState = { pos: [0, 0, 0], yaw: 0, pitch: 0 };
  const result = advanceFly(state, { ...emptyInput, backward: true }, 10, 1);
  expect(result.pos[2]).toBeCloseTo(10, 6);
});

test('advanceFly: right at yaw=0 moves along +X', () => {
  const state: FlyState = { pos: [0, 0, 0], yaw: 0, pitch: 0 };
  const result = advanceFly(state, { ...emptyInput, right: true }, 10, 1);
  expect(result.pos[0]).toBeCloseTo(10, 6);
});

test('advanceFly: up moves along world +Y (independent of pitch)', () => {
  // UE5 convention: E raises along world up, not camera up
  const state: FlyState = { pos: [0, 0, 0], yaw: 0, pitch: -1.0 };
  const result = advanceFly(state, { ...emptyInput, up: true }, 10, 1);
  expect(result.pos[0]).toBeCloseTo(0, 6);
  expect(result.pos[1]).toBeCloseTo(10, 6);
  expect(result.pos[2]).toBeCloseTo(0, 6);
});

test('advanceFly: down moves along world -Y', () => {
  const state: FlyState = { pos: [0, 0, 0], yaw: 0, pitch: 0 };
  const result = advanceFly(state, { ...emptyInput, down: true }, 10, 1);
  expect(result.pos[1]).toBeCloseTo(-10, 6);
});

test('advanceFly: diagonal (forward+right) is normalized (no speed boost)', () => {
  const state: FlyState = { pos: [0, 0, 0], yaw: 0, pitch: 0 };
  const result = advanceFly(state, { ...emptyInput, forward: true, right: true }, 10, 1);
  const dist = Math.hypot(result.pos[0], result.pos[1], result.pos[2]);
  expect(dist).toBeCloseTo(10, 5);
});

test('advanceFly: opposite inputs cancel out', () => {
  const state: FlyState = { pos: [0, 0, 0], yaw: 0, pitch: 0 };
  const result = advanceFly(state, { ...emptyInput, forward: true, backward: true }, 10, 1);
  expect(result.pos[0]).toBeCloseTo(0, 6);
  expect(result.pos[1]).toBeCloseTo(0, 6);
  expect(result.pos[2]).toBeCloseTo(0, 6);
});

test('advanceFly: speed and dt scale movement linearly', () => {
  const state: FlyState = { pos: [0, 0, 0], yaw: 0, pitch: 0 };
  const r1 = advanceFly(state, { ...emptyInput, forward: true }, 10, 1);
  const r2 = advanceFly(state, { ...emptyInput, forward: true }, 20, 0.5);
  expect(Math.abs(r1.pos[2])).toBeCloseTo(Math.abs(r2.pos[2]), 6);
});

test('advanceFly: yaw=90deg forward moves along -X', () => {
  const state: FlyState = { pos: [0, 0, 0], yaw: Math.PI / 2, pitch: 0 };
  const result = advanceFly(state, { ...emptyInput, forward: true }, 10, 1);
  expect(result.pos[0]).toBeCloseTo(-10, 4);
  expect(result.pos[2]).toBeCloseTo(0, 4);
});

// ── advanceFlyLook (view rotation) ──────────────────────────────────────────

test('advanceFlyLook: accumulates yaw unbounded', () => {
  const state: FlyState = { pos: [0, 0, 0], yaw: 1.0, pitch: 0 };
  const r = advanceFlyLook(state, 0.5, 0);
  expect(r.yaw).toBeCloseTo(1.5, 6);
});

test('advanceFlyLook: clamps pitch to same range as orbit', () => {
  const state: FlyState = { pos: [0, 0, 0], yaw: 0, pitch: 1.4 };
  const r = advanceFlyLook(state, 0, 0.5);
  expect(r.pitch).toBe(1.5);
});

test('advanceFlyLook: preserves position', () => {
  const state: FlyState = { pos: [5, 6, 7], yaw: 0, pitch: 0 };
  const r = advanceFlyLook(state, 0.1, 0.1);
  expect(r.pos[0]).toBe(5);
  expect(r.pos[1]).toBe(6);
  expect(r.pos[2]).toBe(7);
});

// ── computeFlyCamera ────────────────────────────────────────────────────────

test('computeFlyCamera: camPos equals state.pos', () => {
  const state: FlyState = { pos: [3, 4, 5], yaw: 0.5, pitch: -0.3 };
  const result = computeFlyCamera(state);
  expect(result.camPos[0]).toBeCloseTo(3, 6);
  expect(result.camPos[1]).toBeCloseTo(4, 6);
  expect(result.camPos[2]).toBeCloseTo(5, 6);
});

test('computeFlyCamera: forms orthonormal basis', () => {
  const state: FlyState = { pos: [0, 0, 0], yaw: 0.7, pitch: -0.5 };
  const result = computeFlyCamera(state);
  const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  expect(dot(result.fwd, result.rgt)).toBeCloseTo(0, 6);
  expect(dot(result.fwd, result.upv)).toBeCloseTo(0, 6);
  expect(dot(result.rgt, result.upv)).toBeCloseTo(0, 6);
});

// ── orbitToFly / flyToOrbit (round-trip continuity) ─────────────────────────

test('orbitToFly: fly.pos equals orbit camPos (target - fwd * dist)', () => {
  const target: import('../viewport/viewport-ray').Vec3 = [1, 2, 3];
  const orbit = computeOrbitCamera(target, 0.4, -0.2, 12);
  const fly = orbitToFly(target, 0.4, -0.2, 12);
  expect(fly.pos[0]).toBeCloseTo(orbit.camPos[0], 6);
  expect(fly.pos[1]).toBeCloseTo(orbit.camPos[1], 6);
  expect(fly.pos[2]).toBeCloseTo(orbit.camPos[2], 6);
  expect(fly.yaw).toBe(0.4);
  expect(fly.pitch).toBe(-0.2);
});

test('flyToOrbit → orbit camera position matches original fly.pos', () => {
  // 关键连续性保证：从 fly 切回 orbit 后，实际相机位置不能跳变
  const fly: FlyState = { pos: [5, 3, -8], yaw: 0.6, pitch: -0.25 };
  const orbit = flyToOrbit(fly, 15);
  const back = computeOrbitCamera(orbit.target, orbit.yaw, orbit.pitch, orbit.dist);
  expect(back.camPos[0]).toBeCloseTo(fly.pos[0], 4);
  expect(back.camPos[1]).toBeCloseTo(fly.pos[1], 4);
  expect(back.camPos[2]).toBeCloseTo(fly.pos[2], 4);
});

test('orbitToFly → flyToOrbit round-trip preserves yaw/pitch/dist', () => {
  const target: import('../viewport/viewport-ray').Vec3 = [0, 1, 2];
  const yaw0 = 0.3, pitch0 = -0.4, dist0 = 20;
  const fly = orbitToFly(target, yaw0, pitch0, dist0);
  const orbit2 = flyToOrbit(fly, dist0);
  expect(orbit2.yaw).toBeCloseTo(yaw0, 6);
  expect(orbit2.pitch).toBeCloseTo(pitch0, 6);
  expect(orbit2.dist).toBeCloseTo(dist0, 6);
  // target 也应恢复（fly.pos + fwd*dist = 原 target）
  expect(orbit2.target[0]).toBeCloseTo(target[0], 4);
  expect(orbit2.target[1]).toBeCloseTo(target[1], 4);
  expect(orbit2.target[2]).toBeCloseTo(target[2], 4);
});

test('flyToOrbit: clamps previousDist to allowed range', () => {
  const fly: FlyState = { pos: [0, 0, 0], yaw: 0, pitch: 0 };
  expect(flyToOrbit(fly, 1).dist).toBe(2);      // clamped up to DIST_MIN
  expect(flyToOrbit(fly, 500).dist).toBe(300);  // clamped down to DIST_MAX
});