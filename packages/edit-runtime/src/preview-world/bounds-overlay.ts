// bounds-overlay.ts — Mesh preview Bounds chrome via engine debug-draw.
//
// Frame-local read projection of the preview subject's local-space AABB. The
// subject entity stays at the origin (scale 1), so its local AABB is its world
// AABB; the overlay draws the 12-edge wireframe directly from MeshAsset.aabb.
// No ECS entity, gateway operation, ledger entry, undo step, or pack data is
// created for this visual aid — the engine DebugDraw owns GPU flush and
// frame-to-frame clearing. Mirrors collider-debug-overlay.ts (solo P7 round-31
// pattern) but reads the preview assembly's current AABB instead of a selection.

import { Update, type World } from '@forgeax/engine-ecs';
import type { DebugDraw } from '@forgeax/engine-debug-draw';
import { vec3, type ColorLike } from '@forgeax/engine-math';

const BOUNDS_COLOR: ColorLike = [0.35, 0.85, 0.55, 1];

type DebugDrawSurface = Pick<DebugDraw, 'aabb'>;

/** Current subject AABB as [minX,minY,minZ, maxX,maxY,maxZ], or null when no
 *  subject / degenerate box is loaded. */
export type BoundsOverlayAabb = readonly [number, number, number, number, number, number] | null;

export type BoundsOverlayDeps = {
  readonly world: World;
  readonly debugDraw?: DebugDrawSurface;
  /** Live read of the preview subject's local-space AABB (6 floats). */
  readonly getAabb: () => BoundsOverlayAabb;
  /** Toggle bound to the preview toolbar button. */
  readonly isVisible: () => boolean;
};

/**
 * Register the preview-only Bounds overlay as an Update system. Its lifetime
 * matches the preview world created by PreviewWorldService.
 */
export function installBoundsOverlay({
  world,
  debugDraw,
  getAabb,
  isVisible,
}: BoundsOverlayDeps): void {
  world.addSystem(Update, {
    name: 'editor-mesh-preview-bounds-overlay',
    queries: [],
    fn: () => {
      if (!debugDraw || !isVisible()) return;
      const aabb = getAabb();
      if (aabb === null) return;
      const min = vec3.create(aabb[0], aabb[1], aabb[2]);
      const max = vec3.create(aabb[3], aabb[4], aabb[5]);
      debugDraw.aabb(min, max, BOUNDS_COLOR);
    },
  }).unwrap();
}
