// Engine sync — projects the authored SceneDocument onto the engine's NATIVE
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
} from '../scene';
import type { EntityId } from '../core/types';
import { bus } from '../store';

interface WorldLike {
  set(entity: number, component: unknown, data: unknown): unknown;
  sceneInstances: { despawnInstance(id: number): unknown };
}
interface RendererLike { assets: unknown }

export interface EngineSync {
  /** Rebuild/patch the rendered world from the current doc. Called on every bus change. */
  resync(): void;
  /** The live forgeax entity rendering doc entity `id`, if any (for viewport drag). */
  worldEntityFor(id: EntityId): number | undefined;
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
): EngineSync {
  const caches: SceneCaches = makeSceneCaches();
  // doc entity id → { live engine entity, last-applied components }.
  let rendered = new Map<EntityId, RenderedEntity>();
  // The live SceneInstance id (teardown handle), or null before the first build.
  let instanceId: number | null = null;
  // Skip no-op rebuilds (the bus fires on snapshot/selection echoes too).
  let lastSig: string | null = null;
  const ctx = { world, assets: renderer.assets, resolveMaterialAsset } as never;

  function despawnInstance(): void {
    if (instanceId !== null) {
      try { world.sceneInstances.despawnInstance(instanceId); } catch { /* already gone */ }
      instanceId = null;
    }
  }

  function fullRebuild(entities: SceneEntity[]): void {
    despawnInstance();
    rendered = new Map();
    const r = instantiateSceneEntities(entities, ctx);
    if (!r) { console.error('[editor] native scene instantiate failed'); lastSig = null; return; }
    instanceId = r.instanceId;
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
    const sig = JSON.stringify(bus.doc);
    if (sig === lastSig) return;
    lastSig = sig;

    let entities: SceneEntity[];
    try {
      entities = sceneEntities(bus.doc, ctx, caches).entities;
    } catch (err) {
      console.error('[editor] sceneEntities threw:', (err as Error)?.message ?? err, (err as Error)?.stack ?? '');
      lastSig = null;
      return;
    }

    // Structural when the entity SET or any entity's component KEY-SET changed.
    // (Pure value changes — incl. mesh-kind/material handle swaps — stay patchable.
    //  Order is irrelevant: we patch by docId, not position.)
    let structural = instanceId === null || entities.length !== rendered.size;
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
    worldEntityFor: (id) => rendered.get(id)?.entity,
    dispose() { unsub(); despawnInstance(); rendered = new Map(); },
  };
}
