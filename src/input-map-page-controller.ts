// input-map-page-controller — PageController for Input Map tabs.
//
// Owns staging lifecycle + dirty close. Controllers self-register by encoded
// page key so host-layer Ctrl+S can save without extending PagePort.

import { encodePageKey } from '@forgeax/types';
import { decide, toast } from '@forgeax/editor-ui';
import type {
  PageController,
  PageControllerContext,
  PageClosePreparation,
} from '@forgeax/interface/core/page-platform';
import {
  awaitAssetWriteCompletion,
  closeInputMapStaging,
  commitInputMapStaging,
  diagnoseInputMap,
  discardInputMapStaging,
  gateway,
  getInputMapStaging,
  isInputMapStagingDirty,
  keepInputMapStaging,
  loadInputMapAsset,
  openInputMapStaging,
  renameInputMapStaging,
  refreshInputMapStaging,
  reloadInputMapStaging,
  setInputMapSaveStatus,
  subscribeAssetsChanged,
  subscribeInputMapStaging,
  type SelectedAsset,
} from '@forgeax/editor-core';

const controllersByPageKey = new Map<string, PageController>();

export function getInputMapPageController(pageKey: string): PageController | undefined {
  return controllersByPageKey.get(pageKey);
}

function assetFromContext(context: PageControllerContext): SelectedAsset | null {
  const value = context.resource?.metadata?.asset;
  if (!value || typeof value !== 'object') return null;
  return value as SelectedAsset;
}

