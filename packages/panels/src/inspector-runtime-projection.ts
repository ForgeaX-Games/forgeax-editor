import type {
  EditorWorldProjection,
  EntityHandle,
  ViewportRuntimeClientSnapshot,
} from '@forgeax/editor-core';

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
  /** Projected editor world chrome entities (e.g. orbit camera). */
  readonly editorWorld?: EditorWorldProjection;
}

/**
 * A local carrier is the in-process Studio path: its Gateway owns the live
 * world, so the schema-driven local Inspector remains authoritative. Every
 * other ready carrier is a disposable shell projection and must use Runtime
 * data, even when the shell exposes its bootstrap world through the Gateway.
 */
export function isRemoteInspectorCarrier(
  connection: Pick<ViewportRuntimeClientSnapshot, 'status' | 'runtime'>,
): boolean {
  return connection.status === 'ready'
    && connection.runtime !== null
    && connection.runtime.carrierKind !== 'local';
}
