// createDrawSource — the per-frame draw-source pull factory (plan-strategy §2 D-3).
//
// feat-20260709-editor-world-partition-editorworld-super-composite / M4 (w18).
//
// The engine's createApp `drawSource?` option is a per-frame callback returning
// `{ worlds, cameraOwner, resourceOwner } | undefined` (create-app.ts). The
// frame-loop pulls it each tick, updates every injected world once (so
// propagateTransforms resolves same-frame writes — the anti-stale-matrix
// contract, D-3), then draws `renderer.draw(worlds, { cameraOwner, resourceOwner })`.
//
// The composite draw-source feeds BOTH worlds:
//   worlds        = [editorWorld, sceneWorld]
//   cameraOwner   = 0  → editorWorld supplies the (editor orbit) camera
//   resourceOwner = 1  → sceneWorld supplies skybox / skylight / postProcess
//
// sceneWorld is resolved LAZILY each frame via the injected getter — it is
// `gateway.doc.world`, which is re-assigned on a scene swap (replaceDoc). Reading
// it fresh per frame keeps the composite pointed at the live scene world without a
// second reference to keep in sync (Derive discipline). If the scene world is not
// yet injected (boot race), the callback returns undefined so the frame-loop falls
// back to the single-world path (editorWorld only) — no crash, no black loop.
//
// Anchors:
//   plan-strategy §2 D-3 (drawSource shape + owner split + injected-world update)
//   requirements S6 (camera-owner=editorWorld, resource-owner=sceneWorld)
//   requirements AC-07 (composite wiring rides the draw-source seam, no parallel rAF)

import type { World } from '@forgeax/engine-ecs';
import { WORLD_REF_EDITOR, WORLD_REF_SCENE } from './WorldBinding';

/** The draw-source return shape the engine frame-loop consumes (D-3). */
export interface DrawSourceResult {
  readonly worlds: readonly World[];
  readonly cameraOwner: number;
  readonly resourceOwner: number;
}

/**
 * Build the per-frame composite draw-source callback.
 *
 * @param editorWorld  the editor-owned world (camera + gizmo); cameraOwner=0.
 * @param getSceneWorld lazy accessor for the live scene world (doc.world);
 *        resourceOwner=1. Returns undefined until injected.
 */
export function createDrawSource(
  editorWorld: World,
  getSceneWorld: () => World | undefined,
): () => DrawSourceResult | undefined {
  return () => {
    const sceneWorld = getSceneWorld();
    if (sceneWorld === undefined) return undefined;
    return {
      // Index order is the SSOT for the owner references (WORLD_REF_*): editor at
      // WORLD_REF_EDITOR(0), scene at WORLD_REF_SCENE(1).
      worlds: [editorWorld, sceneWorld],
      cameraOwner: WORLD_REF_EDITOR,
      resourceOwner: WORLD_REF_SCENE,
    };
  };
}

/**
 * Build the same editor-camera composite for a transient play world. The play
 * App owns the live frame loop, while the editorWorld remains the sole home of
 * the orbit camera and gizmos; the two worlds therefore stay identity-isolated
 * and only meet at the renderer's declared owner split.
 */
export function createPlayDrawSource(
  editorWorld: World,
  playWorld: World,
  isEditorView: () => boolean,
): () => DrawSourceResult | undefined {
  return () => {
    if (!isEditorView()) {
      // play·game falls through to playApp's own single-world renderer path,
      // preserving its game-camera selection without a cross-world camera id.
      return undefined;
    }
    return {
      // play·scene: editor orbit camera + live simulation world.
      worlds: [editorWorld, playWorld],
      cameraOwner: WORLD_REF_EDITOR,
      resourceOwner: WORLD_REF_SCENE,
    };
  };
}
