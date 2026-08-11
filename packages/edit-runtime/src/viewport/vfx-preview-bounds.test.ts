import { describe, expect, test } from 'bun:test';
import type { VfxGpuEmitterProgram } from '@forgeax/engine-vfx';
import { deriveVfxPreviewBounds, drawVfxPreviewBounds } from './vfx-preview-bounds';

type PreviewEmitter = Pick<VfxGpuEmitterProgram, 'id' | 'bounds'>;

const emitters = [
  { id: 'sphere', bounds: { kind: 'sphere', center: [2, 0, 0], radius: 2 } },
  { id: 'box', bounds: { kind: 'aabb', min: [-4, -1, -1], max: [-2, 3, 1] } },
] as const satisfies readonly PreviewEmitter[];

describe('VFX preview authored bounds projection', () => {
  test('fits one sphere around mixed Engine sphere and AABB bounds', () => {
    expect(deriveVfxPreviewBounds([])).toBeUndefined();
    expect(deriveVfxPreviewBounds(emitters)).toEqual({
      min: [-4, -2, -2],
      max: [4, 3, 2],
      center: [0, 0.5, 0],
      radius: Math.hypot(4, 2.5, 1),
    });
  });

  test('draws one system bound and adds the exact shape only for an isolated emitter', () => {
    const systemBounds = deriveVfxPreviewBounds(emitters)!;
    const calls: unknown[] = [];
    drawVfxPreviewBounds({
      aabb: (min, max, color) => { calls.push(['aabb', [...min], [...max], color]); },
      sphere: (center, radius, color) => { calls.push(['sphere', [...center], radius, color]); },
    }, emitters, new Set(['sphere', 'box']), systemBounds);

    expect(calls).toEqual([
      ['aabb', [-4, -2, -2], [4, 3, 2], [0.22, 0.72, 1, 0.92]],
    ]);

    calls.length = 0;
    drawVfxPreviewBounds({
      aabb: (min, max, color) => { calls.push(['aabb', [...min], [...max], color]); },
      sphere: (center, radius, color) => { calls.push(['sphere', [...center], radius, color]); },
    }, emitters, new Set(['box']), systemBounds);
    expect(calls).toEqual([
      ['aabb', [-4, -1, -1], [-2, 3, 1], [0.22, 0.72, 1, 0.92]],
    ]);
  });
});
