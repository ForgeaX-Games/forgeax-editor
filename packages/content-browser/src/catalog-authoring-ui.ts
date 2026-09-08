import type { CatalogAssetRoot } from './catalog-root';
import {
  isUnderCatalogRoot,
  kindRequiresCatalogRoot,
  type CatalogRootRequiredKind,
} from '@forgeax/editor-core';

export { kindRequiresCatalogRoot, type CatalogRootRequiredKind };

/** Local declared catalog roots for CB disk authoring (excludes @shared). */
export function localCatalogRoots(roots: readonly CatalogAssetRoot[]): readonly string[] {
  const local = roots.filter(({ root }) => !root.startsWith('@')).map(({ root }) => root);
  return local.length > 0 ? local : ['assets'];
}

/** Whether a creatable asset kind may be authored at `currentPath`. */
export function creatableKindAllowedAtPath(
  kind: string,
  currentPath: string,
  catalogAssetRoots: readonly CatalogAssetRoot[],
): boolean {
  if (!kindRequiresCatalogRoot(kind)) return true;
  return isUnderCatalogRoot(currentPath, localCatalogRoots(catalogAssetRoots));
}
