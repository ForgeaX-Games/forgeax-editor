// catalog-authoring-path — SSOT for "may catalogued assets be authored here?"
//
// Pack-index scans package.json#forgeax.assets.roots (default: assets/). Content
// Browser can navigate the whole game tree; Material / Particle Create must
// fail fast outside those local roots instead of silently redirecting.

/** Normalize to forward slashes without a trailing slash (empty → ''). */
export function normalizeCatalogPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
}

export const DEFAULT_LOCAL_CATALOG_ROOTS = ['assets'] as const;

/** Asset kinds that must be created under a declared local catalog root. */
export const CATALOG_ROOT_REQUIRED_KINDS = ['material', 'particle-effect'] as const;

export type CatalogRootRequiredKind = (typeof CATALOG_ROOT_REQUIRED_KINDS)[number];

export function kindRequiresCatalogRoot(kind: string): kind is CatalogRootRequiredKind {
  return (CATALOG_ROOT_REQUIRED_KINDS as readonly string[]).includes(kind);
}

/**
 * True when `path` is a declared local catalog root or a descendant.
 * External roots (`@shared/...`) are ignored — CB local Create targets game disk.
 */
export function isUnderCatalogRoot(path: string, roots: readonly string[]): boolean {
  const rel = normalizeCatalogPath(path);
  if (!rel) return false;
  const localRoots = roots.filter((root) => !root.startsWith('@'));
  const effective = localRoots.length > 0 ? localRoots : [...DEFAULT_LOCAL_CATALOG_ROOTS];
  for (const root of effective) {
    const normalizedRoot = normalizeCatalogPath(root);
    if (!normalizedRoot) continue;
    if (rel === normalizedRoot || rel.startsWith(`${normalizedRoot}/`)) return true;
  }
  return false;
}

/** Resolve the game-relative directory for catalog-root authoring Create actions. */
export function resolveCatalogAuthoringDir(
  currentPath: string,
  roots: readonly string[] = DEFAULT_LOCAL_CATALOG_ROOTS,
): { ok: true; dir: string } | { ok: false } {
  const rel = normalizeCatalogPath(currentPath || '');
  if (!isUnderCatalogRoot(rel, roots)) {
    return { ok: false };
  }
  return { ok: true, dir: rel };
}
