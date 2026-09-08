// material-page-controller — PageController for Base Material tabs (STD-02).
//
// Owns staging lifecycle + dirty close. Controllers self-register by encoded
// page key so host-layer Ctrl+S can save without extending PagePort.

import { encodePageKey } from '@forgeax/types';
import type {
  PageController,
  PageControllerContext,
  PageClosePreparation,
  PageCloseReason,
  PageMenuItem,
} from '@forgeax/interface/core/page-platform';
import {
  closeMaterialStaging,
  commitMaterialStaging,
  discardMaterialStaging,
  dispatchActiveEditorOperation,
  ensureAssetCataloged,
  gateway,
  getMaterialStaging,
  getViewportRuntimeClientSnapshot,
  isMaterialStagingDirty,
  listDirtyMaterialStagingGuids,
  openMaterialStaging,
  type MaterialStagingPayload,
  type SelectedAsset,
} from '@forgeax/editor-core';
import {
  createPageAuthoringGatewayProjection,
  type AuthoringGatewayProjection,
} from '../runtime/tool-client-operations';

const controllersByPageKey = new Map<string, PageController>();

export function getMaterialPageController(pageKey: string): PageController | undefined {
  return controllersByPageKey.get(pageKey);
}

type MaterialAssetProjection = SelectedAsset & { readonly revision?: string };

export type MaterialPackSaveProjection = {
  save(entry: {
    readonly packPath: string;
    readonly guid: string;
    readonly staging: MaterialStagingPayload;
  }): Promise<{ readonly ok: boolean }>;
};

/** Only `project:*` revisions belong on the Project ToolClient CAS path. */
export function resolveProjectMaterialRevision(revision: unknown): string | undefined {
  if (typeof revision !== 'string' || revision.length === 0) return undefined;
  return revision.startsWith('project:') ? revision : undefined;
}

async function defaultPackMaterialSave(entry: {
  readonly packPath: string;
  readonly guid: string;
  readonly staging: MaterialStagingPayload;
}): Promise<{ readonly ok: boolean }> {
  const operation = {
    kind: 'updateMaterialParams' as const,
    packPath: entry.packPath,
    guid: entry.guid,
    paramPatch: entry.staging.values,
    textureGuids: entry.staging.textureGuids,
  };
  if (getViewportRuntimeClientSnapshot().status === 'ready') {
    const runtimeResult = await dispatchActiveEditorOperation(operation, 'human');
    if (runtimeResult.ok) return { ok: true };
  }
  // In-process hosts still own a live Gateway with the asset registry (#710).
  // When the Runtime projection is momentarily disconnected, fall back instead
  // of letting Ctrl+S fall through to saveDocToDisk with dirty material staging.
  const registry = gateway.doc.registry;
  if (registry) {
    await ensureAssetCataloged(registry, entry.guid);
  }
  const gatewayResult = gateway.dispatch(operation, 'human');
  return { ok: gatewayResult.ok };
}

/** Persist one material staging buffer — shared by PageController.save and Ctrl+S. */
export async function saveMaterialStagingForGuid(
  guid: string,
  revision: string | undefined,
  authoring: AuthoringGatewayProjection = createPageAuthoringGatewayProjection(),
  packSave: MaterialPackSaveProjection = { save: defaultPackMaterialSave },
): Promise<boolean> {
  const entry = getMaterialStaging(guid);
  if (!entry) return false;
  const registry = gateway.doc.registry;
  if (registry) {
    await ensureAssetCataloged(registry, guid);
  }
  const projectRevision = resolveProjectMaterialRevision(revision);
  if (projectRevision === undefined) {
    const result = await packSave.save({
      packPath: entry.packPath,
      guid: entry.guid,
      staging: entry.staging,
    });
    if (result.ok) commitMaterialStaging(guid);
    else console.error('[material-page] pack save rejected', { guid, packPath: entry.packPath });
    return result.ok;
  }
  const gesture = authoring.begin(
    { kind: 'material', guid: entry.guid },
    {
      values: { ...entry.staging.values },
      ...(entry.staging.textureGuids === undefined ? {} : { textureGuids: { ...entry.staging.textureGuids } }),
    },
    {
      subject: { kind: 'material', guid: entry.guid },
      revision: projectRevision,
      state: {
        values: { ...entry.saved.values },
        ...(entry.saved.textureGuids === undefined ? {} : { textureGuids: { ...entry.saved.textureGuids } }),
      },
    },
  );
  const result = await gesture.commit();
  if (result !== null && typeof result === 'object' && 'ok' in result && result.ok === true) {
    commitMaterialStaging(guid);
    return true;
  }
  return false;
}

