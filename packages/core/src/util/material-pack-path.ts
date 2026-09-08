// material-pack-path — defense-in-depth clamp for material pack paths.
//
// Content Browser Create uses `catalog-authoring-path` (fail fast). This module
// still clamps AI / gateway paths that omit the CB redirect.

import {
  DEFAULT_LOCAL_CATALOG_ROOTS,
  isUnderCatalogRoot,
  normalizeCatalogPath,
} from './catalog-authoring-path';
import { hasPathResolver, resolveGamePath } from './path-resolver';

/**
 * True when `path` is under the default local catalog root (`assets/`).
 * Host-resolved paths containing an `/assets/` segment are accepted.
 */
export function isUnderAssetsDir(path: string): boolean {
  const n = normalizeCatalogPath(path);
  if (!n) return false;
  if (isUnderCatalogRoot(n, DEFAULT_LOCAL_CATALOG_ROOTS)) return true;
  return /\/assets(?:\/|$)/.test(n);
}

/**
 * @deprecated Prefer `resolveCatalogAuthoringDir` — CB Create fails outside roots.
 * Kept for callers that still redirect (legacy); returns redirect when outside assets.
 */
export function resolveMaterialCreateGameRelDir(currentPath: string): {
  dir: string;
  redirected: boolean;
} {
  const rel = normalizeCatalogPath(currentPath || '');
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
  const n = normalizeCatalogPath(packPath);
  if (isUnderAssetsDir(n)) {
    return { packPath: n, redirected: false };
  }
  const fallback = hasPathResolver()
    ? `${normalizeCatalogPath(resolveGamePath('assets'))}/Materials.pack.json`
    : 'assets/Materials.pack.json';
  return { packPath: fallback, redirected: true };
}
