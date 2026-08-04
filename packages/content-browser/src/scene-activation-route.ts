import type { EditorOp, SceneActivationDescriptor } from '@forgeax/editor-core';

export function sceneActivationToOp(
  descriptor: SceneActivationDescriptor,
  sourcePath?: string,
  requestId: string = globalThis.crypto.randomUUID(),
): EditorOp {
  if (descriptor.mode === 'open-authored') {
    return { kind: 'switchSceneFile', id: descriptor.authoredSceneId ?? '', requestId };
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
