import { describe, expect, it } from 'bun:test';
import { deriveContentView, type ScopedAsset } from './folder-view';
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
