// skeleton-overlay.ts — Mesh preview Skeleton chrome via engine debug-draw.
//
// Frame-local read projection of the Scene subject's spawned joint subtree.
// A rigged mesh is previewed by instantiating its SceneAsset, which spawns the
// joint hierarchy (ChildOf) + Skin components. This overlay walks that subtree
// once per frame and draws a wireframe sphere at each joint's world translation
// plus a line to its parent joint — the same visual UE's Skeletal Mesh Editor
// shows for the skeleton. Mirrors collider-debug-overlay.ts (frame-local read,
// engine DebugDraw owns GPU flush + clearing). No ECS entity / gateway op /
// ledger entry is created for this visual aid.
//
// Mesh entities (MeshFilter with a bound asset) are skipped: only joints are
// drawn, so the overlay shows bones, not the mesh surface.

import { Update, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { DebugDraw } from '@forgeax/engine-debug-draw';
import { vec3, type ColorLike, type Vec3 } from '@forgeax/engine-math';
import { Children, Transform } from '@forgeax/engine-scene';
import { MeshFilter } from '@forgeax/engine-render';

const JOINT_COLOR: ColorLike = [0.95, 0.78, 0.25, 1];
const JOINT_RADIUS = 0.025;

type DebugDrawSurface = Pick<DebugDraw, 'line' | 'sphere'>;

export type SkeletonOverlayDeps = {
  readonly world: World;
  readonly debugDraw?: DebugDrawSurface;
  /** Live read of the Scene subject root, or null when no scene is active. */
  readonly getRoot: () => EntityHandle | null;
  /** Toggle bound to the preview toolbar button. */
  readonly isVisible: () => boolean;
};

/**
 * Register the preview-only Skeleton overlay as an Update system. Its lifetime
 * matches the preview world created by PreviewWorldService.
 */
export function installSkeletonOverlay({
  world,
  debugDraw,
  getRoot,
  isVisible,
}: SkeletonOverlayDeps): void {
  world.addSystem(Update, {
    name: 'editor-mesh-preview-skeleton-overlay',
    queries: [],
    fn: () => {
      if (!debugDraw || !isVisible()) return;
      const root = getRoot();
      if (root === null) return;

      // BFS the spawned subtree. Each entity carries Transform (world mat4,
      // translation at column-major [12,13,14]); joints are the entities
      // without a bound MeshFilter. A joint's parent translation is passed
      // down the queue so the parent→child bone line is drawn without a
      // second lookup.
      const visited = new Set<number>();
      const queue: { readonly entity: EntityHandle; readonly parentTranslation: Vec3 | null }[] = [
        { entity: root, parentTranslation: null },
      ];
      while (queue.length > 0) {
        const { entity, parentTranslation } = queue.shift() as {
          readonly entity: EntityHandle;
          readonly parentTranslation: Vec3 | null;
        };
        const id = entity as number;
        if (visited.has(id)) continue;
        visited.add(id);

        const transform = world.get(entity, Transform);
        if (!transform.ok) continue;
        const worldMat = transform.value.world;
        const translation = vec3.create(worldMat[12] ?? 0, worldMat[13] ?? 0, worldMat[14] ?? 0);

        const meshFilter = world.get(entity, MeshFilter);
        const isMesh = meshFilter.ok && (meshFilter.value.assetHandle as number) !== 0;

        if (!isMesh) {
          debugDraw.sphere(translation, JOINT_RADIUS, JOINT_COLOR);
          if (parentTranslation !== null) {
            debugDraw.line(parentTranslation, translation, JOINT_COLOR);
          }
        }

        const children = world.get(entity, Children);
        if (children.ok) {
          const entities = children.value.entities as Uint32Array;
          // Joints pass their translation to children; mesh entities pass
          // their own parent's translation through (a mesh is a leaf in a
          // rigged hierarchy, so this branch is rarely hit).
          const childParent = isMesh ? parentTranslation : translation;
          for (let i = 0; i < entities.length; i += 1) {
            queue.push({ entity: entities[i] as EntityHandle, parentTranslation: childParent });
          }
        }
      }
    },
  }).unwrap();
}
