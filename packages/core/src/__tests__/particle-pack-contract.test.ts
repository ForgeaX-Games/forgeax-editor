import { describe, expect, test } from 'bun:test';
import {
  parseParticleEffectSourceV2,
  PARTICLE_CODE_DEFAULT_MODULE_ID,
} from '@forgeax/engine-vfx';

import { applyCreateAsset } from '../session/pack-ops';

interface CapturedCreate {
  readonly packPath: string;
  readonly asset: {
    readonly guid: string;
    readonly kind: string;
    readonly name: string;
    readonly payload: Record<string, unknown>;
    readonly refs?: string[];
    readonly execution?: string;
  };
  readonly extraAssets?: readonly {
    readonly guid: string;
    readonly kind: string;
    readonly name: string;
    readonly payload: unknown;
  }[];
}

describe('particle-effect Pack authoring contract', () => {
  test('createAsset produces engine-valid authored source plus its material', () => {
    let captured: CapturedCreate | null = null;
    const result = applyCreateAsset({
      assetIO: {
        createAssetInPack(options: CapturedCreate) {
          captured = options;
          return Promise.resolve({ ok: true });
        },
      },
    } as never, {
      kind: 'createAsset',
      packPath: 'assets/vfx/particle-effects.pack.json',
      guid: '019f56f2-0ac0-776a-9d28-50eb5a9edf01',
      assetKind: 'particle-effect',
      name: 'New Particle',
      refs: [],
    } as never);

    expect(result.ok).toBe(true);
    expect(captured).not.toBeNull();
    const request = captured as unknown as CapturedCreate;
    expect(request.packPath).toBe('assets/vfx/particle-effects.pack.json');
    expect(request.asset).toMatchObject({
      guid: '019f56f2-0ac0-776a-9d28-50eb5a9edf01',
      kind: 'particle-effect',
      execution: 'cooked',
      refs: [],
    });

    const source = parseParticleEffectSourceV2(request.asset.payload);
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    const emitter = source.value.emitters[0];
    expect(emitter).toBeDefined();
    expect(emitter?.backend).toEqual({ required: 'gpu' });
    expect(emitter?.program.module).toBe(PARTICLE_CODE_DEFAULT_MODULE_ID);

    const materialGuid = emitter?.renderers[0]?.material;
    expect(materialGuid).toBeDefined();
    expect(request.extraAssets).toEqual([
      expect.objectContaining({ guid: materialGuid, kind: 'material' }),
    ]);
  });
});