/** Ctrl+S fallback when the page handler slot is empty — any dirty staging wins. */
export function trySaveDirtyMaterialStaging(): boolean {
  for (const guid of listDirtyMaterialStagingGuids()) {
    void saveMaterialStagingForGuid(guid, undefined).catch((cause) => {
      console.error('[material-page] staging save failed', { guid, cause });
    });
    return true;
  }
  return false;
}

/** Host-layer Ctrl+S hook — never fall through to scene save on a Material tab. */
export function invokeMaterialPageSave(pageKey: string, guid?: string, revision?: string): boolean {
  const projectRevision = resolveProjectMaterialRevision(revision);
  const controller = getMaterialPageController(pageKey);
  if (controller?.save) {
    void Promise.resolve(controller.save()).catch((cause) => {
      console.error('[material-page] controller save failed', { pageKey, guid, cause });
    });
    return true;
  }
  if (typeof guid === 'string' && guid.length > 0) {
    void saveMaterialStagingForGuid(guid, projectRevision).catch((cause) => {
      console.error('[material-page] staging save failed', { pageKey, guid, cause });
    });
    return true;
  }
  return false;
}

function assetFromContext(context: PageControllerContext): MaterialAssetProjection | null {
  const value = context.resource?.metadata?.asset;
  if (!value || typeof value !== 'object') return null;
  return value as MaterialAssetProjection;
}

export function createMaterialPageController(
  context: PageControllerContext,
  authoring: AuthoringGatewayProjection = createPageAuthoringGatewayProjection(),
  packSave: MaterialPackSaveProjection = { save: defaultPackMaterialSave },
): PageController {
  const asset = assetFromContext(context);
  const guid = asset?.guid ?? context.resource?.canonicalId ?? '';
  const packPath = asset?.packPath ?? '';
  const name = asset?.name ?? context.resource?.displayPath ?? guid;
  const encodedKey = typeof context.key === 'string'
    ? context.key
    : encodePageKey(context.key);

  if (guid && packPath) {
    openMaterialStaging({
      guid,
      packPath,
      name,
      payload: asset?.payload,
    });
  }

  const controller: PageController = {
    prepareClose(_reason?: PageCloseReason): PageClosePreparation {
      if (!guid || !isMaterialStagingDirty(guid)) return { status: 'ready' };
      return { status: 'dirty', message: `Unsaved changes to material ${name}` };
    },
    async save() {
      await saveMaterialStagingForGuid(
        guid,
        resolveProjectMaterialRevision(asset?.revision),
        authoring,
        packSave,
      );
    },
    discard() {
      if (!guid) return;
      discardMaterialStaging(guid);
    },
    dispose() {
      controllersByPageKey.delete(encodedKey);
      if (guid) closeMaterialStaging(guid);
    },
    getContextMenuItems(): readonly PageMenuItem[] {
      const dirty = guid ? isMaterialStagingDirty(guid) : false;
      return [
        {
          id: 'save',
          label: 'Save Material',
          icon: 'save',
          group: 'actions',
          disabled: !dirty,
          run: () => {
            void controller.save?.();
          },
        },
        {
          id: 'discard',
          label: 'Discard Changes',
          icon: 'undo',
          group: 'actions',
          disabled: !dirty,
          run: () => {
            controller.discard?.();
          },
        },
      ];
    },
  };

  controllersByPageKey.set(encodedKey, controller);
  return controller;
}
