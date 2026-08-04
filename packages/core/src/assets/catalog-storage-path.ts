/** Catalog facts required to derive the editor's writable asset container. */
export interface CatalogStorageLocator {
  readonly packageUrl: string;
  readonly sourcePath?: string;
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
