// viewport-pick-fallback.ts — CPU pick sweep over sceneWorld renderables.
//
// bug-20260806-viewport-glb-unpickable (房屋 GLB 选不中; harness feedback
// 2026-08-06-pick-needs-camera-source-decoupled-from-geometry-world):
// the engine's mesh-precise pick() requires camera + geometry in ONE world;
// post world-split the editor camera lives in editorWorld, so that path is
// guarded off (viewport.ts SUPER GUARD) and this sweep is the ONLY pick path.
// The previous sweep tested a Transform-scale unit-cube heuristic (entityBox),
// which only fits editor builtin cubes — GLB meshes carry their extents in
// MeshAsset.aabb with identity node scale, so everything outside pivot±0.5m
// missed and the click fell through to "clear selection".
//
// This sweep mirrors the engine pick algorithm with PUBLIC APIs only (no
// _getGraph / archetype internals): MeshFilter.assetHandle → resolveAssetHandle
// → MeshAsset.aabb × Transform.world → rayAABB, nearest tmin wins. When the
// mesh asset has no populated aabb the entityBox heuristic is kept as a
// per-entity fallback so builtin-cube behavior is unchanged. The candidate
// enumeration (worldRenderableHandles) covers mount-internal nodes WITHOUT a
// Name — a Name-keyed walk made unnamed GLB mesh nodes unpickable.
//
// Super constraint (S5/RD3): VALUES cross worlds (the editor-camera ray comes
// in, an entity handle goes out), identity never does. Stopgap by design:
// retire this sweep once the engine ships the decoupled pickRay entry
// requested in the feedback above.

import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { MeshFilter } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { toShared, type MeshAsset } from '@forgeax/engine-types';
import { worldRenderableHandles } from '@forgeax/editor-core';
import { isEntEffectivelyHidden, readWorldTransform } from './viewport-entity-read';
import { aabbToWorldBox, entityBox, rayAABB, type Vec3 } from './viewport-ray';

/** Nearest visible renderable entity hit by the world-space ray, or null.
 *  Returns the RAW hit handle (possibly a GLB mount-internal node); the caller
 *  resolves it to the editor-level entity (resolveEditorEntity). */
export function pickMeshFallback(world: World, origin: Vec3, dir: Vec3): EntityHandle | null {
  // Per-call MeshAsset cache: a house GLB shares one mesh across many nodes.
  const meshCache = new Map<number, MeshAsset | null>();
  let best: EntityHandle | null = null;
  let bestT = Infinity;
  for (const id of worldRenderableHandles(world)) {
    if (isEntEffectivelyHidden(world, id)) continue;

    let box: { center: Vec3; half: Vec3 } | null = null;
    const mf = world.get(id, MeshFilter);
    const raw = mf.ok ? Math.round((mf.value as { assetHandle?: number }).assetHandle ?? 0) : 0;
    if (raw !== 0) {
      let mesh = meshCache.get(raw);
      if (mesh === undefined) {
        const r = resolveAssetHandle<MeshAsset>(world, toShared<'MeshAsset'>(raw));
        mesh = r.ok ? r.value : null;
        meshCache.set(raw, mesh);
      }
      const aabb = mesh?.aabb;
      // Inverted-infinity empty box (mesh without positions): not pickable,
      // same guard as the engine pick.
      if (aabb !== undefined && !(aabb[0]! > aabb[3]!)) {
        const t = world.get(id, Transform);
        const w = t.ok ? (t.value as { world?: ArrayLike<number> }).world : undefined;
        if (w !== undefined && w.length >= 16) box = aabbToWorldBox(aabb, w);
      }
    }
    if (box === null) {
      // No usable mesh aabb (unregistered asset / legacy mesh) — keep the
      // pre-bugfix Transform-scale heuristic for this entity.
      const t = readWorldTransform(world, id);
      if (t !== undefined) box = entityBox(t);
    }
    if (box === null) continue;

    const hit = rayAABB(origin, dir, box.center, box.half);
    if (hit !== null && hit < bestT) {
      bestT = hit;
      best = id;
    }
  }
  return best;
}
