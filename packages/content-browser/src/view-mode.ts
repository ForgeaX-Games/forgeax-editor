import type { CatalogAssetRoot } from './catalog-root';

export type CBViewMode2 = 'asset' | 'file';

const HIDDEN_DIRS = new Set([
  '.forgeax',
  '.wb-ai-asset',
  'node_modules',
  '.git',
  'dist',
  '.turbo',
  '.cache',
]);

const HIDDEN_PREFIXES = ['.forgeax/', '.wb-ai-asset/', 'node_modules/', '.git/', 'dist/', '.turbo/', '.cache/'];

/**
 * Determine whether a path falls inside an asset-root (catalog-driven view) or
 * outside (raw file-browser view). The empty string (game root) is always
 * file-browser mode because it shows the top-level project folders.
 */
export function resolveViewMode(
  currentPath: string,
  assetRoots: readonly CatalogAssetRoot[],
): CBViewMode2 {
  if (!currentPath) return 'file';
  for (const { root } of assetRoots) {
    if (root.startsWith('@')) continue;
    if (currentPath === root || currentPath.startsWith(`${root}/`)) {
      return 'asset';
    }
  }
  return 'file';
}

/** Returns true for directory names that should never appear in the browser. */
export function isHiddenDir(name: string): boolean {
  return HIDDEN_DIRS.has(name);
}

/** Returns true for paths rooted in a hidden directory. */
export function isHiddenPath(path: string): boolean {
  return HIDDEN_PREFIXES.some(p => path.startsWith(p)) || HIDDEN_DIRS.has(path);
}
