import { describe, expect, it } from 'bun:test';

import { queryCompatibleAssetCatalog } from '../assets/compatible-asset-catalog';

const particleAuthoring = {
  placement: { operation: 'spawnEntity' as const },
  binding: {
    operation: 'bindAssetRef' as const,
    target: {
      component: 'ParticleEffectPlayer',
      field: 'effect',
      assetType: 'ParticleEffectAsset',
      cardinality: 'single' as const,
    },
    requiredSlots: 1,
  },
} as const;

const rows = [
  { guid: 'particle-guid', kind: 'particle-effect', packageUrl: 'particle.pack', authoring: particleAuthoring },
  { guid: 'mesh-guid', kind: 'mesh', packageUrl: 'mesh.pack', authoring: {
    placement: { operation: 'spawnEntity' as const },
    binding: { operation: 'bindAssetRef' as const, target: { component: 'MeshRenderer', field: 'mesh', assetType: 'MeshAsset', cardinality: 'single' as const }, requiredSlots: 1 },
  } as const },
  { guid: 'audio-guid', kind: 'audio', packageUrl: 'audio.pack', authoring: {
    placement: { operation: 'spawnEntity' as const },
    binding: { operation: 'bindAssetRef' as const, target: { component: 'AudioSource', field: 'clip', assetType: 'AudioClipAsset', cardinality: 'single' as const }, requiredSlots: 1 },
  } as const },
  { guid: 'legacy-guid', kind: 'audio', packageUrl: 'legacy.pack' },
] as const;

describe('compatible asset catalog projection', () => {
  it('derives the particle collection from the producer assetType token', () => {
    const result = queryCompatibleAssetCatalog(rows, 'ParticleEffectAsset');
    expect(result).toEqual({ ok: true, assets: [rows[0]] });
  });

  it('returns a structured failure for an unknown compatibility token', () => {
    const result = queryCompatibleAssetCatalog(rows, 'UnknownAssetToken');
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'asset-compatibility-token-unknown',
        expected: 'producer authoring binding target assetType',
        actual: 'UnknownAssetToken',
        hint: expect.stringContaining("describeComponent('ParticleEffectPlayer')"),
        retryable: false,
      },
    });
  });

  it('does not treat legacy rows without producer capability as compatible', () => {
    const result = queryCompatibleAssetCatalog(rows, 'AudioClipAsset');
    expect(result).toEqual({ ok: true, assets: [rows[2]] });
  });
});
