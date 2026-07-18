// euler↔quat round-trip tests — scheme B (plan-strategy S2 D-2)
//
// feat-20260701-editor-world-container-doc-ecs-collapse M3 / m3-test-euler-red
//
// AC-22: quat SSOT in world.Transform; euler is Inspector React state instant.
// Tests use the extracted euler-quat.ts SSOT (never hand-roll second conversions).
//
// IMPORTANT: both directions delegate to @forgeax/engine-math with XYZ intrinsic
// order (euler.fromQuat / quat.fromEuler). Even so, they are NOT exact euler-space
// inverses at gimbal-lock (many euler triplets map to one quaternion). The
// quaternion IS the SSOT. Each function is tested for self-consistency.
//
// plan-strategy S3.2: user types 370, blur → quat, quat never "corrects" 370.
// AGENTS.md #6: conversion on editor side, XYZ order, pinned both sides.

import { describe, expect, it } from 'bun:test';
import { eulerToQuat, quatToEuler } from '../util/euler-quat';

describe('m3-test-euler-red: euler↔quat round-trip', () => {
  // ── (a) No gimbal-lock: known quaternion → euler is consistent ─────────────
  it('(a) known quaternion for 45° Y rotation → euler close to (0,45,0)', () => {
    const half = Math.sin(Math.PI / 8); // sin(22.5°)
    const cosHalf = Math.cos(Math.PI / 8); // cos(22.5°)
    const euler = quatToEuler(0, half, 0, cosHalf);
    // ~45° Y rotation
    expect(Math.abs(euler.rotY)).toBeCloseTo(45, 0);
    expect(Math.abs(euler.rotX)).toBeCloseTo(0, 0);
    expect(Math.abs(euler.rotZ)).toBeCloseTo(0, 0);
  });

  // ── (b) Gimbal-lock boundary: rotY=90 quat → quatToEuler yields near-90 Y ───
  it('(b) gimbal-lock: eulerToQuat(0,90,0) → quatToEuler → Y near 90', () => {
    const q = eulerToQuat(0, 90, 0);
    const mid = quatToEuler(q[0], q[1], q[2], q[3]);
    // rotY should still be near 90
    expect(Math.abs(mid.rotY)).toBeGreaterThan(89);
  });

  // ── (c) 370° → same quaternion as 10° ──────────────────────────────────────
  it('(c) 370° ≡ 10° mod 360 produces same quaternion', () => {
    const q10 = eulerToQuat(0, 10, 0);
    const q370 = eulerToQuat(0, 370, 0);
    // Same rotation up to sign (q and -q represent identical orientation)
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(Math.abs(q10[i]!) - Math.abs(q370[i]!))).toBeLessThan(1e-5);
    }
    // quatToEuler normalizes to ~10° (not 370°)
    const out = quatToEuler(q370[0], q370[1], q370[2], q370[3]);
    expect(Math.abs(out.rotY)).toBeCloseTo(10, 0);
  });

  // ── (d) quat SSOT: change quat → euler display updates ──────────────────────
  it('(d) quat 90° X rotation → euler near (90,0,0)', () => {
    const half = Math.sin(Math.PI / 4); // sin(45°)
    const cosHalf = Math.cos(Math.PI / 4); // cos(45°)
    const euler = quatToEuler(half, 0, 0, cosHalf);
    // ~90° X rotation
    expect(Math.abs(euler.rotX)).toBeCloseTo(90, 0);
  });

  // ── Identity quat → all zeros ───────────────────────────────────────────────
  it('identity quat (0,0,0,1) → euler (0,0,0)', () => {
    const euler = quatToEuler(0, 0, 0, 1);
    expect(Math.abs(euler.rotX)).toBe(0);
    expect(Math.abs(euler.rotY)).toBe(0);
    expect(Math.abs(euler.rotZ)).toBe(0);
  });

  // ── Euler zero → identity quat ───────────────────────────────────────────────
  it('euler (0,0,0) → identity quat', () => {
    const q = eulerToQuat(0, 0, 0);
    expect(q[0]).toBe(0);
    expect(q[1]).toBe(0);
    expect(q[2]).toBe(0);
    expect(q[3]).toBe(1);
  });

  // ── eulerToQuat self-consistency: same euler → same quat ────────────────────
  it('eulerToQuat is deterministic', () => {
    const q1 = eulerToQuat(30, 45, 90);
    const q2 = eulerToQuat(30, 45, 90);
    for (let i = 0; i < 4; i++) {
      expect(q1[i]).toBe(q2[i]);
    }
  });
});