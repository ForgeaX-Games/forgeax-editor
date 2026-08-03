export type SceneActivationMode = 'open-authored' | 'preview-imported' | 'edit-imported-source' | 'promote-imported';

export interface SceneActivationUnavailable {
  readonly reason: string;
  readonly recoveryActions: readonly string[];
}

export interface SceneActivationDescriptor {
  readonly subjectKind: 'scene';
  readonly provenance: 'authored-pack' | 'imported-output';
  readonly revision: string;
  readonly sourceKey: string;
  readonly metaPath?: string;
  readonly guid: string;
  readonly mode: SceneActivationMode;
  readonly authoredSceneId?: string;
  readonly canPreview: boolean;
  readonly canMount: boolean;
  readonly canEditInstance: boolean;
  readonly canEditSource: boolean;
  readonly canPromote: boolean;
  readonly unavailable?: Readonly<Record<string, SceneActivationUnavailable>>;
}

export interface SceneActivationAssetFacts {
  readonly guid: string;
  readonly kind: string;
  readonly packageUrl: string;
  readonly sourcePath?: string;
  readonly sourceKey?: string;
  readonly metaPath?: string;
  readonly revision?: string;
  readonly authoring?: {
    readonly placement?: { readonly operation?: string };
  };
}

export interface AuthoredSceneFact {
  readonly id: string;
  readonly guid: string | null;
}

/**
 * Catalog/workspace scene activation SSOT. Callers supply catalog provenance and
 * the persistence-owned authored manifest; UI code only projects this result.
 */
export function describeSceneActivation(
  asset: SceneActivationAssetFacts,
  authoredScenes: readonly AuthoredSceneFact[],
  revision: string,
): SceneActivationDescriptor | null {
  if (asset.kind !== 'scene') return null;
  const authored = authoredScenes.find((scene) => scene.guid !== null
    && scene.guid.toLowerCase() === asset.guid.toLowerCase());
  if (authored !== undefined) {
    return {
      subjectKind: 'scene',
      provenance: 'authored-pack',
      revision,
      sourceKey: asset.packageUrl,
      guid: asset.guid,
      mode: 'open-authored',
      authoredSceneId: authored.id,
      canPreview: true,
      canMount: false,
      canEditInstance: true,
      canEditSource: false,
      canPromote: false,
      unavailable: {
        mount: { reason: 'Authored scenes open as documents.', recoveryActions: ['switchSceneFile'] },
      },
    };
  }

  const canMount = asset.authoring?.placement?.operation === 'addSceneAssetToScene';
  return {
    subjectKind: 'scene',
    provenance: 'imported-output',
    revision: asset.revision ?? revision,
    sourceKey: asset.sourceKey ?? asset.guid,
    ...(asset.metaPath === undefined ? {} : { metaPath: asset.metaPath }),
    guid: asset.guid,
    mode: 'preview-imported',
    canPreview: true,
    canMount,
    canEditInstance: canMount,
    // The current Engine producer capability has no stable source-authoring
    // contract. Keep this producer-derived and fail closed; never infer support
    // from a source extension, importer, path, or sidecar presence.
    canEditSource: false,
    canPromote: true,
    unavailable: {
      editSource: {
        reason: 'Engine source authoring is unavailable until a stable node identity and apply/fold contract is published.',
        recoveryActions: ['awaitEngineSourceAuthoringUpdate'],
      },
    },
  };
}
