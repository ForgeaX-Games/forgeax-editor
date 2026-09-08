// gizmo-debug-overlay.ts — frame-local Editor Gizmo overlay registration.
//
// The transform and parameter gizmos are editor chrome, not authored scene
// entities. Register their draw callback on the app's Update schedule so the
// App-owned DebugDraw instance can flush them through the engine's real
// post-scene `debug-overlay` pass. This keeps gizmo geometry out of the normal
// ECS renderable stream and therefore out of GPU-driven scene rasterization.

import { Update, type World } from '@forgeax/engine-ecs';
import type { DebugDraw } from '@forgeax/engine-debug-draw';

export interface GizmoDebugOverlayDeps {
  /** The App world whose Update schedule drives the editor frame. */
  readonly world: World;
  /** App-owned immediate-mode overlay; undefined on null/headless RHI paths. */
  readonly debugDraw?: Pick<DebugDraw, 'line' | 'arrow'>;
  /** Emits the current frame's gizmo geometry into `debugDraw`. */
  readonly drawOverlay: () => void;
  /** Edit chrome must not be emitted while the viewport is in Play mode. */
  readonly isEditMode: () => boolean;
}

/**
 * Register the editor Gizmo as a frame-local DebugDraw producer.
 *
 * DebugDraw clears its staging buffer after the renderer's post-scene overlay
 * pass, so the callback must run every frame rather than only on selection or
 * camera changes.
 */
export function installGizmoDebugOverlay({
  world,
  debugDraw,
  drawOverlay,
  isEditMode,
}: GizmoDebugOverlayDeps): void {
  world.addSystem(Update, {
    name: 'editor-gizmo-debug-overlay',
    queries: [],
    fn: () => {
      if (debugDraw === undefined || !isEditMode()) return;
      drawOverlay();
    },
  }).unwrap();
}
