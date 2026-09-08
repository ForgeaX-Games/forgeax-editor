import { describe, expect, test } from 'bun:test';
import type { ContentBrowserRevealTarget } from '@forgeax/interface/core/app-shell/types';
import type { CBAsset, CBFile } from '../types';
import {
  findOwningDiskFile,
  resolveContentBrowserReveal,
  type ResolveContentBrowserRevealContext,
} from '../resolve-content-browser-reveal';

const ROOTS = [{ root: 'assets', catalogPrefix: 'assets' }] as const;
const SLUG = 'demo';

function meshAsset(guid: string, overrides: Partial<CBAsset> = {}): CBAsset {
  return {
    type: 'asset',
    guid,
    kind: 'mesh',
    name: 'Mesh',
    payload: {},
    packPath: 'assets/Fox.glb.meta.json',
    sourcePath: 'assets/Fox.glb',
    packIndex: 0,
    refs: [],
    ...overrides,
  };
}

function glbFile(assets: CBAsset[]): CBFile {
  return {
    type: 'file',
    path: 'assets/Fox.glb',
    diskPath: '/games/demo/assets/Fox.glb',
    name: 'Fox.glb',
    family: 'model',
    assets,
    isAssetPackage: assets.length > 1,
    kindLabel: 'Model',
    isFavorite: false,
  };
}

function ctx(overrides: Partial<ResolveContentBrowserRevealContext> = {}): ResolveContentBrowserRevealContext {
  return {
    relByAssetGuid: new Map(),
    diskFiles: [],
    allAssets: [],
    gameSlug: SLUG,
    catalogAssetRoots: ROOTS,
    ...overrides,
  };
}

describe('resolveContentBrowserReveal', () => {
  test('file path targets scroll the file card', () => {
    const target: ContentBrowserRevealTarget = { path: 'assets/scenes/level.scene', pathKind: 'file' };
    const resolved = resolveContentBrowserReveal(target, ctx());
    expect(resolved).toEqual({
      dir: 'assets/scenes',
      selector: '[data-file-path="assets/scenes/level.scene"]',
      folderSelection: { path: 'assets/scenes/level.scene', kind: 'file' },
    });
  });

  test('unpacked resource-group members expand the owning source file', () => {
    const mesh = meshAsset('mesh-guid');
    const material = meshAsset('mat-guid', { kind: 'material', name: 'Mat', guid: 'mat-guid' });
    const file = glbFile([mesh, material]);
    const target: ContentBrowserRevealTarget = { guid: 'mesh-guid', assetKind: 'mesh', name: 'Mesh' };
    const resolved = resolveContentBrowserReveal(target, ctx({
      diskFiles: [file],
      allAssets: [mesh, material],
      relByAssetGuid: new Map([['mesh-guid', 'assets/Fox.glb.meta.json']]),
    }));
    expect(resolved).toEqual({
      dir: 'assets',
      selector: '[data-asset-guid="mesh-guid"]',
      expandPackPath: 'assets/Fox.glb',
    });
  });

  test('single-member imports promote the asset without expansion', () => {
    const scene = meshAsset('scene-guid', { kind: 'scene', name: 'Level' });
    const file = glbFile([scene]);
    const resolved = resolveContentBrowserReveal({ guid: 'scene-guid' }, ctx({
      diskFiles: [file],
      allAssets: [scene],
    }));
    expect(resolved).toEqual({
      dir: 'assets',
      selector: '[data-asset-guid="scene-guid"]',
    });
  });

  test('registry-only assets fall back to catalog rel / sourcePath hints', () => {
    const asset = meshAsset('orphan-guid', { sourcePath: undefined, packPath: 'assets/orphan.pack.json' });
    const resolved = resolveContentBrowserReveal(
      { guid: 'orphan-guid', packPath: 'assets/orphan.pack.json' },
      ctx({
        allAssets: [asset],
        relByAssetGuid: new Map([['orphan-guid', 'assets/orphan.pack.json']]),
      }),
    );
    expect(resolved).toEqual({
      dir: 'assets',
      selector: '[data-asset-guid="orphan-guid"]',
    });
  });
});

describe('findOwningDiskFile', () => {
  test('returns the disk file that owns the guid', () => {
    const mesh = meshAsset('mesh-guid');
    const file = glbFile([mesh]);
    expect(findOwningDiskFile([file], 'mesh-guid')).toBe(file);
    expect(findOwningDiskFile([file], 'missing')).toBeUndefined();
  });
});
