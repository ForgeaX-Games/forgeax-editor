// EditSession — the editor's authoring working state (M7: EntityNode deleted).
//
// feat-20260701-editor-world-container-doc-ecs-collapse M7 / AC-15:
// EntityNode interface + all authorized component types (TransformData, MeshData,
// MaterialData, LightData, ColliderData, ColliderShape, Collider) deleted.
// EditSession now carries only `world` + optional `registry` — the engine World
// is the SSOT for all entity state. Legacy ID → engine handle mapping is
// internal to applyCommand (document.ts internals), not on the interface.
//
// Anchors:
//   requirements AC-15: grep EntityNode/doc.entities editor-proper zero hits
//   plan-strategy S7 M7: type sweep — EditSession only world(+registry)

import type { SceneAsset } from '@forgeax/engine-types';
import { World } from '@forgeax/engine-ecs';

/** Engine World handle type (plan-strategy S2 D-1 / AC-01).
 *  Use InstanceType<typeof World> to avoid TS2709 when the module shim
 *  exports a class with a companion namespace. */
export type WorldType = InstanceType<typeof World>;

/** Engine entity handle — the branded number identifying an ECS row.
 *  Derived from the engine `World.despawn` signature via the value-space `World`
 *  class (same channel as `WorldType` above): yields the engine's EXACT branded
 *  type, assignable across all world APIs, while avoiding the TS2709 namespace
 *  resolution of a direct `import type { EntityHandle }`. */
export type EntityHandle = Parameters<WorldType['despawn']>[0];

export type EntityId = number;

/** Provenance: which Workbench source produced this instance (enables edit-source
 *  round-trip back to the originating plugin). */
export interface EntitySource {
  plugin: string;
  docId: string;
}

/**
 * The editor's authoring working state (M7: stripped to world + registry).
 *
 * All entity state (name, components, hierarchy, hidden) lives in the engine
 * World. Legacy ID → engine handle mapping is internal to document.ts
 * (SessionInternals), not exposed on the interface.
 */
export interface EditSession {
  /** feat-20260701-editor-world-container-doc-ecs-collapse M1-M7 / AC-01:
   *  The single engine World that is the authoritative entity container.
   *  Injected by edit-runtime at boot; M7 sweeps all EntityNode/doc.entities
   *  dual-write mirror and projection layer — world is now the SSOT for all
   *  entity reads and writes. */
  world: WorldType;
  /** feat-20260701-editor-world-container-doc-ecs-collapse M5 / AC-08:
   *  The engine AssetRegistry for rootsToSceneAsset GUID reverse lookup.
   *  Injected by edit-runtime at boot; used by worldToPack in store.ts. */
  registry?: unknown;
}