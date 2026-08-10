import type { EntityHandle } from '@forgeax/editor-core';

export interface InspectorRuntimeEntityProjection {
  readonly id: EntityHandle;
  readonly name: string;
  readonly components: Readonly<Record<string, unknown>>;
}

/** Disposable Inspector cache. Entity/component authority remains in Runtime. */
export interface InspectorRuntimeProjection {
  readonly selectionIds: readonly EntityHandle[];
  readonly entity?: InspectorRuntimeEntityProjection;
}
