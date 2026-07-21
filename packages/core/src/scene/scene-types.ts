// EditSession — the editor's authoring working state.
//
// EditSession = {world, registry}. All entity state (name, components,
// hierarchy, hidden) lives in the engine World — handle IS identity.
// The session holds no id-to-handle mapping; every read/write face takes an
// EntityHandle.

import type { SceneAsset } from '@forgeax/engine-types';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';

/** Engine World handle type — alias of the engine `World` class type. */
export type WorldType = World;

/** Engine entity handle — the branded number identifying an ECS row.
 *  Re-exported from the engine ecs barrel so editor-family consumers get it
 *  through @forgeax/editor-core without knowing about engine-ecs. */
export type { EntityHandle };

export type EntityId = number;

/** Provenance: which Workbench source produced this instance (enables edit-source
 *  round-trip back to the originating plugin). */
export interface EntitySource {
  plugin: string;
  docId: string;
}

/**
 * The editor's authoring working state.
 *
 * All entity state (name, components, hierarchy, hidden) lives in the engine
 * World — handle IS identity. The session holds no id-to-handle mapping; every
 * read/write face takes an EntityHandle.
 */
export interface EditSession {
  /** The single engine World that is the authoritative entity container.
   *  Injected by edit-runtime at boot. */
  world: WorldType;
  /** The engine AssetRegistry for rootsToSceneAsset GUID reverse lookup.
   *  Injected by edit-runtime at boot; used by worldToPack. */
  registry?: AssetRegistry;
}