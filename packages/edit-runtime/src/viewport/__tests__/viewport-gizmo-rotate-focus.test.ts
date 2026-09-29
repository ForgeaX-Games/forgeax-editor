import { describe, expect, it } from 'bun:test';
import { rotateGizmoVisibleRingIndices } from '../viewport-gizmo';

describe('rotateGizmoVisibleRingIndices', () => {
  it('shows all rings when not dragging an axis', () => {
    expect(rotateGizmoVisibleRingIndices(null)).toEqual([0, 1, 2]);
  });

  it('shows only the focused ring during axis drag', () => {
    expect(rotateGizmoVisibleRingIndices(1)).toEqual([1]);
    expect(rotateGizmoVisibleRingIndices(0)).toEqual([0]);
    expect(rotateGizmoVisibleRingIndices(2)).toEqual([2]);
  });

  it('falls back to all rings for invalid indices', () => {
    expect(rotateGizmoVisibleRingIndices(-1)).toEqual([0, 1, 2]);
    expect(rotateGizmoVisibleRingIndices(9)).toEqual([0, 1, 2]);
  });
});
