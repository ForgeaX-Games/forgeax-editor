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
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { AssetRegistry } from '@forgeax/engine-runtime';

/** Engine World handle type (plan-strategy S2 D-1 / AC-01).
 *  Now a direct alias of the engine `World` class type: since every editor tsc
 *  program (the 5 sub-packages AND the repo-root program) resolves
 *  `@forgeax/engine-ecs` to its real dist `.d.ts`, `World` is a genuine class
 *  and needs no `InstanceType<typeof World>` TS2709 dodge. */
export type WorldType = World;

/** Engine entity handle — the branded number identifying an ECS row.
 *  Re-exported straight from the engine ecs barrel (its cleanly-exported
 *  `EntityHandle` branded number), so downstream `import { EntityHandle } from
 *  '@forgeax/editor-core'` keeps working. */
export type { EntityHandle };

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
 * World. M3 (I1): handle IS identity — the session holds no id-to-handle mapping
 * or internal identity state; every read/write face takes an EntityHandle.
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
  registry?: AssetRegistry;
}