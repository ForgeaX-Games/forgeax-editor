// material-pack-path — clamp material authoring targets into the game `assets/` tree.
//
// Pack-index / MeshRenderer AssetPicker only catalogue packs under
// package.json#forgeax.assets.roots (default: `assets/`). Content Browser can
// navigate the whole game tree, so New Material must not silently write outside
// that scan root. SSOT for "is this under assets?" + "where should we write?".

import { hasPathResolver, resolveGamePath } from './path-resolver';

/** Normalize to forward slashes without a trailing slash (empty → ''). */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
}

/**
 * True when `path` is the `assets` directory or a descendant (segment-aware).
 * Works for game-relative (`assets/ui`) and host-resolved (`…/game/assets/ui`) paths.
 */
export function isUnderAssetsDir(path: string): boolean {
  const n = normalizePath(path);
  if (!n) return false;
  return n === 'assets' || n.startsWith('assets/') || /\/assets(?:\/|$)/.test(n);
}

/**
 * Resolve the game-relative directory for a Content Browser "New Material".
 * Outside `assets/` → redirect to `assets` (caller should navigate + toast).
 */
export function resolveMaterialCreateGameRelDir(currentPath: string): {
  dir: string;
  redirected: boolean;
} {
  const rel = normalizePath(currentPath || '');
  if (rel === 'assets' || rel.startsWith('assets/')) {
    return { dir: rel, redirected: false };
  }
  return { dir: 'assets', redirected: true };
}

/**
 * Clamp a material `packPath` into `assets/Materials.pack.json` when the
 * target directory is outside `assets/`. Used by `createMaterial` as defense
 * in depth (AI / texture-assign paths that omit the CB redirect).
 */
export function clampMaterialPackPath(packPath: string): {
  packPath: string;
  redirected: boolean;
} {
  const n = normalizePath(packPath);
  if (isUnderAssetsDir(n)) {
    return { packPath: n, redirected: false };
  }
  const fallback = hasPathResolver()
    ? `${normalizePath(resolveGamePath('assets'))}/Materials.pack.json`
    : 'assets/Materials.pack.json';
  return { packPath: fallback, redirected: true };
}
