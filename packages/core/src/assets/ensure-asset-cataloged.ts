// assets/ensure-asset-cataloged.ts — guarantee a catalog GUID's payload envelope
// is live in registry.assetCatalog.
//
// WHY THIS EXISTS
//   gateway.lookupAsset and updateMaterialParams' _preFillMaterialOp are
//   SYNCHRONOUS catalog reads — they hit registry.assetCatalog, which ONLY
//   loadByGuid populates (refreshCatalog fetches pack-index ROWS, never
//   payloads; registerPackagesFromIndex registers package groupings only). A
//   material that was never loaded this session — created before a page
//   reload, or not referenced by the currently loaded scene — displays in the
//   Asset Inspector from the selection-time snapshot, but any
//   updateMaterialParams dispatch finds NO envelope and fails ("drag texture →
//   no response"). Surfaces that edit a catalog asset call this once on open
//   so the sync read path is guaranteed to hit afterwards.

import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';

export interface CatalogAssetLoadError {
  readonly code: string;
  readonly hint: string;
  readonly retryable: boolean;
  readonly recoveryActions: readonly string[];
  readonly details: { readonly guid: string; readonly cause?: unknown };
}

/** The same catalog admission used by UI consumers, with failures retained for public reads. */
export async function ensureAssetCatalogedResult(
  registry: AssetRegistry | undefined,
  guid: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: CatalogAssetLoadError }> {
  const failure = (code: string, hint: string, retryable: boolean, cause?: unknown) => ({
    ok: false as const,
    error: { code, hint, retryable, recoveryActions: ['editor.discover', 'query'],
      details: { guid, ...(cause === undefined ? {} : { cause: cause instanceof Error
        ? { ...cause, name: cause.name, message: cause.message,
          ...('cause' in cause ? { cause: cause.cause } : {}) }
        : cause }) } },
  });
  if (registry === undefined) return failure('asset-registry-unavailable',
    'Wait for the Editor asset registry to connect, then repeat the asset payload query.', true);
  const parsed = AssetGuid.parse(guid);
  if (!parsed.ok) return failure('asset-guid-invalid',
    'Use a GUID returned by assets.catalog or the import receipt.', false, parsed.error);
  const catalog = registry.catalogSnapshot?.();
  if (catalog?.stale === true) return failure('asset-catalog-stale',
    'Wait for the catalog to reconcile before repeating the asset payload query.', true, catalog.diagnostics);
  if (registry.lookup(guid) !== undefined) return { ok: true };
  try {
    const result = await registry.loadByGuid(parsed.value);
    if (!result.ok) return failure('asset-payload-load-failed',
      'The asset payload could not be loaded. Inspect the producer cause before retrying this query.', false, result.error);
    return { ok: true };
  } catch (cause) {
    return failure('asset-payload-load-failed',
      'The asset payload loader threw. Inspect the cause and restore the asset source before retrying.', false,
      cause);
  }
}

/** Ensure `guid`'s payload envelope is cataloged in the registry (loadByGuid on
 *  miss). Returns true when the envelope is live afterwards — false for no
 *  registry, a malformed GUID, or a load failure (callers keep their snapshot
 *  fallback; the sync read surface simply stays uncataloged). Idempotent: an
 *  already-cataloged GUID short-circuits without a fetch. */
export async function ensureAssetCataloged(
  registry: AssetRegistry | undefined,
  guid: string,
): Promise<boolean> {
  return (await ensureAssetCatalogedResult(registry, guid)).ok;
}
