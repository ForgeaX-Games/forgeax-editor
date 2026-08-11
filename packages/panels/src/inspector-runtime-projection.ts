import type { EntityHandle } from '@forgeax/editor-core';

export interface InspectorRuntimeEntityProjection {
  readonly id: EntityHandle;
  readonly name: string;
  readonly components: Readonly<Record<string, unknown>>;
  /** Present for a derived SceneInstance member whose authored edits are overrides. */
  readonly sceneInstance?: {
    readonly root: EntityHandle;
    readonly member: EntityHandle;
  };
}

/** Disposable Inspector cache. Entity/component authority remains in Runtime. */
export interface InspectorRuntimeProjection {
  readonly selectionIds: readonly EntityHandle[];
  /** Selected entities in selection order; the final entry is the primary. */
  readonly entities: readonly InspectorRuntimeEntityProjection[];
  /** Compatibility convenience for consumers that only need the primary. */
  readonly entity?: InspectorRuntimeEntityProjection;
}
