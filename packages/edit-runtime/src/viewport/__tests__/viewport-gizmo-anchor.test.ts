// viewport-gizmo-anchor — gizmo anchor + constant on-screen size (gizmo-ue-parity plan M1/M2).
//
// Regression cover for the two P0 bugs found in the 2026-08-05 investigation:
//   1. fly roaming froze the gizmo size on a stale orbit `dist` (screen size
//      drifted mid-roam and jumped at fly end) — getViewScale now reads the
//      LIVE camera state every update;
//   2. ortho zoom never changed the gizmo size — the ortho branch derives the
//      scale from the ortho half-height.
// Plus the multi-selection anchor contract (plan §4.1): the pool places the
// gizmo at whatever anchor the caller resolves (average center for multi), and
// sizes handles ∝ the view scale.

import { describe, expect, it } from 'bun:test';

import { gizmoViewScale, GIZMO_VIEW_SCALE_MIN } from '../viewport-camera';
import { createGizmoPool, type GizmoOverlayDraw } from '../viewport-gizmo';
import { buildDragGroup, translatedMemberTarget, type DragGroupSeed } from '../viewport-drag-group';
import type { Vec3 } from '../viewport-ray';

const FOV_60 = Math.PI / 3;

describe('gizmoViewScale (constant on-screen size)', () => {
  it('perspective: returns the camera→anchor distance', () => {
    expect(gizmoViewScale('perspective', [0, 0, 10], [0, 0, 0], 10, FOV_60)).toBeCloseTo(10, 6);
    expect(gizmoViewScale('perspective', [3, 4, 0], [0, 0, 0], 10, FOV_60)).toBeCloseTo(5, 6);
  });

  it('perspective: follows the LIVE camera position (fly roaming keeps the size constant)', () => {
    const anchor: Vec3 = [0, 0, 0];
    const near = gizmoViewScale('perspective', [0, 0, 4], anchor, 10, FOV_60);
    const far = gizmoViewScale('perspective', [0, 0, 40], anchor, 10, FOV_60);
    // World size ∝ distance ⇒ screen size invariant as the camera flies.
    expect(far / near).toBeCloseTo(10, 6);
  });

  it('perspective: degenerate / non-finite camera positions fall back to the minimum', () => {
    expect(gizmoViewScale('perspective', [0, 0, 0], [0, 0, 0], 10, FOV_60)).toBe(GIZMO_VIEW_SCALE_MIN);
    expect(gizmoViewScale('perspective', [Number.NaN, 0, 0], [0, 0, 0], 10, FOV_60)).toBe(GIZMO_VIEW_SCALE_MIN);
    expect(gizmoViewScale('perspective', [Number.POSITIVE_INFINITY, 0, 0], [0, 0, 0], 10, FOV_60)).toBe(GIZMO_VIEW_SCALE_MIN);
  });

  it('orthographic: derives the scale from the half-height (inverse of deriveOrthoHalfHeight)', () => {
    // orthoHalfHeight = dist * tan(fov/2) ⇒ viewScale ≈ dist for the same framing.
    const scale = gizmoViewScale('orthographic', [0, 0, 999], [0, 0, 0], 10 * Math.tan(FOV_60 / 2), FOV_60);
    expect(scale).toBeCloseTo(10, 6);
  });

  it('orthographic: scales with zoom so the on-screen size stays constant', () => {
    const zoomedIn = gizmoViewScale('orthographic', [0, 0, 0], [0, 0, 0], 5, FOV_60);
    const zoomedOut = gizmoViewScale('orthographic', [0, 0, 0], [0, 0, 0], 50, FOV_60);
    expect(zoomedOut / zoomedIn).toBeCloseTo(10, 6);
  });
});

interface LineCall { from: ArrayLike<number>; to: ArrayLike<number>; color: unknown }
interface ArrowCall { from: ArrayLike<number>; to: ArrayLike<number>; color: unknown; tipLength?: number }

function makeDebugDraw(): {
  draw: GizmoOverlayDraw;
  lines: LineCall[];
  arrows: ArrowCall[];
} {
  const lines: LineCall[] = [];
  const arrows: ArrowCall[] = [];
  return {
    lines,
    arrows,
    draw: {
      line(from, to, color) { lines.push({ from, to, color }); },
      arrow(from, to, color, tipLength) { arrows.push({ from, to, color, tipLength }); },
    },
  };
}

function expectVecClose(actual: unknown, expected: number[]): void {
  const arr = actual as number[];
  expect(arr.length).toBe(expected.length);
  expected.forEach((v, i) => expect(arr[i]).toBeCloseTo(v, 6));
}