export function createInputMapPageController(
  context: PageControllerContext,
): PageController {
  const asset = assetFromContext(context);
  const guid = asset?.guid ?? context.resource?.canonicalId ?? '';
  const packPath = asset?.packPath ?? '';
  const name = asset?.name ?? context.resource?.displayPath ?? guid;
  const encodedKey = encodePageKey(context.key);
  let disposed = false;
  let observationVersion = 0;

  const observeDiskPayload = async () => {
    const entry = getInputMapStaging(guid);
    const observedPackPath = entry?.packPath ?? packPath;
    if (!guid || !observedPackPath) return;
    const version = ++observationVersion;
    try {
      const loaded = await loadInputMapAsset(observedPackPath, guid);
      if (disposed || version !== observationVersion || !loaded) return;
      refreshInputMapStaging({
        guid,
        packPath: observedPackPath,
        name: loaded.name,
        payload: loaded.payload,
      });
    } catch (cause) {
      console.error('[input-map] failed to observe pack payload', cause);
    }
  };

  if (guid && packPath) {
    openInputMapStaging({
      guid,
      packPath,
      name,
      payload: asset?.payload,
    });
    // Page resources are persisted to restore tabs, but their embedded payload
    // is only an opening snapshot. Rehydrate from the pack SSOT after refresh.
    void observeDiskPayload();
  }
  const unsubscribeAssetsChanged = subscribeAssetsChanged((event) => {
    if (
      event.mutation?.kind === 'renamed'
      && event.mutation.guid.toLowerCase() === guid.toLowerCase()
    ) {
      renameInputMapStaging(guid, event.mutation.name);
      return;
    }
    if (event.source !== 'disk-watch' || event.hint === 'directory-only') return;
    void observeDiskPayload();
  });

  const controller: PageController = {
    prepareClose(): PageClosePreparation {
      if (!guid || !isInputMapStagingDirty(guid)) return { status: 'ready' };
      return {
        status: 'dirty',
        message: `Unsaved changes to ${getInputMapStaging(guid)?.name ?? name}`,
      };
    },
    getTitle() {
      return getInputMapStaging(guid)?.name ?? name;
    },
    subscribeTitle(listener) {
      let previous = getInputMapStaging(guid)?.name ?? name;
      return subscribeInputMapStaging(() => {
        const next = getInputMapStaging(guid)?.name ?? name;
        if (next === previous) return;
        previous = next;
        listener();
      });
    },
    async save() {
      let entry = getInputMapStaging(guid);
      if (!entry) {
        console.warn('[input-map] save: no staging entry for guid', guid);
        return;
      }
      if (entry.saveStatus === 'saving') return;
      setInputMapSaveStatus(guid, 'saving');
      try {
        observationVersion += 1;
        try {
        const loaded = await loadInputMapAsset(entry.packPath, entry.guid);
        if (!loaded) {
          throw new Error('The Input Map could not be read from disk. Reload the asset and try again.');
        }
        refreshInputMapStaging({
          guid: entry.guid,
          packPath: entry.packPath,
          name: loaded.name,
          payload: loaded.payload,
        });
        } catch (cause) {
          const message = cause instanceof Error
            ? cause.message
            : 'The latest disk version could not be verified.';
          toast.error(`Cannot save ${entry.name}`, {
            description: message,
            id: `input-map-save-read-failed-${entry.guid}`,
          });
          throw new Error(message, { cause });
        }

        entry = getInputMapStaging(guid);
        if (!entry) return;
        if (entry.external) {
        const decision = await decide({
          title: 'Input Map changed on disk',
          description: `${entry.name} was modified outside this editor. Reloading discards your unsaved edits.`,
          primaryText: 'Keep Mine and Save',
          secondaryText: 'Reload from Disk',
          cancelText: 'Cancel',
          secondaryDestructive: true,
        });
        if (decision === 'cancel') throw new Error('Input Map save cancelled.');
        if (decision === 'secondary') {
          reloadInputMapStaging(entry.guid);
          toast.info(`Reloaded ${entry.name} from disk`);
          return;
        }
        keepInputMapStaging(entry.guid);
        entry = getInputMapStaging(guid);
        if (!entry) return;
        }

        const errors = diagnoseInputMap(entry.staging).filter(
        (diagnostic) => diagnostic.severity === 'error',
      );
        if (errors.length > 0) {
        const message = `Cannot save ${entry.name}: fix ${errors.length} Input Map error${errors.length === 1 ? '' : 's'} first.`;
        toast.error(message, {
          description: errors[0]?.message,
          id: `input-map-save-blocked-${entry.guid}`,
        });
          throw new Error(message);
        }
      // Seed `_oldEntry` from staging so save still works when the host-kind
      // asset is not yet visible in engine assetCatalog (gateway prefill no-op).
      // Gateway skips overwrite when `_oldEntry` is already present.
        const result = gateway.dispatch({
        kind: 'saveInputMap',
        packPath: entry.packPath,
        guid: entry.guid,
        payload: entry.staging as unknown as Record<string, unknown>,
        _oldEntry: {
          guid: entry.guid,
          kind: 'input-map',
          name: entry.name,
          payload: entry.saved as unknown as Record<string, unknown>,
          refs: [],
        },
      }, 'human');
        if (result.ok) {
          try {
            await awaitAssetWriteCompletion(guid);
            commitInputMapStaging(guid);
            toast.success(`Saved ${entry.name}`, {
              id: `input-map-save-success-${entry.guid}`,
            });
          } catch (cause) {
            toast.error(`Cannot save ${entry.name}`, {
              description: cause instanceof Error ? cause.message : String(cause),
              id: `input-map-save-write-failed-${entry.guid}`,
            });
            throw cause instanceof Error ? cause : new Error(String(cause));
          }
        } else {
          toast.error(`Cannot save ${entry.name}`, {
            description: result.error.hint,
            id: `input-map-save-dispatch-failed-${entry.guid}`,
          });
          throw new Error(result.error.hint);
        }
      } finally {
        setInputMapSaveStatus(guid, 'idle');
      }
    },
    discard() {
      if (!guid) return;
      discardInputMapStaging(guid);
    },
    dispose() {
      disposed = true;
      observationVersion += 1;
      unsubscribeAssetsChanged();
      controllersByPageKey.delete(encodedKey);
      if (guid) closeInputMapStaging(guid);
    },
  };

  controllersByPageKey.set(encodedKey, controller);
  return controller;
}
