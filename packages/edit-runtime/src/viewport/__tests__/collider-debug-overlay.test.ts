// collider-debug-overlay.test.ts — injected editor chrome behavior for solo P7 round-31.
//
// The existing engine DebugDraw owns rendering/flush. This locks the editor
// bridge: selected Collider + Transform is read from the world SSOT once per
// frame; all non-applicable states are genuine no-ops.

import { describe, expect, it } from 'bun:test';
import type { DebugDraw } from '@forgeax/engine-debug-draw';
import type { ColorLike, Vec3 } from '@forgeax/engine-math';

import { installColliderDebugOverlay } from '../collider-debug-overlay';

type Line = {
  readonly from: Vec3;
  readonly to: Vec3;
  readonly color: readonly number[];
};

function makeHarness() {
  let frame: ((dt: number) => void) | undefined;
  let selection: number | null = 7;
  let visible = true;
  let editMode = true;
  let components: Record<string, unknown> | undefined = {
    Collider: { shape: 0, halfExtents: [2, 1, 0.5], isSensor: false },
    Transform: { world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 2, -3, 1] },
  };
  const lines: Line[] = [];
  const app = {
    debugDraw: {
      line(from: Vec3, to: Vec3, color: ColorLike) {
        lines.push({ from, to, color: Array.from(color) });
      },
    } satisfies Pick<DebugDraw, 'line'>,
    registerUpdate(fn: (dt: number) => void) { frame = fn; },
  };
  installColliderDebugOverlay({
    app,
    getSelection: () => selection as never,
    getEntityComponents: () => components,
    isAuxVisible: () => visible,
    isEditMode: () => editMode,
  });
  return {
    lines,
    tick: () => frame?.(1 / 60),
    setSelection: (value: number | null) => { selection = value; },
    setVisible: (value: boolean) => { visible = value; },
    setEditMode: (value: boolean) => { editMode = value; },
    setComponents: (value: Record<string, unknown> | undefined) => { components = value; },
  };
}

describe('installColliderDebugOverlay', () => {
  it('emits selected Collider geometry in sensor-aware color without a world write', () => {
    const h = makeHarness();
    h.tick();
    expect(h.lines).toHaveLength(12);
    expect(Array.from(h.lines[0]!.from)).toEqual([2, 1, -3.5]);
    expect(Array.from(h.lines[0]!.to)).toEqual([6, 1, -3.5]);
    expect(h.lines[0]!.color).toEqual([0.2, 0.75, 1, 1]);

    h.lines.length = 0;
    h.setComponents({
      Collider: { shape: 1, radius: 1, isSensor: true },
      Transform: { world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 2, -3, 1] },
    });
    h.tick();
    expect(h.lines).toHaveLength(48);
    expect(h.lines[0]?.color).toEqual([1, 0.62, 0.18, 1]);
  });

  it('is a no-op with no selection, no Collider, stale/missing data, or hidden auxiliary display', () => {
    const h = makeHarness();
    h.setSelection(null); h.tick();
    expect(h.lines).toHaveLength(0);

    h.setSelection(7); h.setComponents({ Transform: { world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } }); h.tick();
    expect(h.lines).toHaveLength(0);

    h.setComponents(undefined); h.tick();
    expect(h.lines).toHaveLength(0);

    h.setComponents({
      Collider: { shape: 0, halfExtents: [1, 1, 1] },
      Transform: { world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    });
    h.setVisible(false); h.tick();
    expect(h.lines).toHaveLength(0);

    h.setVisible(true); h.setEditMode(false); h.tick();
    expect(h.lines).toHaveLength(0);
  });

  it('does not require DebugDraw to exist in an editor app', () => {
    let frame: ((dt: number) => void) | undefined;
    expect(() => installColliderDebugOverlay({
      app: { registerUpdate(fn) { frame = fn; } },
      getSelection: () => 1 as never,
      getEntityComponents: () => ({ Collider: {}, Transform: {} }),
      isAuxVisible: () => true,
      isEditMode: () => true,
    })).not.toThrow();
    expect(() => frame?.(1 / 60)).not.toThrow();
  });
});
