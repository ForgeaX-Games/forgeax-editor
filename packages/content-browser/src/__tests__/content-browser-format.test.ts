import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { authoringCapabilityForAssetKind } from '@forgeax/engine-types';
import { setPathResolver } from '@forgeax/editor-core';
import type { CBAsset, CBFile, CBFolder, CBViewItem } from '../types';
import {
  dirOfPath,
  fileFamilyOf,
  fileFamilyOfWithAssets,
  fileKindLabel,
  fileSpecificMenuItems,
  importDirectoryForViewItem,
  isAbsoluteHostPath,
  isAssetPlacementAvailable,
  isPathInSelectionChain,
  menuIconForId,
  normalizeGameRelativePath,
  orderContextMenuEntries,
  registryEntryToCBAsset,
  resolveCopyPath,
  sourcePathForViewItem,
  viewItemKey,
  viewItemPath,
  type CBContextMenuEntry,
  type RegistryCatalogEntry,
} from '../content-browser-format';

const t = ((key: string) => key) as never;

const asset: CBAsset = {
  type: 'asset',
  guid: 'guid-1',
  kind: 'texture',
  name: 'Tex',
  payload: {},
  packPath: 'assets/tex.pack.json',
  packIndex: 0,
  refs: [],
};
const folder: CBFolder = {
  type: 'folder',
  path: 'assets/models',
  name: 'models',
  isFavorite: false,
  childCount: 0,
};
const file: CBFile = {
  type: 'file',
  path: 'assets/readme.md',
  diskPath: '/g/assets/readme.md',
  name: 'readme.md',
  family: 'doc',
  assets: [],
  kindLabel: 'Document',
  isFavorite: false,
};

test('scene default menu projects the Gateway scene read model', () => {
  const target = fileSpecificMenuItems(t, { family: 'scene' }, undefined, {
    sceneGuid: 'guid-lvl2',
    defaultSceneGuid: 'guid-lvl1',
  }).find((item) => item.id === 'set-default-scene');
  expect(target?.disabled).toBe(false);

  const current = fileSpecificMenuItems(t, { family: 'scene' }, undefined, {
    sceneGuid: 'guid-lvl1',
    defaultSceneGuid: 'guid-lvl1',
  }).find((item) => item.id === 'set-default-scene');
  expect(current?.disabled).toBe(true);
});

describe('path helpers', () => {
  test('dirOfPath returns the parent directory or empty for a bare name', () => {
    expect(dirOfPath('assets/models/hero.glb')).toBe('assets/models');
    expect(dirOfPath('hero.glb')).toBe('');
  });

  test('isAbsoluteHostPath recognizes drive, posix, and UNC roots', () => {
    expect(isAbsoluteHostPath('C:/games/demo')).toBe(true);
    expect(isAbsoluteHostPath('C:\\games\\demo')).toBe(true);
    expect(isAbsoluteHostPath('/var/games/demo')).toBe(true);
    expect(isAbsoluteHostPath('\\\\host\\share')).toBe(true);
    expect(isAbsoluteHostPath('assets/logo.png')).toBe(false);
  });

  test('normalizeGameRelativePath strips root, slug, and .forgeax marker prefixes', () => {
    expect(normalizeGameRelativePath('root/assets/a.png', 'root', 'demo')).toBe('assets/a.png');
    expect(normalizeGameRelativePath('root', 'root', 'demo')).toBe('');
    expect(normalizeGameRelativePath('\\root\\assets\\a.png', '/root/', 'demo')).toBe('assets/a.png');
    expect(normalizeGameRelativePath('.forgeax/games/demo/scenes/x.pack.json', '', 'demo')).toBe('scenes/x.pack.json');
    expect(normalizeGameRelativePath('demo/assets/a.png', '', 'demo')).toBe('assets/a.png');
    expect(normalizeGameRelativePath('demo', '', 'demo')).toBe('');
    expect(normalizeGameRelativePath('loose/a.png', '', 'demo')).toBe('loose/a.png');
  });
});

describe('resolveCopyPath (host resolver seam)', () => {
  beforeAll(() => setPathResolver((rel) => (rel === '' ? '/g' : `/g/${rel}`)));
  afterAll(() => setPathResolver(null));

  test('absolute host paths pass through untouched; relative paths resolve through the game root', () => {
    expect(resolveCopyPath('/abs/logo.png')).toBe('/abs/logo.png');
    expect(resolveCopyPath('assets/logo.png')).toBe('/g/assets/logo.png');
  });
});

