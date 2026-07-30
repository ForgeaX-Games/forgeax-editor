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

/** Ensure `guid`'s payload envelope is cataloged in the registry (loadByGuid on
 *  miss). Returns true when the envelope is live afterwards — false for no
 *  registry, a malformed GUID, or a load failure (callers keep their snapshot
 *  fallback; the sync read surface simply stays uncataloged). Idempotent: an
 *  already-cataloged GUID short-circuits without a fetch. */
export async function ensureAssetCataloged(
  registry: AssetRegistry | undefined,
  guid: string,
): Promise<boolean> {
  if (registry === undefined) return false;
  if (registry.lookup(guid) !== undefined) return true;
  const parsed = AssetGuid.parse(guid);
  if (!parsed.ok) return false;
  const result = await registry.loadByGuid(parsed.value).catch((err: unknown) => {
    console.info('[mat-tex-drop]', 'ensureAssetCataloged: loadByGuid threw', { guid, err });
    return null;
  });
  if (result === null || !result.ok) {
    console.info('[mat-tex-drop]', 'ensureAssetCataloged: loadByGuid failed', {
      guid,
      error: result === null ? null : (result as { error?: unknown }).error,
    });
    return false;
  }
  return true;
}
