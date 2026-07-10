// createEditorWorld — assemble the lightweight editorWorld (plan-strategy §2 D-2).
//
// feat-20260709-editor-world-partition-editorworld-super-composite / M4 (w18).
//
// editorWorld is the editor's OWN engine World — it carries only editor-authored
// entities (the orbit camera + gizmo/param-gizmo overlays), never the authored
// scene. It is a bare `new World()` plus `transformPlugin()` (the sole writer of
// the derived Transform.world mat4 — plugin-factories.ts), which is all the
// renderer needs to read a per-frame-updated transform for those entities.
//
// This mirrors play-assemble.ts:187/199's precedent: an editor-side `new World()`
// is a LEGAL construction (lint-no-second-world scans the engine submodule diff
// only — editor source is out of its scan domain by design, AGENTS.md invariant 4
// + research F3). We assemble ONLY transformPlugin — no scene-capable装配 (asset /
// physics / animation / input): editorWorld content is 100% per-frame editor
// writes whose only engine dependency is propagateTransforms. Replicating the
// full createApp装配 here would be AGENTS.md anti-pattern #1 (parallel re-impl).
//
// Anchors:
//   plan-strategy §2 D-2 (editorWorld = new World() + transformPlugin())
//   play-assemble.ts:187/199 (new World() + plugin-factory precedent)
//   AGENTS.md invariant 4 (editor-side new World() out of no-second-world scan)

import { World } from '@forgeax/engine-ecs';
import { transformPlugin } from '@forgeax/engine-runtime';

/**
 * Build a fresh editorWorld with only the transform system registered.
 *
 * The returned World is ready to receive editor entities (camera / gizmo) via a
 * dedicated EngineFacade and to be updated once per frame by the app frame-loop
 * (as an injected drawSource world — D-3). It is NOT scene-capable and must never
 * hold authored geometry.
 */
export function createEditorWorld(): World {
  const world = new World();
  // transformPlugin.build(world) registers propagateTransforms — the sole writer
  // of Transform.world, which the renderer reads for the camera + gizmo entities.
  transformPlugin().build(world);
  return world;
}
