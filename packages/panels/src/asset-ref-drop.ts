import type { DragEvent } from 'react';
import type { DragAssetRef } from '@forgeax/editor-core';
import { getActiveAssetDrag } from './asset-drag-session';
import { isGuidCompatibleWithAssetType } from './asset-ref-contract';

export const ASSET_DRAG_MIME = 'application/x-forgeax-asset';

export type AssetDropVerdict = 'none' | 'accept' | 'reject';

export function carriesAssetMime(dataTransfer: DataTransfer | null): boolean {
  return dataTransfer?.types.includes(ASSET_DRAG_MIME) === true;
}

export function parseDroppedGuid(event: DragEvent): string | undefined {
  const assetJson = event.dataTransfer.getData(ASSET_DRAG_MIME);
  if (!assetJson) return undefined;
  try {
    const ref = JSON.parse(assetJson) as { guid?: string };
    return typeof ref.guid === 'string' && ref.guid.length > 0 ? ref.guid : undefined;
  } catch {
    return undefined;
  }
}

export function resolveAssetDropVerdict(
  assetType: string,
  drag: DragAssetRef | null,
  acceptKinds?: ReadonlySet<string>,
): AssetDropVerdict {
  if (!drag?.guid) return 'none';
  if (acceptKinds) {
    return acceptKinds.has(drag.kind) ? 'accept' : 'reject';
  }
  return isGuidCompatibleWithAssetType(drag.guid, assetType) ? 'accept' : 'reject';
}

export function dropClassForVerdict(verdict: AssetDropVerdict): string {
  if (verdict === 'accept') return 'drop-hot';
  if (verdict === 'reject') return 'drop-reject';
  return '';
}

export function activeDragForDropTarget(dataTransfer: DataTransfer | null): DragAssetRef | null {
  return getActiveAssetDrag() ?? parseDragRefFromDataTransfer(dataTransfer);
}

function parseDragRefFromDataTransfer(dataTransfer: DataTransfer | null): DragAssetRef | null {
  if (!carriesAssetMime(dataTransfer)) return null;
  try {
    const raw = dataTransfer?.getData(ASSET_DRAG_MIME);
    if (!raw) return null;
    const value = JSON.parse(raw) as { guid?: unknown; kind?: unknown; name?: unknown; packPath?: unknown };
    if (
      typeof value.guid !== 'string'
      || value.guid.length === 0
      || typeof value.kind !== 'string'
      || value.kind.length === 0
      || typeof value.name !== 'string'
    ) return null;
    return {
      type: 'asset',
      guid: value.guid,
      kind: value.kind,
      name: value.name,
      ...(typeof value.packPath === 'string' ? { path: value.packPath } : {}),
      payload: {},
    };
  } catch {
    return null;
  }
}
