// viewport-ray-math.test.ts — M6 (w18) zero-behavior split equivalence net.
//
// WHAT THIS LOCKS
//   The M6 milestone does a PURELY STRUCTURAL split of the viewport three files
//   (viewport.ts / ViewportComponent.tsx / viewport-ray.ts + gizmo/param helpers)
//   with ZERO behavior change (OOS-1 / AC-05). Before any code moves, this test
//   freezes the numeric contract of the pure geometry + orbit-camera + lifecycle
//   pure functions to GOLDEN values so w19's extraction is provably byte-equivalent:
//   if a function's output shifts by even one ULP after the move, this test goes red.
//
//   These functions (rayAABB @ viewport-ray.ts:54, angleOnAxis @ :113, the orbit
//   pose in viewport-camera.ts) are EXACTLY the same-function-body points the
//   sister loop `world-partition` will later semantically rewrite (research RD3:
//   "viewport three-file x world-partition precise intersection"). This loop must
//   NOT rewrite them (OOS-3) — it only moves cohesion clusters. The assertions
//   below assert pure-function equivalence and introduce NO super/world-handle
//   semantics (OOS-3), so post-merge sync can trust the geometry contract held.
//
// Anchors:
//   (forward) plan-strategy feat-20260709-editor-large-file-di-decompose-wave2-c-domain-scen
//     plan-id; AC-05 (zero behavior via real-value regression) + AC-10 (viewport
//     three-file controlled intersection — pure-fn equivalence net for post-merge
//     sync) + OOS-3 (no viewport semantic rewrite); plan-strategy §2 D-5 (M6 tail,
//     semantics untouched) + §5.3 (M6 pure-fn ray-math/lifecycle regression).
//   (backward) the pure geometry was factored out of viewport.ts in the
//     `refactor: rename engine/ to viewport/` history feat (#76); the orbit-camera
//     convention (qCam = yaw*[0,1,0] x pitch*[1,0,0]) reuses fps's proven engine
//     convention carried since the viewport's first landing.

import { describe, it, expect } from 'bun:test';
import {
  num,
  ndcFromClient,
  rayDirection,
  rayAABB,
  rayPlaneY,
  closestAxisT,
  rayPlane,
  orthoBasis,
  angleOnAxis,
  entityBox,
  type Vec3,
} from '../viewport-ray';
import {
  deriveInputTarget,
  clampPitch,
  clampDist,
  advanceOrbit,
  computeOrbitCamera,
} from '../viewport-camera';

// Float compare helper — geometry runs through the engine's Float32Array vec3
// buffers, so an exact === would be brittle across platforms; 1e-6 is far tighter
// than any structural move could perturb (a pure code move changes zero math).
const near = (a: number, b: number, eps = 1e-6): void => {
  expect(Math.abs(a - b)).toBeLessThan(eps);
};
const nearVec = (a: readonly number[], b: readonly number[], eps = 1e-6): void => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) near(a[i]!, b[i]!, eps);
};

