// store/ensure-asset-cataloged — eagerly load an asset by GUID into the
// engine's assetCatalog if it isn't already present. Used by the material editor
// (AssetPreviewMaterial) to bridge the gap where a pack-only material is visible
// in the Content Browser (via packIndexCache metadata) but not yet loaded into
// the assetCatalog (which requires a full loadByGuid fetch). Without this, the
// gateway-fill for updateMaterialParams fails silently because it reads from
// assetCatalog synchronously.
//
// Anchor: dev-plan §10.7 "cheapest fix is an eager loadByGuid in the
// asset-inspector mount".

import { gateway } from './gateway';

/**
 * Ensure the asset with the given GUID string is present in
 * `registry.assetCatalog`. If it's already catalogued, resolves immediately
 * with the payload. Otherwise triggers `loadByGuid` and resolves with the
 * freshly-catalogued payload (or null on failure).
 */
export async function ensureAssetCataloged(
  guidStr: string,
): Promise<Record<string, unknown> | null> {
  const reg = gateway.doc.registry;
  if (!reg) return null;
  const key = guidStr.toLowerCase();
  const existing = reg.assetCatalog.get(key);
  if (existing) return existing.payload as unknown as Record<string, unknown>;

  // Dynamic import to avoid hard dep on engine-pack from the barrel.
  const { AssetGuid } = await import('@forgeax/engine-pack/guid');
  const parsed = AssetGuid.parse(guidStr);
  if (!parsed.ok) return null;
  const res = await reg.loadByGuid(parsed.value);
  if (!res.ok) return null;
  const envelope = reg.assetCatalog.get(key);
  return envelope ? (envelope.payload as unknown as Record<string, unknown>) : null;
}
