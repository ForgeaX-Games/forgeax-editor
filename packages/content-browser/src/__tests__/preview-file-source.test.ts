import { describe, expect, it } from 'bun:test';
import { fileSupportsDualPreview } from '../preview-file-source';
import type { CBAsset, CBFile } from '../types';

const meshAsset: CBAsset = {
  type: 'asset',
  guid: '11111111-1111-4111-8111-111111111111',
  kind: 'mesh',
  name: 'model.glb',
  payload: {},
  packPath: 'assets/model.pack.json',
  packIndex: 0,
  refs: [],
};

function file(overrides: Partial<CBFile> & Pick<CBFile, 'family' | 'assets'>): CBFile {
  return {
    type: 'file',
    path: 'assets/example',
    diskPath: '/projects/demo/assets/example',
    name: 'example',
    isAssetPackage: overrides.assets.length > 1,
    kindLabel: 'File',
    isFavorite: false,
    ...overrides,
  };
}

describe('fileSupportsDualPreview', () => {
  it('enables source toggle for text-like catalog-backed files', () => {
    expect(fileSupportsDualPreview(file({ family: 'pack', assets: [meshAsset, meshAsset] }))).toBe(true);
    expect(fileSupportsDualPreview(file({ family: 'code', assets: [meshAsset] }))).toBe(true);
    expect(fileSupportsDualPreview(file({ family: 'config', assets: [meshAsset] }))).toBe(true);
  });

  it('keeps binary import packages on asset-list preview only', () => {
    expect(fileSupportsDualPreview(file({ family: 'model', assets: [meshAsset, meshAsset] }))).toBe(false);
    expect(fileSupportsDualPreview(file({ family: 'image', assets: [meshAsset] }))).toBe(false);
  });

  it('does not offer a toggle when there are no extracted assets', () => {
    expect(fileSupportsDualPreview(file({ family: 'code', assets: [] }))).toBe(false);
  });
});
