import { describe, expect, it } from 'bun:test';
import { deriveContentView, deriveFileView, collectProjectDirs, type ScopedAsset, type ProjectTreeNode } from './folder-view';
import type { CBAsset } from './types';

// ── Fixtures ─────────────────────────────────────────────────────────────────
// A scoped asset carries its game-relative `.pack.json` path (`rel`), exactly as
// ContentBrowser derives it from the engine registry `relativeUrl`. No new data
// format — folders are purely derived from these rels + packDirs.

let guidSeq = 0;
function mkAsset(rel: string): ScopedAsset {
  const guid = `guid-${guidSeq++}`;
  const asset: CBAsset = {
    type: 'asset',
    guid,
    kind: 'mesh',
    name: rel.split('/').pop()!,
    payload: {},
    packPath: `forgeax-games/hellforge/${rel}`,
    packIndex: 0,
    refs: [],
    estimatedSize: 0,
  };
  return { asset, rel };
}

// packDirs mirrors ContentBrowser: every ancestor dir that contains an asset,
// sorted. We compute it here from rels so the fixture stays honest.
function mkPackDirs(scoped: ScopedAsset[]): string[] {
  const dirs = new Set<string>();
  for (const { rel } of scoped) {
    const dir = rel.replace(/\/[^/]+$/, '');
    if (!dir || dir === rel) continue;
    let cur = dir;
    while (cur) {
      dirs.add(cur);
      const slash = cur.lastIndexOf('/');
      cur = slash > 0 ? cur.slice(0, slash) : '';
    }
  }
  return [...dirs].sort();
}

const SCOPED: ScopedAsset[] = [
  mkAsset('assets/sky.pack.json'),                    // direct child of assets/
  mkAsset('assets/ground.pack.json'),                 // direct child of assets/
  mkAsset('assets/characters/hero.pack.json'),        // under assets/characters
  mkAsset('assets/characters/enemy.pack.json'),       // under assets/characters
  mkAsset('assets/characters/boss/king.pack.json'),   // deeper: assets/characters/boss
  mkAsset('assets/props/barrel.pack.json'),           // under assets/props
];
const PACK_DIRS = mkPackDirs(SCOPED);

describe('deriveContentView — UE-parity folder + direct-asset view', () => {
  it('at "assets": shows immediate subfolders (characters, props) + only DIRECT assets (non-recursive)', () => {
    const { folders, assets } = deriveContentView({
      scopedAssets: SCOPED, packDirs: PACK_DIRS, currentPath: 'assets',
    });

    expect(folders.map(f => f.path)).toEqual(['assets/characters', 'assets/props']);
    expect(folders.every(f => f.type === 'folder')).toBe(true);

    // Only sky + ground sit directly in assets/ — hero/enemy/king/barrel are deeper.
    expect(assets.map(a => a.name).sort()).toEqual(['ground.pack.json', 'sky.pack.json']);
  });

  it('folders are sorted by name ascending', () => {
    const { folders } = deriveContentView({
      scopedAssets: SCOPED, packDirs: PACK_DIRS, currentPath: 'assets',
    });
    expect(folders.map(f => f.name)).toEqual(['characters', 'props']);
  });

  it('childCount is the RECURSIVE asset count under each folder', () => {
    const { folders } = deriveContentView({
      scopedAssets: SCOPED, packDirs: PACK_DIRS, currentPath: 'assets',
    });
    const chars = folders.find(f => f.path === 'assets/characters')!;
    const props = folders.find(f => f.path === 'assets/props')!;
    // characters = hero + enemy + boss/king = 3
    expect(chars.childCount).toBe(3);
    expect(props.childCount).toBe(1);
  });

  it('reflects favorites via isFavorite', () => {
    const { folders } = deriveContentView({
      scopedAssets: SCOPED, packDirs: PACK_DIRS, currentPath: 'assets',
      favorites: ['assets/props'],
    });
    expect(folders.find(f => f.path === 'assets/characters')!.isFavorite).toBe(false);
    expect(folders.find(f => f.path === 'assets/props')!.isFavorite).toBe(true);
  });

  it('at nested "assets/characters": shows subfolder (boss) + direct assets (hero, enemy)', () => {
    const { folders, assets } = deriveContentView({
      scopedAssets: SCOPED, packDirs: PACK_DIRS, currentPath: 'assets/characters',
    });
    expect(folders.map(f => f.path)).toEqual(['assets/characters/boss']);
    expect(assets.map(a => a.name).sort()).toEqual(['enemy.pack.json', 'hero.pack.json']);
  });

  it('at root (""): shows only the top-level folder(s), no deep assets leak in', () => {
    const { folders, assets } = deriveContentView({
      scopedAssets: SCOPED, packDirs: PACK_DIRS, currentPath: '',
    });
    expect(folders.map(f => f.path)).toEqual(['assets']);
    // Nothing sits at the game root directly in this fixture.
    expect(assets).toEqual([]);
  });

  it('leaf folder (no subfolders): folders empty, direct assets returned', () => {
    const { folders, assets } = deriveContentView({
      scopedAssets: SCOPED, packDirs: PACK_DIRS, currentPath: 'assets/props',
    });
    expect(folders).toEqual([]);
    expect(assets.map(a => a.name)).toEqual(['barrel.pack.json']);
  });

  it('empty catalog → empty folders and assets', () => {
    const { folders, assets } = deriveContentView({
      scopedAssets: [], packDirs: [], currentPath: '',
    });
    expect(folders).toEqual([]);
    expect(assets).toEqual([]);
  });
});

// ── deriveFileView ──────────────────────────────────────────────────────────

