import type { SceneAsset } from '@forgeax/engine-types';
import type { ScenePublicationFence } from '@forgeax/engine-assets-runtime';

/** Legacy decoded mount metadata retained only while old sessions are open. */
export interface LegacySceneMount {
  readonly localId?: number;
  readonly source: string | number;
  readonly memberFirst: number;
  readonly memberCount: number;
  readonly publicationFence?: ScenePublicationFence;
}

export type SceneWithLegacyMounts = SceneAsset & {
  readonly mounts?: readonly LegacySceneMount[];
};
