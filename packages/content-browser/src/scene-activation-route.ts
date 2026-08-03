import type { EditorOp, SceneActivationDescriptor } from '@forgeax/editor-core';

export function sceneActivationToOp(
  descriptor: SceneActivationDescriptor,
  sourcePath?: string,
  requestId: string = globalThis.crypto.randomUUID(),
): EditorOp {
  if (descriptor.mode === 'open-authored') {
    return { kind: 'switchSceneFile', id: descriptor.authoredSceneId ?? '' };
  }
  return {
    kind: 'previewImportedScene',
    guid: descriptor.guid,
    sourceKey: descriptor.sourceKey,
    ...(sourcePath ? { sourcePath } : {}),
    revision: descriptor.revision,
    requestId,
  };
}

/** Explicit source-edit route. Ordinary open/double-click always remains preview. */
export function sceneSourceEditToOp(
  descriptor: SceneActivationDescriptor,
  requestId: string = globalThis.crypto.randomUUID(),
): EditorOp {
  if (!descriptor.canEditSource || descriptor.provenance !== 'imported-output') {
    throw new Error(descriptor.unavailable?.editSource?.reason ?? 'Imported source editing is unavailable.');
  }
  if (!descriptor.metaPath) throw new Error('Imported source editing requires a catalog/workspace meta path.');
  return {
    kind: 'editImportedSource',
    guid: descriptor.guid,
    sourceKey: descriptor.sourceKey,
    metaPath: descriptor.metaPath,
    revision: descriptor.revision,
    requestId,
  };
}

export function scenePromoteToOp(
  descriptor: SceneActivationDescriptor,
  input: {
    readonly targetPackPath: string;
    readonly targetName: string;
    readonly contentPolicy: 'effective-base' | 'current-session';
    readonly discardSourceChanges?: boolean;
  },
  requestId: string = globalThis.crypto.randomUUID(),
): EditorOp {
  if (!descriptor.canPromote || descriptor.provenance !== 'imported-output') {
    throw new Error(descriptor.unavailable?.promote?.reason ?? 'Imported scene promotion is unavailable.');
  }
  return {
    kind: 'promoteImportedScene',
    importedGuid: descriptor.guid,
    sourceKey: descriptor.sourceKey,
    revision: descriptor.revision,
    targetPackPath: input.targetPackPath,
    targetName: input.targetName,
    contentPolicy: input.contentPolicy,
    ...(input.discardSourceChanges === undefined ? {} : { discardSourceChanges: input.discardSourceChanges }),
    requestId,
  };
}
