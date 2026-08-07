// mi-page-controller — PageController for Material Instance tabs (M4/B2).
//
// Owns staging lifecycle + dirty close. Controllers self-register by encoded
// page key so host-layer Ctrl+S can save without extending PagePort.

import { encodePageKey } from '@forgeax/types';
import type {
  PageController,
  PageControllerContext,
  PageClosePreparation,
} from '@forgeax/interface/core/page-platform';
import {
  closeMiStaging,
  commitMiStaging,
  discardMiStaging,
  gateway,
  getMiStaging,
  isMiStagingDirty,
  openMiStaging,
  type SelectedAsset,
} from '@forgeax/editor-core';

const controllersByPageKey = new Map<string, PageController>();

export function getMiPageController(pageKey: string): PageController | undefined {
  return controllersByPageKey.get(pageKey);
}

function assetFromContext(context: PageControllerContext): SelectedAsset | null {
  const value = context.resource?.metadata?.asset;
  if (!value || typeof value !== 'object') return null;
  return value as SelectedAsset;
}

export function createMaterialInstancePageController(
  context: PageControllerContext,
): PageController {
  const asset = assetFromContext(context);
  const guid = asset?.guid ?? context.resource?.canonicalId ?? '';
  const packPath = asset?.packPath ?? '';
  const name = asset?.name ?? context.resource?.displayPath ?? guid;
  const encodedKey = encodePageKey(context.key);

  if (guid && packPath) {
    openMiStaging({
      guid,
      packPath,
      name,
      payload: asset?.payload,
    });
  }

  const controller: PageController = {
    prepareClose(): PageClosePreparation {
      if (!guid || !isMiStagingDirty(guid)) return { status: 'ready' };
      return { status: 'dirty', message: `Unsaved changes to ${name}` };
    },
    async save() {
      const entry = getMiStaging(guid);
      if (!entry) return;
      const result = gateway.dispatch({
        kind: 'saveMaterialInstance',
        packPath: entry.packPath,
        guid: entry.guid,
        payload: entry.staging as unknown as Record<string, unknown>,
      }, 'human');
      if (result.ok) commitMiStaging(guid);
    },
    discard() {
      if (!guid) return;
      discardMiStaging(guid);
    },
    dispose() {
      controllersByPageKey.delete(encodedKey);
      if (guid) closeMiStaging(guid);
    },
  };

  controllersByPageKey.set(encodedKey, controller);
  return controller;
}