describe('gizmo pool anchor + view scale', () => {
  it('emits post-scene axis arrows around the anchor, sized ∝ the view scale', () => {
    const { draw, arrows, lines } = makeDebugDraw();
    const viewScaleArgs: Vec3[] = [];
    const center: Vec3 = [2, 4, 6];
    const pool = createGizmoPool({
      getAnchor: () => ({ center, quat: null }),
      getGizmoMode: () => 'translate',
      getGizmoSpace: () => 'world',
      isAuxVisible: () => true,
      getViewScale: (anchor: Vec3) => { viewScaleArgs.push(anchor); return 10; },
    });

    pool.update();
    pool.drawOverlay(draw);

    // The view scale is evaluated AT the anchor (camera→anchor distance in perspective).
    expect(viewScaleArgs.length).toBe(1);
    expect(viewScaleArgs[0]).toEqual([2, 4, 6]);

    // len = viewScale * 0.13; translate arrows include the existing tip reach.
    const len = 10 * 0.13;
    const tipLen = len * 0.34;
    expect(arrows).toHaveLength(3);
    expect(lines).toHaveLength(12); // four edges for each translate plane
    expectVecClose(arrows[0]!.from, center);
    expectVecClose(arrows[0]!.to, [2 + len + tipLen, 4, 6]);
    expect(arrows[0]!.tipLength).toBeCloseTo(tipLen, 6);
  });

  it('re-evaluates the view scale on every update (no stale freeze)', () => {
    let calls = 0;
    const pool = createGizmoPool({
      getAnchor: () => ({ center: [0, 0, 0], quat: null }),
      getGizmoMode: () => 'translate',
      getGizmoSpace: () => 'world',
      isAuxVisible: () => true,
      getViewScale: () => { calls += 1; return 10; },
    });
    pool.update();
    pool.update();
    expect(calls).toBe(2);
  });

  it('hides when the anchor is null', () => {
    const { draw, lines, arrows } = makeDebugDraw();
    const pool = createGizmoPool({
      getAnchor: () => null,
      getGizmoMode: () => 'translate',
      getGizmoSpace: () => 'world',
      isAuxVisible: () => true,
      getViewScale: () => 10,
    });
    pool.update();
    pool.drawOverlay(draw);
    expect(lines).toHaveLength(0);
    expect(arrows).toHaveLength(0);
  });

  it('local space applies the anchor quaternion to the overlay axes', () => {
    const { draw, lines } = makeDebugDraw();
    // 90° around Z: [0, 0, sin45, cos45]
    const quat: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const pool = createGizmoPool({
      getAnchor: () => ({ center: [0, 0, 0], quat }),
      getGizmoMode: () => 'scale',
      getGizmoSpace: () => 'local',
      isAuxVisible: () => true,
      getViewScale: () => 10,
    });
    pool.update();
    pool.drawOverlay(draw);
    expect(lines).toHaveLength(3);
    expectVecClose(lines[0]!.from, [0, 0, 0]);
    expectVecClose(lines[0]!.to, [0, 1.3, 0]);
  });

  it('world space keeps overlay axes world-aligned when the anchor is rotated', () => {
    const { draw, lines } = makeDebugDraw();
    const quat: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const pool = createGizmoPool({
      getAnchor: () => ({ center: [0, 0, 0], quat }),
      getGizmoMode: () => 'scale',
      getGizmoSpace: () => 'world',
      isAuxVisible: () => true,
      getViewScale: () => 10,
    });
    pool.update();
    pool.drawOverlay(draw);
    expect(lines).toHaveLength(3);
    expectVecClose(lines[0]!.from, [0, 0, 0]);
    expectVecClose(lines[0]!.to, [1.3, 0, 0]);
  });
});

describe('buildDragGroup (multi-selection translate drag)', () => {
  const makeSeeds = (): Map<number, DragGroupSeed> => new Map<number, DragGroupSeed>([
    [11, { local: { x: 1, y: 0, z: 0 }, worldPos: [1, 0, 0] }],
    [22, { local: { x: 5, y: 0, z: 0 }, worldPos: [5, 0, 0] }],
    [33, { local: { x: 9, y: 2, z: 0 }, worldPos: [9, 2, 0] }],
  ]);

  it('primary first, then the rest of the selection (stable order)', () => {
    const seeds = makeSeeds();
    const read = (e: number): DragGroupSeed | undefined => seeds.get(e);
    const group = buildDragGroup(22 as never, new Set([11, 22, 33]) as never, read as never);
    expect(group.map((m) => m.id as number)).toEqual([22, 11, 33]);
  });

  it('single selection → single-member group', () => {
    const seeds = makeSeeds();
    const read = (e: number): DragGroupSeed | undefined => seeds.get(e);
    const group = buildDragGroup(11 as never, new Set([11]) as never, read as never);
    expect(group.length).toBe(1);
    expect(group[0]!.origWorld).toEqual([1, 0, 0]);
  });

  it('entities the reader cannot resolve are excluded', () => {
    const seeds = makeSeeds();
    const read = (e: number): DragGroupSeed | undefined => seeds.get(e);
    const group = buildDragGroup(11 as never, new Set([11, 44]) as never, read as never);
    expect(group.map((m) => m.id as number)).toEqual([11]);
  });

  it('snapshots are copies (later world edits cannot mutate the drag base)', () => {
    const seeds = makeSeeds();
    const read = (e: number): DragGroupSeed | undefined => seeds.get(e);
    const group = buildDragGroup(11 as never, new Set([11]) as never, read as never);
    seeds.get(11)!.local.x = 999;
    seeds.get(11)!.worldPos[0] = 999;
    expect(group[0]!.origLocal.x).toBe(1);
    expect(group[0]!.origWorld[0]).toBe(1);
  });

  it('translatedMemberTarget applies the shared world delta', () => {
    const seeds = makeSeeds();
    const read = (e: number): DragGroupSeed | undefined => seeds.get(e);
    const group = buildDragGroup(11 as never, new Set([11, 22]) as never, read as never);
    const delta: Vec3 = [0, 3, -1];
    expect(translatedMemberTarget(group[0]!, delta)).toEqual([1, 3, -1]);
    expect(translatedMemberTarget(group[1]!, delta)).toEqual([5, 3, -1]);
  });
});