describe('view-item projections', () => {
  test('viewItemPath returns packPath for assets, path for folders/files, null for nothing', () => {
    expect(viewItemPath(null)).toBeNull();
    expect(viewItemPath(asset as CBViewItem)).toBe('assets/tex.pack.json');
    expect(viewItemPath(folder as CBViewItem)).toBe('assets/models');
    expect(viewItemPath(file as CBViewItem)).toBe('assets/readme.md');
  });

  test('viewItemKey keys assets by guid and everything else by path', () => {
    expect(viewItemKey(asset as CBViewItem)).toBe('guid-1');
    expect(viewItemKey(folder as CBViewItem)).toBe('assets/models');
    expect(viewItemKey(file as CBViewItem)).toBe('assets/readme.md');
  });

  test('source paths keep the asset source location separate from its pack path', () => {
    expect(sourcePathForViewItem(asset, 'assets/hello/hero.glb')).toBe('assets/hello/hero.glb');
    expect(sourcePathForViewItem(asset)).toBe('assets/tex.pack.json');
    expect(sourcePathForViewItem(folder)).toBe('assets/models');
    expect(sourcePathForViewItem(file)).toBe('assets/readme.md');
  });

  test('selection paths include ancestors while excluding siblings', () => {
    expect(isPathInSelectionChain('assets/hello/hero.glb', '')).toBe(true);
    expect(isPathInSelectionChain('assets/hello/hero.glb', 'assets')).toBe(true);
    expect(isPathInSelectionChain('assets/hello/hero.glb', 'assets/hello')).toBe(true);
    expect(isPathInSelectionChain('assets/hello/hero.glb', 'assets/world')).toBe(false);
  });

  test('import destination uses the selected folder or the selected item parent', () => {
    expect(importDirectoryForViewItem(folder)).toBe('assets/models');
    expect(importDirectoryForViewItem(file)).toBe('assets');
    expect(importDirectoryForViewItem(asset, 'assets/hello/hero.glb')).toBe('assets/hello');
    expect(importDirectoryForViewItem(asset)).toBe('assets');
    expect(importDirectoryForViewItem(null, null, 'assets/current')).toBe('assets/current');
  });
});

describe('isAssetPlacementAvailable', () => {
  test('derives availability from the engine capability and honors an explicit authoring override', () => {
    // Placeable kind vs a kind the engine reports as unavailable for placement.
    expect(isAssetPlacementAvailable({ kind: 'texture' })).toBe(true);
    expect(isAssetPlacementAvailable({ kind: 'script' })).toBe(false);
    // An explicit authoring capability overrides the kind-derived fallback.
    expect(isAssetPlacementAvailable({ kind: 'script', authoring: authoringCapabilityForAssetKind('texture') })).toBe(true);
  });
});

describe('fileFamilyOf classification', () => {
  test('classifies by suffix and extension across every family', () => {
    expect(fileFamilyOf('Level.meta.json')).toBe('meta');
    expect(fileFamilyOf('Materials.pack.json')).toBe('pack');
    expect(fileFamilyOf('level1.scene.pack.json')).toBe('scene');
    expect(fileFamilyOf('main.scene.json')).toBe('scene');
    expect(fileFamilyOf('scene.json')).toBe('scene');
    expect(fileFamilyOf('ground.colliders.json')).toBe('data');
    expect(fileFamilyOf('plugin.ts')).toBe('code');
    expect(fileFamilyOf('bun.lock')).toBe('config');
    expect(fileFamilyOf('README.md')).toBe('doc');
    expect(fileFamilyOf('hero.png')).toBe('image');
    expect(fileFamilyOf('shot.wav')).toBe('audio');
    expect(fileFamilyOf('hero.glb')).toBe('model');
    expect(fileFamilyOf('Inter.ttf')).toBe('font');
    expect(fileFamilyOf('unknown.xyz')).toBe('other');
  });

  test('fileFamilyOfWithAssets promotes any scene-bearing pack to scene', () => {
    expect(fileFamilyOfWithAssets('bundle.pack.json', [{ kind: 'scene' }])).toBe('scene');
    expect(fileFamilyOfWithAssets('bundle.pack.json', [{ kind: 'texture' }])).toBe('pack');
  });
});

describe('fileKindLabel', () => {
  const families: import('../types').CBFileFamily[] = [
    'code', 'config', 'doc', 'scene', 'pack', 'meta', 'image', 'audio', 'model', 'font', 'ui', 'data', 'other',
  ];

  test('translates every family through the provided t function', () => {
    for (const family of families) {
      expect(fileKindLabel(t, family)).toBe(`editor.contentBrowser.fileKinds.${family}`);
    }
  });

  test('falls back to the built-in English label without a translator', () => {
    expect(fileKindLabel('scene')).toBe('Scene');
    expect(fileKindLabel(undefined, 'ui')).toBe('UI Asset');
    expect(fileKindLabel(undefined)).toBe('File');
  });
});

