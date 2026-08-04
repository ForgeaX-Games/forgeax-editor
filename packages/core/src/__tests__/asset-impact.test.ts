import { describe, expect, it } from 'bun:test';
import { deriveAssetImpact, type AssetImpactCatalogRow } from '../io/asset-impact';

const MATERIAL = 'material-1';
const SCENE_A = 'scene-a';
const SCENE_B = 'scene-b';
const SOURCE_MESH = 'mesh-source';

function row(guid: string, fields: Partial<AssetImpactCatalogRow> = {}): AssetImpactCatalogRow {
  return { guid, kind: 'asset', packageUrl: `${guid}.pack.json`, ...fields };
}

describe('asset impact read projection', () => {
  it('derives cross-scene direct and transitive referencers from producer relations', () => {
    const catalog = [
      row(MATERIAL, { kind: 'material', name: 'Shared Material' }),
      row(SCENE_A, {
        kind: 'scene',
        relations: [{
          from: { type: 'asset', id: SCENE_A },
          to: { type: 'asset', id: MATERIAL },
          type: 'references',
          provenance: { provider: 'pack', version: '2.0.0' },
        }],
      }),
      row(SCENE_B, {
        kind: 'scene',
        relations: [{
          from: { type: 'asset', id: SCENE_B },
          to: { type: 'asset', id: MATERIAL },
          type: 'references',
          provenance: { provider: 'pack', version: '2.0.0' },
        }],
      }),
    ];

    const impact = deriveAssetImpact(catalog, { operation: 'delete', guid: MATERIAL });

    expect(impact.resolution).toBe('resolved');
    expect(impact.targets.map((asset) => asset.guid)).toEqual([MATERIAL]);
    expect(impact.directReferencers.map((asset) => asset.guid)).toEqual([SCENE_A, SCENE_B]);
    expect(impact.transitiveReferencers).toEqual([]);
    expect(impact.blocking).toBe(true);
    expect(impact.confirmation.required).toBe(true);
    expect(impact.edges).toHaveLength(2);
    expect(impact.edges.every((edge) => edge.source === 'producer-relation')).toBe(true);
  });

  it('matches all outputs of a source path for reimport and walks transitive impact', () => {
    const catalog = [
      row(SOURCE_MESH, { kind: 'mesh', sourcePath: 'models/hero.glb' }),
      row('material-hero', {
        kind: 'material',
        sourcePath: 'models/hero.glb',
        refs: [SOURCE_MESH],
      }),
      row(SCENE_A, { kind: 'scene', refs: ['material-hero'] }),
    ];

    const impact = deriveAssetImpact(catalog, { operation: 'reimport', sourcePath: 'models/hero.glb' });

    expect(impact.targets.map((asset) => asset.guid)).toEqual(['material-hero', SOURCE_MESH]);
    expect(impact.directReferencers.map((asset) => asset.guid)).toEqual([SCENE_A]);
    expect(impact.transitiveReferencers).toEqual([]);
    expect(impact.blocking).toBe(false);
    expect(impact.confirmation.required).toBe(false);
    expect(impact.edges.every((edge) => edge.source === 'legacy-refs')).toBe(true);
  });

  it('uses producer relations instead of stale refs and rejects ambiguous selectors', () => {
    const catalog = [
      row(MATERIAL),
      row(SCENE_A, {
        refs: ['stale-target'],
        relations: [{
          from: { type: 'asset', id: SCENE_A },
          to: { type: 'asset', id: MATERIAL },
          type: 'depends-on',
          provenance: { provider: 'pack', version: '2.0.0' },
        }],
      }),
    ];

    const producerImpact = deriveAssetImpact(catalog, { operation: 'delete', guid: MATERIAL });
    expect(producerImpact.directReferencers.map((asset) => asset.guid)).toEqual([SCENE_A]);
    expect(producerImpact.edges.map((edge) => edge.to)).toEqual([MATERIAL]);

    expect(deriveAssetImpact(catalog, { operation: 'delete' })).toMatchObject({ resolution: 'invalid-selector' });
    expect(deriveAssetImpact(catalog, {
      operation: 'delete',
      guid: MATERIAL,
      sourcePath: 'models/hero.glb',
    })).toMatchObject({ resolution: 'invalid-selector' });
    expect(deriveAssetImpact(catalog, { operation: 'move', guid: 'missing' })).toMatchObject({ resolution: 'not-found' });
  });
});
