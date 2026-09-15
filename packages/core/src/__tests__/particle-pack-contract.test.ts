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

interface TriggerCookCall {
  readonly guid: string;
  readonly mode: 'rebuild' | 'cold-cook';
}

/** Build a DocApplierCtx stub whose assetIO records createAssetInPack +
 *  triggerCook calls. `cookOk` toggles whether the scoped engine cook succeeds —
 *  the create must stay ok (the write landed) either way, matching the dev
 *  watcher contract. */
function makeCtxStub(cookOk: boolean): {
  readonly ctx: { assetIO: object };
  readonly createCalls: CapturedCreate[];
  readonly cookCalls: TriggerCookCall[];
} {
  const createCalls: CapturedCreate[] = [];
  const cookCalls: TriggerCookCall[] = [];
  const assetIO = {
    createAssetInPack(options: CapturedCreate): Promise<{ ok: true }> {
      createCalls.push(options);
      return Promise.resolve({ ok: true });
    },
    triggerCook(
      guid: string,
      _signal: AbortSignal | undefined,
      mode: 'rebuild' | 'cold-cook' = 'rebuild',
    ): Promise<{ ok: true } | { ok: false; error: { hint: string } }> {
      cookCalls.push({ guid, mode });
      return Promise.resolve(
        cookOk
          ? { ok: true }
          : { ok: false, error: { hint: 'no active runtime asset binding' } },
      );
    },
  };
  return { ctx: { assetIO }, createCalls, cookCalls };
}

describe('particle-effect Pack authoring contract', () => {
  test('createAsset produces engine-valid authored source plus its material', async () => {
    const { ctx, createCalls, cookCalls } = makeCtxStub(true);
    const result = applyCreateAsset(ctx as never, {
      kind: 'createAsset',
      packPath: 'assets/vfx/particle-effects.pack.json',
      guid: '019f56f2-0ac0-776a-9d28-50eb5a9edf01',
      assetKind: 'particle-effect',
      name: 'New Particle',
      refs: [],
    } as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(createCalls.length).toBe(1);
    const request = createCalls[0] as unknown as CapturedCreate;
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

    // The authored source is execution:'cooked' — the create completion must
    // trigger the scoped engine cook so the packaged editor (no vite watcher)
    // can load the baked VfxGpuEffectAsset instead of the raw authored source.
    await result.completion;
    expect(cookCalls).toEqual([
      { guid: '019f56f2-0ac0-776a-9d28-50eb5a9edf01', mode: 'rebuild' },
    ]);
  });

  test('createAsset completion stays ok when the scoped cook fails (write landed)', async () => {
    const { ctx, cookCalls } = makeCtxStub(false);
    const result = applyCreateAsset(ctx as never, {
      kind: 'createAsset',
      packPath: 'assets/vfx/particle-effects.pack.json',
      guid: '019f56f2-0ac0-776a-9d28-50eb5a9edf02',
      assetKind: 'particle-effect',
      name: 'New Particle',
      refs: [],
    } as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The cook is attempted (the write succeeded); a failed cook must not flip
    // the create to failure — the authored source is on disk and a manual
    // recook can recover it, matching the dev watcher's leave-on-disk behaviour.
    await result.completion;
    expect(cookCalls).toEqual([
      { guid: '019f56f2-0ac0-776a-9d28-50eb5a9edf02', mode: 'rebuild' },
    ]);
    await expect(result.completion).resolves.toMatchObject({ ok: true });
  });
});
