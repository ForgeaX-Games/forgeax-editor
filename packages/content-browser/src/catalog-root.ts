// catalog-root — project engine catalog source paths into Content Browser roots.
//
// Vite injects the exact declared-root → catalog-prefix map from its pluginPack
// configuration. The local-root fallback deliberately uses only the declared
// local root names: older catalog rows can still carry a slug-addressable path,
// but external roots must always match the injected projection (no UI-side disk
// layout convention for @shared).

export interface CatalogAssetRoot {
  readonly root: string;
  readonly catalogPrefix: string;
}

/** Map a catalog path into the browser's declared-root coordinate space. */
export function catalogPathToRoot(
  path: string,
  slug: string,
  roots: readonly CatalogAssetRoot[],
): string | null {
  const normalized = path.replace(/^\/+/, '');
  for (const { root, catalogPrefix } of roots) {
    const prefix = catalogPrefix.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!prefix) continue;
    if (normalized === prefix) return root;
    if (normalized.startsWith(`${prefix}/`)) return `${root}/${normalized.slice(prefix.length + 1)}`;
  }

  // Keep local game paths resilient to catalog-coordinate changes. This cannot
  // surface foreign catalog entries: the result must still begin under one of
  // the exact non-external roots the host declared for this game.
  if (!slug) return null;
  const parts = normalized.split('/');
  const slugIndex = parts.indexOf(slug);
  const relativePath = slugIndex < 0 ? '' : parts.slice(slugIndex + 1).join('/');
  if (!relativePath) return null;
  return roots.some(({ root }) => !root.startsWith('@') && (relativePath === root || relativePath.startsWith(`${root}/`)))
    ? relativePath
    : null;
}
