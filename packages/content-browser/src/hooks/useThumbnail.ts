// Asset thumbnail derivation now lives in the shared editor-ui primitive
// (@forgeax/editor-ui/asset-thumbnail) so the Content Browser and the Inspector
// reference one SSOT instead of copying the kind→visual mapping. This module is
// kept as a thin, CBAsset-typed façade for existing Content Browser call sites.

import { useMemo } from 'react';
// Import via the package barrel (not the `/asset-thumbnail` subpath): Vite's dev
// resolver caches a package's exports map, so a freshly-added subpath fails to
// resolve until a full restart. The barrel is already warm. Same workaround the
// `/icon` primitive uses.
import { getThumbnailData as deriveThumbnail, type ThumbnailData } from '@forgeax/editor-ui';
import type { CBAsset } from '../types';

export type { ThumbnailData } from '@forgeax/editor-ui';

export function getThumbnailData(asset: CBAsset): ThumbnailData {
  return deriveThumbnail(asset);
}

export function useThumbnail(asset: CBAsset): ThumbnailData {
  return useMemo(() => getThumbnailData(asset), [asset.guid, asset.kind]);
}
