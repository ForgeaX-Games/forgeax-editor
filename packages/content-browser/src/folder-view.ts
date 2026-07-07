import type { CBAsset, CBFolder } from './types';

/**
 * A catalog asset paired with its game-relative `.pack.json` path.
 *
 * `rel` is the engine registry `relativeUrl` reduced to game scope
 * (e.g. `assets/characters/hero.pack.json`). This is the SAME value the
 * ContentBrowser already computes for its source-panel folder list — folders
 * are DERIVED from it, so no new persisted data format is introduced.
 */
export interface ScopedAsset {
  asset: CBAsset;
  rel: string;
}

export interface ContentView {
  /** Immediate subfolders of `currentPath`, sorted by name. */
  folders: CBFolder[];
  /** Assets that sit DIRECTLY in `currentPath` (non-recursive, UE-parity). */
  assets: CBAsset[];
}

/** Directory portion of a rel path (`a/b/c.json` → `a/b`; `c.json` → ``). */
function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

/**
 * Compute the UE-style Content Browser view for a folder: its immediate
 * subfolders (as `CBFolder` view-models) plus the assets sitting directly in
 * it. Unlike a recursive flatten, descendant assets stay hidden until the user
 * drills into the subfolder — matching UE5's default (non-recursive) folder
 * contents.
 */
export function deriveContentView(params: {
  scopedAssets: ScopedAsset[];
  packDirs: string[];
  currentPath: string;
  favorites?: string[];
}): ContentView {
  const { scopedAssets, packDirs, currentPath, favorites = [] } = params;

  const prefix = currentPath ? `${currentPath}/` : '';
  const depth = currentPath ? currentPath.split('/').length : 0;

  const favoriteSet = new Set(favorites);

  const folders: CBFolder[] = packDirs
    .filter((d) => d !== currentPath && d.startsWith(prefix) && d.split('/').length === depth + 1)
    .map((path) => ({
      type: 'folder' as const,
      path,
      name: path.split('/').pop() ?? path,
      isFavorite: favoriteSet.has(path),
      childCount: scopedAssets.reduce(
        (n, s) => (s.rel === path || s.rel.startsWith(`${path}/`) ? n + 1 : n),
        0,
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const assets: CBAsset[] = scopedAssets
    .filter((s) => dirOf(s.rel) === currentPath)
    .map((s) => s.asset);

  return { folders, assets };
}