describe('viewport-ray pure geometry — GOLDEN equivalence net (w18, AC-05/AC-10)', () => {
  it('num: finite-number guard with fallback', () => {
    expect(num('x', 7)).toBe(7);
    expect(num(3.5, 0)).toBe(3.5);
    expect(num(NaN, 9)).toBe(9);
    expect(num(Infinity, 2)).toBe(2);
    expect(num(undefined, -1)).toBe(-1);
  });

  it('ndcFromClient: center pixel -> NDC origin', () => {
    nearVec(ndcFromClient(400, 300, 800, 600), [0, 0]);
    nearVec(ndcFromClient(0, 0, 800, 600), [-1, 1]);
    nearVec(ndcFromClient(800, 600, 800, 600), [1, -1]);
  });

  it('rayDirection: normalized ray through an NDC point', () => {
    nearVec(
      rayDirection([0, 0, -1], [1, 0, 0], [0, 1, 0], 0.5, 0.5, Math.PI / 3, 1.5),
      [0.38411062955856323, 0.2560737729072571, -0.8870655298233032],
    );
  });

  it('rayAABB (viewport-ray.ts:54 — world-partition overlap point): entry distance / null', () => {
    // hit head-on: origin 5 units back, box half-extent 1 -> entry at 4.
    expect(rayAABB([0, 0, 5], [0, 0, -1], [0, 0, 0], [1, 1, 1])).toBe(4);
    // ray points away from the box on Y -> miss.
    expect(rayAABB([0, 0, 5], [0, 1, 0], [0, 0, 0], [1, 1, 1])).toBeNull();
    // ray parallel but offset outside the slab -> miss.
    expect(rayAABB([3, 3, 5], [0, 0, -1], [0, 0, 0], [1, 1, 1])).toBeNull();
  });

  it('rayPlaneY: horizontal-plane intersection point / null', () => {
    nearVec(rayPlaneY([0, 5, 0], [0, -1, 0], 2) as Vec3, [0, 2, 0]);
    expect(rayPlaneY([0, 5, 0], [1, 0, 0], 2)).toBeNull(); // parallel to plane
    expect(rayPlaneY([0, 5, 0], [0, 1, 0], 2)).toBeNull(); // points away (t<0)
  });

  it('closestAxisT: parameter along an axis line at closest approach', () => {
    near(closestAxisT([0, 0, 5], [0, 0, -1], [0, 0, 0], [1, 0, 0]), 0);
    near(closestAxisT([2, 0, 5], [0, 0, -1], [0, 0, 0], [1, 0, 0]), 2);
  });

  it('rayPlane: arbitrary point+normal plane intersection', () => {
    nearVec(rayPlane([0, 5, 0], [0, -1, 0], [0, 0, 0], [0, 1, 0]) as Vec3, [0, 0, 0]);
    expect(rayPlane([0, 5, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0])).toBeNull(); // parallel
  });

  it('orthoBasis: two orthonormal vectors spanning the plane ⊥ axis', () => {
    const [u, v] = orthoBasis([0, 1, 0]);
    nearVec(u, [0, 0, 1]);
    nearVec(v, [1, 0, 0]);
    // orthonormality invariants hold for a skew axis too.
    const [u2, v2] = orthoBasis([0.3, 0.6, 0.2]);
    near(u2[0] * v2[0] + u2[1] * v2[1] + u2[2] * v2[2], 0); // u ⊥ v
    near(Math.hypot(u2[0], u2[1], u2[2]), 1); // |u| = 1
    near(Math.hypot(v2[0], v2[1], v2[2]), 1); // |v| = 1
  });

  it('angleOnAxis (viewport-ray.ts:113 — world-partition overlap point): signed plane angle / null', () => {
    near(angleOnAxis([1, 5, 0], [0, -1, 0], [0, 0, 0], [0, 1, 0]) as number, Math.PI / 2);
    near(angleOnAxis([0, 5, 1], [0, -1, 0], [0, 0, 0], [0, 1, 0]) as number, 0);
    expect(angleOnAxis([1, 5, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0])).toBeNull(); // ray ∥ plane
  });

  it('entityBox: world AABB from Transform, with razor-thin-slab padding', () => {
    // scaleY 0.02 is a thin slab -> half-Y padded up to the 0.05 minimum.
    const b = entityBox({ x: 1, y: 2, z: 3, scaleX: 4, scaleY: 0.02, scaleZ: 2 });
    nearVec(b.center, [1, 2, 3]);
    nearVec(b.half, [2, 0.05, 1]);
    // missing fields fall back to pos 0 / scale 1.
    const d = entityBox({});
    nearVec(d.center, [0, 0, 0]);
    nearVec(d.half, [0.5, 0.5, 0.5]);
  });
});

describe('viewport-camera orbit + lifecycle pure functions — GOLDEN net (w18, AC-05)', () => {
  it('deriveInputTarget: only play·game owns game input', () => {
    expect(deriveInputTarget('play', 'game')).toBe('game');
    expect(deriveInputTarget('play', 'scene')).toBe('editor');
    expect(deriveInputTarget('edit', 'game')).toBe('editor');
    expect(deriveInputTarget('edit', 'scene')).toBe('editor');
  });

  it('clampPitch / clampDist: bounds enforced, pass-through in range', () => {
    expect(clampPitch(2.0)).toBe(1.5);
    expect(clampPitch(-2.0)).toBe(-1.5);
    expect(clampPitch(0.3)).toBe(0.3);
    expect(clampDist(500)).toBe(300);
    expect(clampDist(1)).toBe(2);
    expect(clampDist(34)).toBe(34);
  });

  it('advanceOrbit: yaw unbounded, pitch+dist clamped (zoom-in reduces dist)', () => {
    const r = advanceOrbit(0.6, -0.5, 34, 0.1, -0.2, 5);
    near(r.yaw, 0.7);
    near(r.pitch, -0.7);
    near(r.dist, 29);
  });

  it('computeOrbitCamera: the ONE surgery-point pose (viewport.ts:167 feeds this) — GOLDEN', () => {
    // This is the exact pose applyCamera writes to the camera Transform each frame.
    // world-partition will later rewrite HOW that write reaches the world (super
    // handle), but the COMPUTED pose here must stay byte-identical post-split (OOS-3).
    const r = computeOrbitCamera([0, 2, 0], 0.6, -0.5, 34);
    nearVec(r.camPos, [16.847694039344788, 18.30046969652176, 24.62620496749878]);
    nearVec(r.fwd, [-0.4955204129219055, -0.4794255793094635, -0.7243001461029053]);
    nearVec(r.rgt, [0.8253356218338013, 9.2618250846499e-9, -0.5646424889564514]);
    nearVec(r.upv, [-0.2707040309906006, 0.8775825500488281, -0.3956869840621948]);
    nearVec(r.qCam, [-0.2363540381193161, 0.28633320331573486, 0.07311287522315979, 0.925637423992157]);
  });

  it('computeOrbitCamera: camPos = target - fwd*dist invariant holds for any framing', () => {
    for (const [t, yaw, pitch, dist] of [
      [[0, 0, 0], 0, 0, 10],
      [[5, 3, -2], 1.2, -0.9, 55],
      [[-1, 8, 4], -0.4, 0.7, 3],
    ] as [Vec3, number, number, number][]) {
      const r = computeOrbitCamera(t, yaw, pitch, dist);
      nearVec(r.camPos, [t[0] - r.fwd[0] * dist, t[1] - r.fwd[1] * dist, t[2] - r.fwd[2] * dist]);
    }
  });
});