describe('context-menu shaping', () => {
  test('orderContextMenuEntries groups title/normal/forge/danger with separators', () => {
    const entries: CBContextMenuEntry[] = [
      { title: 'Header' },
      { sep: true },
      { label: 'Open' },
      { label: 'Ask Forge', forge: true },
      { label: 'Delete', danger: true },
    ];
    const ordered = orderContextMenuEntries(entries);
    const shape = ordered.map((entry) => entry.title ?? entry.label ?? '—');
    expect(shape).toEqual(['Header', 'Open', '—', 'Ask Forge', '—', 'Delete']);

    // Only a title + danger: no leading separator before danger since there are no normals.
    const titleAndDanger = orderContextMenuEntries([{ title: 'H' }, { label: 'Del', danger: true }]);
    expect(titleAndDanger.map((e) => e.title ?? e.label)).toEqual(['H', 'Del']);
  });

  test('menuIconForId maps known ids and defaults unknown ids to file', () => {
    expect(menuIconForId('open')).toBe('folder');
    expect(menuIconForId('new-folder')).toBe('folder-plus');
    expect(menuIconForId('rename')).toBe('pencil');
    expect(menuIconForId('duplicate')).toBe('copy');
    expect(menuIconForId('delete')).toBe('trash-2');
    expect(menuIconForId('copy-guid')).toBe('hash');
    expect(menuIconForId('copy-path')).toBe('copy');
    expect(menuIconForId('add-to-scene')).toBe('box');
    expect(menuIconForId('assign')).toBe('crosshair');
    expect(menuIconForId('add-with-deps')).toBe('spark');
    expect(menuIconForId('toggle-fav')).toBe('star');
    expect(menuIconForId('mystery')).toBe('file');
  });

  test('fileSpecificMenuItems returns family-specific actions for every family', () => {
    const idsFor = (family: import('../types').CBFileFamily, firstAsset?: { sourcePath?: string }) =>
      fileSpecificMenuItems(t, { family }, firstAsset).map((item) => item.id);

    expect(idsFor('doc')).toContain('render-preview');
    expect(idsFor('code')).toContain('open-external-ide');
    expect(idsFor('pack', { sourcePath: 'assets/a.glb' })).toContain('reimport');
    expect(idsFor('pack')).toContain('expand-sub-assets');
    expect(idsFor('meta')).toContain('locate-source-file');
    expect(idsFor('model')).toContain('generate-meta');
    expect(idsFor('image')).toContain('set-as-icon');
    expect(idsFor('audio')).toContain('audition');
    expect(idsFor('font')).toContain('import-as-font');
    expect(idsFor('data')).toContain('visualize-in-scene');
    expect(idsFor('other')).toEqual([]);

    // reimport is disabled when the first asset carries no source path.
    const reimport = fileSpecificMenuItems(t, { family: 'pack' }, undefined).find((i) => i.id === 'reimport');
    expect(reimport?.disabled).toBe(true);
  });
});

describe('registryEntryToCBAsset', () => {
  test('projects a full catalog entry, preferring the writable source path', () => {
    const entry: RegistryCatalogEntry = {
      guid: '01890000-0000-7000-8000-000000000abc',
      kind: 'material',
      name: 'Steel',
      packageUrl: '/preview/games/demo/assets/Materials.pack.json',
      sourcePath: 'assets/Materials.pack.json',
      sourceKey: 'src-key',
      revision: 'rev-1',
      metaRevision: 'meta-1',
      refs: ['ref-a', 'ref-b'],
    };
    const projected = registryEntryToCBAsset(entry, 3);
    expect(projected).toMatchObject({
      type: 'asset',
      guid: entry.guid,
      kind: 'material',
      name: 'Steel',
      packPath: 'assets/Materials.pack.json',
      sourcePath: 'assets/Materials.pack.json',
      sourceKey: 'src-key',
      revision: 'rev-1',
      metaRevision: 'meta-1',
      packIndex: 3,
    });
    expect(projected.refs).toEqual(['ref-a', 'ref-b']);
    // refs are copied, not aliased to the entry's array.
    expect(projected.refs).not.toBe(entry.refs);
  });

  test('falls back to the packageUrl and derives a short name when the entry is minimal', () => {
    const entry: RegistryCatalogEntry = {
      guid: 'deadbeef-cafe-7000-8000-000000000000',
      kind: 'texture',
      packageUrl: 'http://assets/host/only.bin',
    };
    const projected = registryEntryToCBAsset(entry, 0);
    expect(projected.packPath).toBe('http://assets/host/only.bin');
    expect(projected.name).toBe('deadbeef');
    expect(projected.refs).toEqual([]);
    expect(projected.sourcePath).toBeUndefined();
  });
});
