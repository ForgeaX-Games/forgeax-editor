import { describe, expect, it } from 'bun:test';
import {
  BUILTIN_ASSET_KIND_FILTERS,
  buildKindFilters,
  formatAssetKindLabel,
} from './asset-kind-filters';
import type { CBAsset } from './types';

describe('asset kind filters', () => {
  it('covers the 15 current engine Asset kinds', () => {
    expect(Object.keys(BUILTIN_ASSET_KIND_FILTERS)).toHaveLength(15);
    expect(Object.keys(BUILTIN_ASSET_KIND_FILTERS)).toContain('equirect');
    expect(Object.keys(BUILTIN_ASSET_KIND_FILTERS)).toContain('video');
  });

  it('removes importer and retired names from All Types', () => {
    const ids = buildKindFilters().map(filter => filter.id);
    expect(ids).not.toContain('kind:image');
    expect(ids).not.toContain('kind:cube-texture');
    expect(ids).toContain('kind:equirect');
    expect(ids).toContain('kind:video');
  });

  it('adds de-duplicated custom catalog kinds with fallback presentation', () => {
    const filters = buildKindFilters(['mesh', 'voxel-field', 'custom_fx', 'voxel-field', '']);
    const customFx = filters.find(filter => filter.id === 'kind:custom_fx');
    const voxel = filters.find(filter => filter.id === 'kind:voxel-field');

    expect(filters.filter(filter => filter.id === 'kind:voxel-field')).toHaveLength(1);
    expect(customFx?.label).toBe('Custom Fx');
    expect(voxel?.label).toBe('Voxel Field');
    expect(voxel?.icon).toBe('◇');
  });

  it('custom filters match their catalog kind exactly', () => {
    const filter = buildKindFilters(['voxel-field'])
      .find(candidate => candidate.id === 'kind:voxel-field');

    expect(filter?.predicate({ kind: 'voxel-field' } as CBAsset)).toBe(true);
    expect(filter?.predicate({ kind: 'mesh' } as CBAsset)).toBe(false);
  });

  it('formats empty custom kinds defensively', () => {
    expect(formatAssetKindLabel('')).toBe('Unknown');
  });
});
