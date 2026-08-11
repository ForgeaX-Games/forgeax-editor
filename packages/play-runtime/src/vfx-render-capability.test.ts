import { describe, expect, it } from 'bun:test';
import { supportsVfxRenderFeature } from './vfx-render-capability';

describe('Play VFX render capability gate', () => {
  it('only enables GPU particle rendering when both required caps exist', () => {
    expect(supportsVfxRenderFeature({ compute: true, indirectDrawing: true })).toBe(true);
    expect(supportsVfxRenderFeature({ compute: false, indirectDrawing: true })).toBe(false);
    expect(supportsVfxRenderFeature({ compute: true, indirectDrawing: false })).toBe(false);
    expect(supportsVfxRenderFeature(undefined)).toBe(false);
  });
});
