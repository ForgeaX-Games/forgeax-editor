// viewport-camera.test.ts — unit tests for orbit camera pure functions (AC-03).
// plan-strategy D-8: narrow deps interface, no DOM/GPU imports.
import { test, expect } from 'bun:test';
import {
  deriveInputTarget,
  clampPitch,
  clampDist,
  advanceOrbit,
  computeOrbitCamera,
  type OrbitState,
  type OrbitCameraResult,
} from '../engine/viewport-camera';
import type { Vec3 } from '../engine/viewport-ray';

// ── deriveInputTarget (AC-03, plan-strategy D-5) ────────────────────────────

test('deriveInputTarget: play+game -> game (the only game-owned quadrant)', () => {
  expect(deriveInputTarget('play', 'game')).toBe('game');
});

test('deriveInputTarget: play+scene -> editor', () => {
  expect(deriveInputTarget('play', 'scene')).toBe('editor');
});

test('deriveInputTarget: edit+game -> editor', () => {
  expect(deriveInputTarget('edit', 'game')).toBe('editor');
});

test('deriveInputTarget: edit+scene -> editor', () => {
  expect(deriveInputTarget('edit', 'scene')).toBe('editor');
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