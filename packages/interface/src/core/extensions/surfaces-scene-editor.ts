// packages/interface/src/core/extensions/surfaces-scene-editor.ts
import type React from 'react';
import type { AppExtension } from '../app-shell/types';

export function createSurfacesSceneEditorExtension(
  SceneEditor: React.ComponentType<{ viewportOnly?: boolean }>,
): AppExtension {
  return {
    id: 'surfaces.scene-editor', version: '1.0.0',
    contributes: { panels: { surfaces: { SceneEditor } } },
  };
}
