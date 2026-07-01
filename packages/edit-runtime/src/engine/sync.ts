// Engine sync — projects the authored EditSession onto the engine's NATIVE
// scene pipeline, INCREMENTALLY. Instead of tearing down + rebuilding the whole
// scene on every edit (a one-frame flash), it diffs the new projection against the
// last one and applies only the delta:
//
//   • value-only change (move / scale / rotate / recolour / relight / mesh-kind)
//     → `world.set(entity, Component, data)` in place — NO rebuild, NO flash.
//   • structural change (entity added/removed, a component added/removed e.g.
//     castShadow toggled, light type swapped) → full native re-instantiate
//     (`assets.instantiate(SceneAsset)`) — one flash, only on these rarer edits.
//
// First build is a native instantiate. Both paths render through the engine-native
// scene-instance machinery (same as ▶ Play). Live drag uses `worldEntityFor` +
// `world.set` directly (committed as one command on release).
import {
  sceneEntities,
  instantiateSceneEntities,
  makeSceneCaches,
  SCENE_COMPONENT_TOKENS,
  type SceneEntity,
  type SceneCaches,
} from '@forgeax/editor-core';
import type { EntityId } from '@forgeax/editor-core';
import { bus } from '@forgeax/editor-shared';

interface WorldLike {
  set(entity: number, component: unknown, data: unknown): unknown;
  /**
   * Tear down a scene instance + every owned member. Engine 5dfeb0b6
   * (feat-20260608-scene-nesting-ecs-fication) replaced the legacy
   * `world.sceneInstances.despawnInstance(numericId)` registry with the
   * synthetic-root + `despawnScene(root)` ECS pattern.
   */
  despawnScene(root: number): unknown;
}
interface RendererLike { assets: unknown }

export interface EngineSync {
  /** Rebuild/patch the rendered world from the current doc. Called on every bus change. */
  resync(): void;
  /** Force a rebuild even when the doc is unchanged. Used when an EXTERNAL input
   *  the projection depends on (e.g. an async GLB landing in the gltf-runtime
   *  cache) changes — the doc sig is identical, so plain resync() would no-op.
   *  Also the 'world-rebuild' tier of the hot-reload two-tier (D-8): when a
   *  script change alters a component schema, hot-reload.ts drops the world and
   *  calls this to re-instantiate from the SceneAsset. */
  forceResync(): void;
  /** The live forgeax entity rendering doc entity `id`, if any (for viewport drag). */
  worldEntityFor(id: EntityId): number | undefined;
  /** The synthetic root of the doc-projected scene instance (carries the
   *  `SceneInstance` component), or `undefined` before the first build. This is
   *  the doc-projection source for ▶ Play's BootstrapContext.defaultSceneRoot
   *  (D-1a): the game's bootstrap receives the scene EngineSync already built
   *  from bus.doc, NOT a forge.json GUID re-instantiate (which would duplicate). */
  sceneRoot(): number | undefined;
  /** Stop listening to the bus. */
  dispose(): void;
}

interface RenderedEntity { entity: number; comps: Record<string, Record<string, unknown>> }

const keySig = (comps: Record<string, unknown>): string => Object.keys(comps).sort().join('|');

/**
 * Wire the bus to a forgeax world via the engine-native scene pipeline, with
 * incremental diff-patch (see module note). Persistent mesh/material caches mean
 * unchanged content keeps stable handles, so the diff sees "no change" and skips it.
 */
export function createEngineSync(
  world: WorldLike,
  renderer: RendererLike,
  resolveMaterialAsset?: (guid: string) => unknown | null,
  resolveMeshAsset?: (guid: string) => unknown | null,
  resolveMeshSubmeshCount?: (guid: string) => number | undefined,
): EngineSync {
  const caches: SceneCaches = makeSceneCaches();
  // doc entity id → { live engine entity, last-applied components }.
  let rendered = new Map<EntityId, RenderedEntity>();
  // Synthetic-root Entity carrying the scene's `SceneInstance` component
  // (teardown handle for `world.despawnScene`), or null before the first build.
  let instanceRoot: number | null = null;
  // Skip no-op rebuilds: compare the bus's monotonic revision instead of hashing
  // the whole doc on every notification (resync only ever runs on a bus
  // notification or forceResync, and every notifying path bumps bus.rev, so rev
  // is a complete + O(1) change signal). `-1` forces the first/forced run.
  let lastRev = -1;
  const ctx = { world, assets: renderer.assets, resolveMaterialAsset, resolveMeshAsset, resolveMeshSubmeshCount } as never;

  function despawnInstance(): void {
    if (instanceRoot !== null) {
      try { world.despawnScene(instanceRoot); } catch { /* already gone */ }
      instanceRoot = null;
    }
  }

  function fullRebuild(entities: SceneEntity[]): void {
    despawnInstance();
    rendered = new Map();
    const r = instantiateSceneEntities(entities, ctx);
    if (!r) { console.error('[editor] native scene instantiate failed'); lastRev = -1; return; }
    instanceRoot = r.instanceRoot;
    for (const e of entities) {
      const entity = r.byDoc.get(e.docId);
      if (entity !== undefined) rendered.set(e.docId, { entity, comps: e.components });
    }
  }

  function patch(entities: SceneEntity[]): void {
    for (const e of entities) {
      const rec = rendered.get(e.docId);
      if (!rec) continue; // shouldn't happen (key-set check guarantees presence)
      for (const [name, data] of Object.entries(e.components)) {
        if (JSON.stringify(data) === JSON.stringify(rec.comps[name])) continue;
        const token = SCENE_COMPONENT_TOKENS[name];
        if (token === undefined) continue;
        try { world.set(rec.entity, token, data); } catch { /* entity gone — next resync heals */ }
      }
      rec.comps = e.components;
    }
  }

  function resync(): void {
    if (bus.rev === lastRev) return;
    lastRev = bus.rev;

    let entities: SceneEntity[];
    try {
      entities = sceneEntities(bus.doc, ctx, caches).entities;
    } catch (err) {
      console.error('[editor] sceneEntities threw:', (err as Error)?.message ?? err, (err as Error)?.stack ?? '');
      lastRev = -1;
      return;
    }

    // Structural when the entity SET or any entity's component KEY-SET changed.
    // (Pure value changes — incl. mesh-kind/material handle swaps — stay patchable.
    //  Order is irrelevant: we patch by docId, not position.)
    let structural = instanceRoot === null || entities.length !== rendered.size;
    if (!structural) {
      for (const e of entities) {
        const rec = rendered.get(e.docId);
        if (!rec || keySig(e.components) !== keySig(rec.comps)) { structural = true; break; }
      }
    }

    if (structural) fullRebuild(entities);
    else patch(entities);
  }

  const unsub = bus.subscribe(() => resync());
  resync();

  return {
    resync,
    forceResync() { lastRev = -1; resync(); },
    worldEntityFor: (id) => rendered.get(id)?.entity,
    sceneRoot: () => (instanceRoot === null ? undefined : instanceRoot),
    dispose() { unsub(); despawnInstance(); rendered = new Map(); },
  };
}
