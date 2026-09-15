import type { EditorOp, SceneActivationDescriptor } from '@forgeax/editor-core';
import type { SceneReadModel } from '@forgeax/editor-core';

/**
 * Generated default scenes have a real catalog identity but no authored disk
 * file. Project them into the conventional Scenes folder without rewriting
 * their real sourcePath (`*.pack.ts`), which source-authoring actions still use.
 */
export function catalogSceneVirtualPaths(
  scenes: SceneReadModel['scenes'],
): ReadonlyMap<string, string> {
  return new Map(
    scenes
      .filter((scene) => scene.provenance === 'catalog-default' && scene.guid !== null)
      .map((scene) => [
        scene.guid!.toLowerCase(),
        `assets/scenes/${scene.id}.scene`,
      ]),
  );
}

export function sceneActivationToOp(
  descriptor: SceneActivationDescriptor,
  sourcePath?: string,
  requestId: string = globalThis.crypto.randomUUID(),
): EditorOp {
  if (descriptor.mode === 'open-authored' || descriptor.mode === 'open-catalog') {
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
