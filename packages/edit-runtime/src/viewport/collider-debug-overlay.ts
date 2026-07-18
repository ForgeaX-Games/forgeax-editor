// collider-debug-overlay.ts — selection-derived Collider chrome via engine debug-draw.
//
// This is deliberately a frame-local read projection: authored Collider data
// remains in the sceneWorld SSOT; the existing engine DebugDraw owns GPU flush
// and frame-to-frame clearing. No ECS entity, gateway operation, ledger entry,
// undo step, or pack data is created for this visual aid.
//
// solo P7 round-31: bridge the existing engine debug-draw surface to the editor
// authoring viewport so Collider shapes/extents are visible while selected.

import type { DebugDraw } from '@forgeax/engine-debug-draw';
import type { ColorLike } from '@forgeax/engine-math';
import type { EntityHandle } from '@forgeax/engine-ecs';

import { colliderWireSegments } from './viewport-collider-geometry';

const SOLID_COLOR: ColorLike = [0.2, 0.75, 1, 1];
const SENSOR_COLOR: ColorLike = [1, 0.62, 0.18, 1];

type DebugDrawSurface = Pick<DebugDraw, 'line'>;

type UpdateApp = {
  readonly debugDraw?: DebugDrawSurface;
  registerUpdate(fn: (dt: number) => void): void;
};

export type ColliderDebugOverlayDeps = {
  readonly app: UpdateApp;
  readonly getSelection: () => EntityHandle | null;
  readonly getEntityComponents: (entity: EntityHandle) => Readonly<Record<string, unknown>> | undefined;
  readonly isAuxVisible: () => boolean;
  /** Selection belongs to the authored edit world, never the transient play world. */
  readonly isEditMode: () => boolean;
};

/**
 * Register the editor-only Collider overlay on the existing editor app frame
 * seam. `registerUpdate` has app lifetime, matching this overlay's single
 * boot-time registration in ViewportComponent.
 */
export function installColliderDebugOverlay({
  app,
  getSelection,
  getEntityComponents,
  isAuxVisible,
  isEditMode,
}: ColliderDebugOverlayDeps): void {
  app.registerUpdate(() => {
    const debugDraw = app.debugDraw;
    if (!debugDraw || !isEditMode() || !isAuxVisible()) return;

    const selected = getSelection();
    if (selected === null) return;

    const components = getEntityComponents(selected);
    const collider = components?.Collider;
    const transform = components?.Transform;
    if (!isRecord(collider) || !isRecord(transform)) return;

    const world = transform.world;
    const color = collider.isSensor === true ? SENSOR_COLOR : SOLID_COLOR;
    for (const segment of colliderWireSegments(collider, world)) {
      debugDraw.line(segment.from, segment.to, color);
    }
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
