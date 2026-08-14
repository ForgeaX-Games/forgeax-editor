// editor-world-projection — IoC read seam for Hierarchy/Inspector chrome.
//
// The editor orbit camera lives in WorldManager.editorWorld (AC-01). Panels
// must not import edit-runtime, and they must never mint a scene-world
// HandlePair for an editor-world handle (handle collision / pack-play litmus).
// Edit-runtime fills this provider after spawn; panels read a Camera-only
// projection. Writes stay on editorFacade. Scene-pack / Play never see these
// rows.

import type { EntityHandle } from '../scene/scene-types';

export interface EditorWorldProjectionRow {
  readonly id: EntityHandle;
  readonly name: string;
  readonly typeId: 'Camera';
  readonly camera: Record<string, unknown>;
  readonly transform: Record<string, unknown> | null;
}

export interface EditorWorldProjection {
  readonly cameraId: EntityHandle | null;
  readonly rows: readonly EditorWorldProjectionRow[];
}

export const EMPTY_EDITOR_WORLD_PROJECTION: EditorWorldProjection = Object.freeze({
  cameraId: null,
  rows: Object.freeze([]) as readonly EditorWorldProjectionRow[],
});

let provider: (() => EditorWorldProjection) | null = null;

/** Register the live editor-world Camera projection (ViewportComponent, at boot).
 *  Returns an idempotent unregister fn. */
export function registerEditorWorldProjectionProvider(
  fn: () => EditorWorldProjection,
): () => void {
  provider = fn;
  return () => {
    if (provider === fn) provider = null;
  };
}

/** Camera-only chrome rows from editorWorld, or empty when no provider is
 *  registered (headless / tests / play-runtime). */
export function getEditorWorldProjection(): EditorWorldProjection {
  return provider?.() ?? EMPTY_EDITOR_WORLD_PROJECTION;
}
