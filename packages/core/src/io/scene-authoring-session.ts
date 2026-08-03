import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { SceneAsset } from '@forgeax/engine-types';
import type { WorldType } from '../scene/scene-types';

export type SceneAuthoringMode = 'authored' | 'imported-preview';
export type SceneAuthoringSaveTarget = 'scene-pack' | null;

export interface ImportedSceneSessionIdentity {
  readonly guid: string;
  readonly sourceKey: string;
  readonly revision: string;
}

export interface SceneAuthoringSessionReadModel {
  readonly mode: SceneAuthoringMode;
  readonly canMutate: boolean;
  readonly saveTarget: SceneAuthoringSaveTarget;
  readonly reason: string | null;
  readonly imported?: ImportedSceneSessionIdentity;
}

/** Persistence-owned imported preview state and producer identity. */
export interface ImportedPreviewSessionState extends ImportedSceneSessionIdentity {
  readonly effectiveScene: SceneAsset;
  readonly world: WorldType;
  readonly registry: AssetRegistry;
}

export const AUTHORED_SCENE_AUTHORING_SESSION: SceneAuthoringSessionReadModel = Object.freeze({
  mode: 'authored',
  canMutate: true,
  saveTarget: 'scene-pack',
  reason: null,
});

export function importedPreviewSession(
  imported?: ImportedSceneSessionIdentity,
): SceneAuthoringSessionReadModel {
  return Object.freeze({
    mode: 'imported-preview',
    canMutate: false,
    saveTarget: null,
    reason: 'Imported previews are derived and read-only.',
    ...(imported === undefined ? {} : { imported: Object.freeze({ ...imported }) }),
  });
}
