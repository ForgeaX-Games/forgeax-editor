// viewport-param-gizmo — parameter gizmos (design §3).
//
// Visualizes a selected Camera's frustum as frame-local editor chrome. The
// cached dots are available both to the compatibility DebugDraw path and to
// the editor's filled scene-after RenderFeature.
//
// No editorWorld entity is created for this visual aid. Component reads still
// go through gateway.activeWorld (sceneWorld) via the caller-supplied helpers.

import type { EntityHandle } from '@forgeax/engine-ecs';
import type { Vec3 as EngineVec3 } from '@forgeax/engine-math';

import type { Vec3 } from './viewport-ray';
import { num } from './viewport-ray';
import { cameraGizmoPoints, cameraGizmoSegments } from './viewport-gizmo-geometry';
import type { GizmoOverlayVertex } from './gizmo-overlay-geometry';
import { appendOverlayBox, overlayColorFromSrgb } from './gizmo-overlay-geometry';
import type { GizmoOverlayDraw } from './viewport-gizmo';
import type { EditorTransform } from './viewport-entity-read';

const PARAM_GIZMO_COLOR_SRGB: [number, number, number, number] = [1.0, 0.82, 0.25, 1];
const PARAM_GIZMO_COLOR_LINEAR = overlayColorFromSrgb([1.0, 0.82, 0.25]);

function toEngineVec3(value: Vec3): EngineVec3 {
  return value as unknown as EngineVec3;
}

export interface ParamGizmoDeps {
  /** Selected entity handle (null when nothing is selected). */
  getSelection(): EntityHandle | null;
  /** Component-name → POD map for the selected entity (empty when no sel or
   *  the entity was deleted; drives camera detection). */
  getSelectionComponents(): Record<string, unknown> | undefined;
  /** World-space Transform of the selected entity (used for center + wireframe
   *  orientation). */
  getSelectionWorldTransform(): EditorTransform | undefined;
  /** Aux-entity visibility gate (w23, D-5). */
  isAuxVisible(): boolean;
  /** View scale in world units at a given point (frustum size ∝ view scale). */
  getViewScale(anchor: Vec3): number;
  /** Current camera aspect (needed by cameraGizmoSegments for frustum shape). */
  getAspect(): number;
}

export interface ParamGizmo {
  update(): void;
  /** Emit the cached frustum into the post-scene DebugDraw overlay. */
  drawOverlay(draw: GizmoOverlayDraw): void;
  /** Return the cached solid dot geometry for the scene-after RenderFeature. */
  getOverlayVertices(): GizmoOverlayVertex[];
  dispose(): void;
}

/** Build the parameter-gizmo pool (camera frustum). */
export function createParamGizmo({
  getSelection, getSelectionComponents,
  getSelectionWorldTransform, isAuxVisible, getViewScale, getAspect,
}: ParamGizmoDeps): ParamGizmo {
  let segments: Array<readonly [Vec3, Vec3]> = [];
  let points: Vec3[] = [];
  let dotSize = 0;

  function clear(): void {
    segments = [];
    points = [];
    dotSize = 0;
  }

  function update(): void {
    if (!isAuxVisible()) {
      clear();
      return;
    }
    const sel = getSelection();
    // M7-a (AC-15): the selected entity's components come from the world (SSOT),
    // not the deleted doc.entities mirror. Empty map → entity gone → hide dots.
    const comps = sel !== null ? getSelectionComponents() : undefined;
    if (!comps || Object.keys(comps).length === 0) {
      clear();
      return;
    }
    const t = getSelectionWorldTransform();
    const center: Vec3 = [num(t?.x, 0), num(t?.y, 0), num(t?.z, 0)];
    const cam = comps.Camera as Record<string, unknown> | undefined;
    if (!cam) {
      clear();
      return;
    }

    // Camera.fov is engine-native radians. Only Transform Euler overlays use
    // degrees; cameraGizmoSegments preserves the camera's native units.
    const scale = getViewScale(center);
    points = cameraGizmoPoints(cam, center, t, scale, getAspect());
    segments = cameraGizmoSegments(cam, center, t, scale, getAspect());
    dotSize = Math.max(0.05, scale * 0.006);
  }

  function drawOverlay(draw: GizmoOverlayDraw): void {
    if (!isAuxVisible()) return;
    for (const [from, to] of segments) {
      draw.line(toEngineVec3(from), toEngineVec3(to), PARAM_GIZMO_COLOR_SRGB);
    }
  }

  function getOverlayVertices(): GizmoOverlayVertex[] {
    if (!isAuxVisible() || points.length === 0) return [];
    const out: GizmoOverlayVertex[] = [];
    for (const point of points) {
      appendOverlayBox(
        out,
        point,
        [dotSize, dotSize, dotSize],
        [0, 0, 0, 1],
        PARAM_GIZMO_COLOR_LINEAR,
      );
    }
    return out;
  }

  return { update, drawOverlay, getOverlayVertices, dispose: clear };
}
