/** Catalog facts required to derive the editor's writable asset container. */
export interface CatalogStorageLocator {
  readonly packageUrl: string;
  readonly sourcePath?: string;
}

/** Minimal shape of a runtime catalog root (mirrors RuntimeCatalogRoot). */
export interface CatalogRootProjection {
  readonly root: string;
  readonly catalogPrefix: string;
}

function normalizeCatalogPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/g, '').replace(/\/+/g, '/');
}

/**
 * Project a catalog-space path into the declared-root (game-internal)
 * coordinate space.
 *
 * The producer catalog reports sourcePath in the host's SERVE mount space —
 * Studio's play-runtime scans through a `host-games/<slug>/` Vite farm, so a
 * GLB arrives as `host-games/<slug>/assets/bed.glb` while `/api/files` only
 * accepts the host's on-disk layout (installed via setPathResolver). Returning
 * null when NO declared root's catalogPrefix matches lets callers keep their
 * legacy fallback instead of handing the path resolver a serve-mount path it
 * would mangle (`<gameRoot>/host-games/...`).
 */
export function projectCatalogPathToRoots(
  path: string,
  roots: readonly CatalogRootProjection[],
): string | null {
  const normalized = normalizeCatalogPath(path);
  for (const { root, catalogPrefix } of roots) {
    const prefix = normalizeCatalogPath(catalogPrefix).replace(/\/+$/, '');
    if (!prefix) continue;
    if (normalized === prefix) return normalizeCatalogPath(root);
    if (normalized.startsWith(`${prefix}/`)) {
      return `${normalizeCatalogPath(root)}/${normalized.slice(prefix.length + 1)}`;
    }
  }
  return null;
}

/**
 * Derive the authored storage container from the producer catalog.
 *
 * Internal assets live directly in their source `.pack.json`; imported outputs
 * are edited through the source sidecar. Runtime DDC and `/preview/` URLs are
 * never writable storage locations.
 */
export function catalogStoragePath(locator: CatalogStorageLocator): string | null {
  const sourcePath = locator.sourcePath?.replace(/^\//, '');
  if (sourcePath?.endsWith('.pack.json')) return sourcePath;
  if (sourcePath) return `${sourcePath}.meta.json`;

  const packageUrl = locator.packageUrl.replace(/^\//, '');
  if (
    packageUrl.endsWith('.pack.json')
    && !packageUrl.includes('__forgeax-ddc')
    && !packageUrl.startsWith('preview/')
  ) return packageUrl;
  return null;
}

/**
 * catalogStoragePath in the game-internal coordinate space: the locator's
 * sourcePath is projected through the runtime's declared catalog roots first,
 * so the result can be handed to the host-installed path resolver. Returns
 * null when the row has no writable storage OR its sourcePath matches no
 * declared root (caller keeps the catalog-space fallback).
 */
export function catalogGameStoragePath(
  locator: CatalogStorageLocator,
  roots: readonly CatalogRootProjection[],
): string | null {
  if (locator.sourcePath === undefined) return catalogStoragePath(locator);
  const projected = projectCatalogPathToRoots(locator.sourcePath, roots);
  if (projected === null) return null;
  return catalogStoragePath({ packageUrl: locator.packageUrl, sourcePath: projected });
}
