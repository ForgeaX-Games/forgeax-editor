// Asset thumbnail derivation now lives in the shared editor-ui primitive
// (@forgeax/editor-ui/asset-thumbnail) so the Content Browser and the Inspector
// reference one SSOT instead of copying the kind→visual mapping. This module is
// kept as a thin, CBAsset-typed façade for existing Content Browser call sites.

import { useMemo } from 'react';
import { gateway } from '@forgeax/editor-core';
// Import via the package barrel (not the `/asset-thumbnail` subpath): Vite's dev
// resolver caches a package's exports map, so a freshly-added subpath fails to
// resolve until a full restart. The barrel is already warm. Same workaround the
// `/icon` primitive uses.
import { getThumbnailData as deriveThumbnail, type ThumbnailData } from '@forgeax/editor-ui';
import type { CBAsset } from '../types';

export type { ThumbnailData } from '@forgeax/editor-ui';

// Registry-projected CBAssets carry an empty `payload` (registryEntryToCBAsset),
// so deriving a thumbnail straight from the row can only fall back to a kind
// glyph — a colourless texture, a grey material. Pull the real POD meta
// (baseColor / source / width / height, …) from the engine by GUID so textures
// resolve a real image and materials render their true colour. This is the SSOT
// enrichment shared by the grid cards (getThumbnailData) and the right-hand
// preview aside (CBPreviewPanel). Sync cache read (registry.lookup) — safe in render.
export function realPayload(guid: string, fallback: Record<string, unknown>): Record<string, unknown> {
  const desc = gateway.describeAssetByGuid(guid);
  if (desc?.ok && desc.meta && typeof desc.meta === 'object') return desc.meta as Record<string, unknown>;
  return fallback;
}

export function getThumbnailData(asset: CBAsset): ThumbnailData {
  return deriveThumbnail({
    kind: asset.kind,
    payload: realPayload(asset.guid, asset.payload),
    packPath: asset.packPath,
  });
}

export function useThumbnail(asset: CBAsset): ThumbnailData {
  return useMemo(() => getThumbnailData(asset), [asset.guid, asset.kind]);
}
