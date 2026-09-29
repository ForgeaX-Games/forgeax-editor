import { describe, expect, it } from 'bun:test';
import {
  fileSupportsDualPreview,
  isSourceViewableFileName,
  resolveBackingFile,
  resolveDualPreviewFile,
} from '../preview-file-source';
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

  it('treats standalone .pack.json files as source-viewable', () => {
    expect(fileSupportsDualPreview(file({
      family: 'other',
      name: 'IM_5.pack.json',
      assets: [meshAsset],
    }))).toBe(true);
  });
});

describe('isSourceViewableFileName', () => {
  it('recognizes pack, json, and code extensions', () => {
    expect(isSourceViewableFileName('foo.pack.json')).toBe(true);
    expect(isSourceViewableFileName('main.pack.ts')).toBe(true);
    expect(isSourceViewableFileName('config.json')).toBe(true);
    expect(isSourceViewableFileName('logic.ts')).toBe(true);
    expect(isSourceViewableFileName('model.glb')).toBe(false);
  });
});

describe('resolveDualPreviewFile', () => {
  const packFile = file({
    path: 'assets/IM_5.pack.json',
    name: 'IM_5.pack.json',
    family: 'pack',
    assets: [meshAsset],
  });

  it('returns the file row for a file selection', () => {
    expect(resolveDualPreviewFile(packFile, [packFile])).toBe(packFile);
  });

  it('returns the owning file for a promoted single-asset selection', () => {
    const asset: CBAsset = { ...meshAsset, packPath: 'assets/IM_5.pack.json' };
    expect(resolveBackingFile(asset, [packFile])).toBe(packFile);
    expect(resolveDualPreviewFile(asset, [packFile])).toBe(packFile);
  });
});
