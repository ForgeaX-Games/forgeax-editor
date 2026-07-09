// packages/interface/src/core/plugins/surfaces-scene-editor.ts
import type React from 'react';
import type { AppPlugin } from '../app-shell/types';

export function createSurfacesSceneEditorPlugin(
  SceneEditor: React.ComponentType<{ viewportOnly?: boolean }>,
): AppPlugin {
  return {
    id: 'surfaces.scene-editor', version: '1.0.0',
    requires: ['panels'],
    setup(ctx) {
      return ctx.contributePanels({ surfaces: { SceneEditor } });
    },
  };
}
