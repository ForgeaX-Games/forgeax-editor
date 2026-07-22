// viewport-param-gizmo — parameter gizmos (design §3).
//
// Visualizes a selected Light's range/spot cone and a Camera's frustum as
// dotted world-space wireframes (non-interactive). Built from a reused cube-
// dot pool; rebuilt cheaply via placeDots (only spawns when the dot count
// changes), so orbiting just re-sets transforms.
//
// M4 (w20): param-gizmo assets + entities live in the editorWorld
// (editorEngine). Component reads still go through gateway.activeWorld
// (sceneWorld) via the caller-supplied getSelectionComponents helper.

import { Transform, Materials } from '@forgeax/engine-runtime';
import type { EntityHandle, Handle } from '@forgeax/engine-ecs';
import type { EngineFacade } from '@forgeax/editor-core';

import type { Vec3 } from './viewport-ray';
import { num } from './viewport-ray';
import { cameraGizmoPoints, lightGizmoPoints } from './viewport-gizmo-geometry';
import type { EditorTransform } from './viewport-entity-read';

export interface ParamGizmoDeps {
  /** editorWorld facade — param-gizmo entities/assets are minted here. */
  editorEngine: EngineFacade;
  /** Spawn a HANDLE_CUBE mesh entity — shared with the interactive gizmo pool
   *  (both are dot-clouds of the same primitive; keep one materialisation). */
  spawnHandleCube(material: Handle<'MaterialAsset', 'shared'>): EntityHandle;
  /** Selected entity handle (null when nothing is selected). */
  getSelection(): EntityHandle | null;
  /** Component-name → POD map for the selected entity (empty when no sel or
   *  the entity was deleted; drives light/camera detection). */
  getSelectionComponents(): Record<string, unknown> | undefined;
  /** World-space Transform of the selected entity (used for center + wireframe
   *  orientation). */
  getSelectionWorldTransform(): EditorTransform | undefined;
  /** Aux-entity visibility gate (w23, D-5). */
  isAuxVisible(): boolean;
  /** Current camera distance (dot size ∝ dist). */
  getDist(): number;
  /** Current camera aspect (needed by cameraGizmoPoints for frustum shape). */
  getAspect(): number;
}

export interface ParamGizmo {
  update(): void;
  dispose(): void;
}

/** Build the parameter-gizmo pool (light range / spot cone / camera frustum). */
export function createParamGizmo({
  editorEngine, spawnHandleCube, getSelection, getSelectionComponents,
  getSelectionWorldTransform, isAuxVisible, getDist, getAspect,
}: ParamGizmoDeps): ParamGizmo {
  let paramEnts: EntityHandle[] = [];
  let paramMat: Handle<'MaterialAsset', 'shared'> | null = null;

  function ensureParamMat(): Handle<'MaterialAsset', 'shared'> {
    if (!paramMat) paramMat = editorEngine.allocSharedRef('MaterialAsset', Materials.unlit([1.0, 0.82, 0.25, 1], { castShadow: false }));
    return paramMat;
  }

  function despawnParam(): void {
    for (const e of paramEnts) { try { editorEngine.despawn(e); } catch { /* gone */ } }
    paramEnts = [];
  }

  function placeDots(points: Vec3[], size: number): void {
    if (points.length === 0) { despawnParam(); return; }
    const mat = ensureParamMat();
    while (paramEnts.length < points.length) paramEnts.push(spawnHandleCube(mat));
    while (paramEnts.length > points.length) {
      const e = paramEnts.pop()!; try { editorEngine.despawn(e); } catch { /* gone */ }
    }
    points.forEach((p, i) => editorEngine.set(paramEnts[i]!, Transform, {
      pos: [p[0], p[1], p[2]], scale: [size, size, size],
    }));
  }

  function update(): void {
    if (!isAuxVisible()) { despawnParam(); return; }
    const sel = getSelection();
    // M7-a (AC-15): the selected entity's components come from the world (SSOT),
    // not the deleted doc.entities mirror. Empty map → entity gone → hide dots.
    const comps = sel !== null ? getSelectionComponents() : undefined;
    if (!comps || Object.keys(comps).length === 0) { despawnParam(); return; }
    const t = getSelectionWorldTransform();
    const center: Vec3 = [num(t?.x, 0), num(t?.y, 0), num(t?.z, 0)];
    const light = comps.Light as Record<string, unknown> | undefined;
    const cam = comps.Camera as Record<string, unknown> | undefined;
    // The wireframe POINT SETS are pure geometry (viewport-gizmo-geometry.ts);
    // the engine dot-pool placement (placeDots) is the only side-effecting edge.
    const dist = getDist();
    const pts: Vec3[] = [];
    if (light) pts.push(...lightGizmoPoints(light, center, t, dist));
    if (cam) pts.push(...cameraGizmoPoints(cam, center, t, dist, getAspect()));
    placeDots(pts, Math.max(0.05, dist * 0.006));
  }

  return { update, dispose: despawnParam };
}
