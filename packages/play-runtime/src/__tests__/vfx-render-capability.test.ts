import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { supportsVfxRenderFeature } from '../vfx-render-capability';

describe('Play VFX render capability gate', () => {
  it('only enables GPU particle rendering when both required caps exist', () => {
    expect(supportsVfxRenderFeature({ compute: true, indirectDrawing: true })).toBe(true);
    expect(supportsVfxRenderFeature({ compute: false, indirectDrawing: true })).toBe(false);
    expect(supportsVfxRenderFeature({ compute: true, indirectDrawing: false })).toBe(false);
    expect(supportsVfxRenderFeature(undefined)).toBe(false);
  });

  it('reads capabilities through the public renderer inspection contract', () => {
    const source = readFileSync(resolve(import.meta.dir, '../main.ts'), 'utf8');
    expect(source).toContain('supportsVfxRenderFeature(renderer.inspect().capabilities)');
    expect(source).not.toContain('supportsVfxRenderFeature(renderer.device.caps)');
    expect(source).toContain('const assets = app.value.assets');
    expect(source).not.toContain('renderer.assets');
    expect(source).not.toContain('renderer.installRenderFeature');
    expect(source).not.toContain('renderer.subscribeFrameEnd');
  });
});
