// EditorHidden — editor-only marker component (plan-strategy D-7)
//
// An entity bearing this component is hidden from the viewport (authoring aid).
// It is an editor-only concept: it does NOT enter SceneAsset packs
// (rootsToSceneAsset excludes EditorHidden-bearing entities from collection —
// plan-strategy D-7), and it never reaches the engine runtime.
//
// hidden is per-entity, must be undo-able, and follows the entity lifecycle —
// therefore it belongs on the world as an editor-only component (not React state,
// not localStorage). The `undefined` default means "visible" (no component present
// = drawn normally); adding EditorHidden = hide; removing it = show.
//
// Anchors:
//   requirements AC-04: hidden = world editor-only component
//   requirements AC-05: hidden entities survive save→reopen
//   plan-strategy §2 D-7: EditorHidden editor-only component
//   plan-decisions D5: hidden = world component

import { defineComponent } from '@forgeax/engine-ecs';

export const EditorHidden = defineComponent('EditorHidden', {});