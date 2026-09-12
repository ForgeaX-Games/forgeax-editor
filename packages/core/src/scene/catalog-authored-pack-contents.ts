/**
 * Catalog every asset body from an authored pack file already on disk.
 * Used when pack-index visibility lags behind a direct /api/files write
 * (createSceneFile seed only). Do NOT call from doLoadDocFromDisk — pre-catalog
 * bypasses loadByGuid's loader/recursion and breaks boot render (stale materials).
 */

import { parseScenePayload, type AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { SceneAsset } from '@forgeax/engine-types';
import { normalizeAnimationPlayerSceneAsset } from './animation-slot-sync';
import { stripSceneAssetMountPublicationFences } from './strip-inline-mount-publication-fences';

type PackAssetWire = {
  readonly guid?: string;
  readonly kind?: string;
  readonly payload?: unknown;
  readonly refs?: readonly string[];
};

export interface CatalogAuthoredPackResult {
  readonly cataloged: number;
  readonly sceneGuid?: string;
}

export interface CatalogAuthoredPackOptions {
  /**
   * When false, skip scene bodies. Boot loads must not pre-catalog scenes:
   * loadByGuid's ready fast path would skip recursive ref loading for external
   * meshes/materials while instantiate expects resolved GUID handles.
   * Default true (createScene empty packs, tests).
   */
  readonly catalogScenes?: boolean;
}

/** True when every scene refs[] entry is also an inline body in the same pack file. */
export function scenePackRefsAreAllInline(
  pack: { readonly assets?: readonly PackAssetWire[] },
  sceneEntry: PackAssetWire,
): boolean {
  const inlineGuids = new Set(
    (pack.assets ?? [])
      .map((asset) => (typeof asset.guid === 'string' ? asset.guid.toLowerCase() : ''))
      .filter((guid) => guid.length > 0),
  );
  const refs = Array.isArray(sceneEntry.refs) ? sceneEntry.refs : [];
  return refs.every((ref) => typeof ref === 'string' && inlineGuids.has(ref.toLowerCase()));
}

function wireRefsFromPackAsset(refs: readonly string[] | undefined): string[] | undefined {
  if (refs === undefined || refs.length === 0) return undefined;
  const out = refs.filter((guid): guid is string => typeof guid === 'string');
  return out.length > 0 ? out : undefined;
}

/** Parse on-disk scene payload (refs indices) into runtime SceneAsset shape. */
function parseAuthoredScenePayload(
  payload: unknown,
  refs: readonly string[] | undefined,
): SceneAsset | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const parsed = parseScenePayload(payload as Record<string, unknown>, wireRefsFromPackAsset(refs));
  if (parsed === undefined) return undefined;
  if (typeof parsed === 'object' && 'kind' in parsed && (parsed as SceneAsset).kind === 'scene') {
    return parsed as SceneAsset;
  }
  return undefined;
}

/** Register pack asset bodies into the live registry (ready fast-path). */
export function catalogAuthoredPackContents(
  registry: AssetRegistry,
  pack: { readonly assets?: readonly PackAssetWire[] },
  options?: CatalogAuthoredPackOptions,
): CatalogAuthoredPackResult {
  const catalogScenes = options?.catalogScenes !== false;
  const assets = pack.assets ?? [];
  let cataloged = 0;
  let sceneGuid: string | undefined;
  for (const asset of assets) {
    if (typeof asset.guid !== 'string' || typeof asset.kind !== 'string' || asset.payload === undefined) {
      continue;
    }
    if (asset.kind === 'scene' && !catalogScenes) {
      continue;
    }
    const packRefs = Array.isArray(asset.refs)
      ? asset.refs.filter((guid): guid is string => typeof guid === 'string')
      : undefined;
    let payload = asset.payload;
    if (asset.kind === 'scene') {
      const parsedScene = parseAuthoredScenePayload(payload, packRefs);
      if (parsedScene === undefined) continue;
      payload = stripSceneAssetMountPublicationFences(
        normalizeAnimationPlayerSceneAsset(parsedScene),
      );
      sceneGuid = asset.guid;
    }
    const refs = packRefs?.map((guid) => ({ guid }));
    const result = registry.catalog(asset.guid, payload as never, refs);
    if (result.ok) cataloged += 1;
  }
  return { cataloged, sceneGuid };
}