const PROJECT_TREE: ProjectTreeNode[] = [
  {
    name: 'assets', path: 'assets', type: 'dir', children: [
      { name: 'scenes', path: 'assets/scenes', type: 'dir', children: [
        { name: 'main.pack.json', path: 'assets/scenes/main.pack.json', type: 'file', size: 1024 },
      ] },
      { name: 'sky.hdr', path: 'assets/sky.hdr', type: 'file', size: 4096 },
    ],
  },
  {
    name: 'src', path: 'src', type: 'dir', children: [
      { name: 'systems', path: 'src/systems', type: 'dir', children: [
        { name: 'ai.ts', path: 'src/systems/ai.ts', type: 'file', size: 512 },
      ] },
      { name: 'main.ts', path: 'src/main.ts', type: 'file', size: 256 },
    ],
  },
  {
    name: 'scripts', path: 'scripts', type: 'dir', children: [
      { name: 'bake.py', path: 'scripts/bake.py', type: 'file', size: 128 },
    ],
  },
  { name: '.forgeax', path: '.forgeax', type: 'dir', children: [] },
  { name: 'node_modules', path: 'node_modules', type: 'dir', children: [] },
  { name: 'forge.json', path: 'forge.json', type: 'file', size: 200 },
  { name: 'main.ts', path: 'main.ts', type: 'file', size: 100 },
  { name: 'package.json', path: 'package.json', type: 'file', size: 300 },
  { name: 'README.md', path: 'README.md', type: 'file', size: 50 },
];

describe('deriveFileView — file-browser mode', () => {
  it('at root (""): shows visible dirs + root files, hides .forgeax and node_modules', () => {
    const { folders, files } = deriveFileView({
      projectTree: PROJECT_TREE,
      currentPath: '',
      assetRootNames: ['assets'],
    });

    const folderNames = folders.map(f => f.name);
    expect(folderNames).toContain('assets');
    expect(folderNames).toContain('src');
    expect(folderNames).toContain('scripts');
    expect(folderNames).not.toContain('.forgeax');
    expect(folderNames).not.toContain('node_modules');

    const fileNames = files.map(f => f.name);
    expect(fileNames).toContain('forge.json');
    expect(fileNames).toContain('main.ts');
    expect(fileNames).toContain('package.json');
    expect(fileNames).toContain('README.md');
  });

  it('assets folder is marked with asset-root color', () => {
    const { folders } = deriveFileView({
      projectTree: PROJECT_TREE,
      currentPath: '',
      assetRootNames: ['assets'],
    });

    const assetsFolder = folders.find(f => f.name === 'assets');
    expect(assetsFolder).toBeDefined();
    expect(assetsFolder!.color).toBe('asset-root');

    const srcFolder = folders.find(f => f.name === 'src');
    expect(srcFolder).toBeDefined();
    expect(srcFolder!.color).toBeUndefined();
  });

  it('at "src": shows systems subfolder + main.ts file', () => {
    const { folders, files } = deriveFileView({
      projectTree: PROJECT_TREE,
      currentPath: 'src',
      assetRootNames: ['assets'],
    });

    expect(folders.map(f => f.name)).toEqual(['systems']);
    expect(files.map(f => f.name)).toEqual(['main.ts']);
    expect(files[0]!.family).toBe('code');
    expect(files[0]!.kindLabel).toBe('Code');
    expect(files[0]!.path).toBe('src/main.ts');
  });

  it('at leaf "scripts": no subfolders, only files', () => {
    const { folders, files } = deriveFileView({
      projectTree: PROJECT_TREE,
      currentPath: 'scripts',
      assetRootNames: ['assets'],
    });

    expect(folders).toEqual([]);
    expect(files.map(f => f.name)).toEqual(['bake.py']);
    expect(files[0]!.family).toBe('code');
  });

  it('non-existent path returns empty', () => {
    const { folders, files } = deriveFileView({
      projectTree: PROJECT_TREE,
      currentPath: 'nonexistent/path',
      assetRootNames: ['assets'],
    });

    expect(folders).toEqual([]);
    expect(files).toEqual([]);
  });

  it('file family is derived from the filename', () => {
    const { files } = deriveFileView({
      projectTree: PROJECT_TREE,
      currentPath: '',
      assetRootNames: ['assets'],
    });

    const forge = files.find(f => f.name === 'forge.json');
    expect(forge!.family).toBe('config');

    const readme = files.find(f => f.name === 'README.md');
    expect(readme!.family).toBe('doc');
  });

  it('folders and files are sorted by name ascending (locale-aware)', () => {
    const { folders, files } = deriveFileView({
      projectTree: PROJECT_TREE,
      currentPath: '',
      assetRootNames: ['assets'],
    });

    const folderNames = folders.map(f => f.name);
    const sortedFolders = [...folderNames].sort((a, b) => a.localeCompare(b));
    expect(folderNames).toEqual(sortedFolders);

    const fileNames = files.map(f => f.name);
    const sortedFiles = [...fileNames].sort((a, b) => a.localeCompare(b));
    expect(fileNames).toEqual(sortedFiles);
  });
});

describe('collectProjectDirs', () => {
  it('collects all directory paths, excluding hidden ones', () => {
    const dirs = collectProjectDirs(PROJECT_TREE);

    expect(dirs).toContain('assets');
    expect(dirs).toContain('assets/scenes');
    expect(dirs).toContain('src');
    expect(dirs).toContain('src/systems');
    expect(dirs).toContain('scripts');

    expect(dirs).not.toContain('.forgeax');
    expect(dirs).not.toContain('node_modules');
  });

  it('empty tree returns empty array', () => {
    expect(collectProjectDirs([])).toEqual([]);
  });
});
