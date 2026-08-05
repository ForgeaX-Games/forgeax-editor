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
import type { EngineFacade } from '@forgeax/editor-core';

import { gizmoViewScale, GIZMO_VIEW_SCALE_MIN } from '../viewport-camera';
import { createGizmoPool } from '../viewport-gizmo';
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

interface SetCall { entity: number; data: Record<string, unknown> }

function makeEditorEngine(): { editorEngine: EngineFacade; sets: SetCall[] } {
  const sets: SetCall[] = [];
  let nextEntity = 1;
  const editorEngine = {
    allocSharedRef() { return 0 as never; },
    spawn() { nextEntity += 1; return { unwrap: () => nextEntity }; },
    set(entity: number, _component: unknown, data: Record<string, unknown>) {
      sets.push({ entity, data });
    },
    despawn() {},
  } as unknown as EngineFacade;
  return { editorEngine, sets };
}

function expectVecClose(actual: unknown, expected: number[]): void {
  const arr = actual as number[];
  expect(arr.length).toBe(expected.length);
  expected.forEach((v, i) => expect(arr[i]).toBeCloseTo(v, 6));
}

describe('gizmo pool anchor + view scale', () => {
  it('places axis bars around the anchor center, sized ∝ the view scale', () => {
    const { editorEngine, sets } = makeEditorEngine();
    const viewScaleArgs: Vec3[] = [];
    const center: Vec3 = [2, 4, 6];
    const pool = createGizmoPool({
      editorEngine,
      getAnchor: () => ({ center, quat: null }),
      getGizmoMode: () => 'translate',
      getGizmoSpace: () => 'world',
      isAuxVisible: () => true,
      getViewScale: (anchor: Vec3) => { viewScaleArgs.push(anchor); return 10; },
    });

    pool.update();

    // The view scale is evaluated AT the anchor (camera→anchor distance in perspective).
    expect(viewScaleArgs.length).toBe(1);
    expect(viewScaleArgs[0]).toEqual([2, 4, 6]);

    // len = viewScale * 0.13 on the long axis; thick = viewScale * 0.007.
    const len = 10 * 0.13, thick = 10 * 0.007;
    const barSets = sets.filter((s) => {
      const sc = s.data.scale as number[];
      return Array.isArray(sc) && sc.some((v) => Math.abs(v - len) < 1e-9);
    });
    expect(barSets.length).toBe(3); // one bar per axis
    // X bar: center + X * len/2, thickness on the short axes.
    const xBar = barSets.find((s) => (s.data.pos as number[])[0]! > center[0])!;
    expectVecClose(xBar.data.pos, [2 + len / 2, 4, 6]);
    expectVecClose(xBar.data.scale, [len, thick, thick]);
  });

  it('re-evaluates the view scale on every update (no stale freeze)', () => {
    const { editorEngine } = makeEditorEngine();
    let calls = 0;
    const pool = createGizmoPool({
      editorEngine,
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

  it('hides (spawns nothing) when the anchor is null', () => {
    const { editorEngine, sets } = makeEditorEngine();
    const pool = createGizmoPool({
      editorEngine,
      getAnchor: () => null,
      getGizmoMode: () => 'translate',
      getGizmoSpace: () => 'world',
      isAuxVisible: () => true,
      getViewScale: () => 10,
    });
    pool.update();
    expect(sets.length).toBe(0);
  });

  it('local space applies the anchor quaternion to the bars', () => {
    const { editorEngine, sets } = makeEditorEngine();
    // 90° around Z: [0, 0, sin45, cos45]
    const quat: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const pool = createGizmoPool({
      editorEngine,
      getAnchor: () => ({ center: [0, 0, 0], quat }),
      getGizmoMode: () => 'scale',
      getGizmoSpace: () => 'local',
      isAuxVisible: () => true,
      getViewScale: () => 10,
    });
    pool.update();
    const bars = sets.filter((s) => Array.isArray(s.data.quat));
    expect(bars.length).toBeGreaterThan(0);
    for (const b of bars) {
      expect(b.data.quat as number[]).toEqual([0, 0, Math.SQRT1_2, Math.SQRT1_2]);
    }
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
