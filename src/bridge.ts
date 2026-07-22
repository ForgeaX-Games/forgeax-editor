// @forgeax/editor/bridge — pass-through to editor-core's host-bridge surface.
//
// Host-facing editor bridge surface. Re-exported here so hosts consume the
// facade (`@forgeax/editor/*`) instead of reaching into editor-core.
export {
  gateway,
  installInterfaceBridge,
  setContextMenuRenderer,
  panelBridge,
} from '@forgeax/editor-core';

import type { AppExtension } from '@forgeax/interface/core/app-shell/types';
import { createHierarchyPanelContributionsExtension } from './hierarchy-panel';
import {
  createViewportPanelContributionsExtension,
} from './viewport-panel';

export { createViewportPanelContributionsExtension } from './viewport-panel';
export { createHierarchyPanelContributionsExtension } from './hierarchy-panel';

export function createEditorPanelContributionsExtension(): AppExtension {
  const viewport = createViewportPanelContributionsExtension();
  const hierarchy = createHierarchyPanelContributionsExtension();
  return {
    id: 'editor.panel-contributions',
    version: '1.0.0',
    requires: ['commands', 'panelActions', 'panelControls', 'contextKeys'],
    setup(ctx) {
      const cleanups = [viewport, hierarchy]
        .map((extension) => extension.setup?.(ctx))
        .filter((cleanup): cleanup is () => void => typeof cleanup === 'function');
      return () => {
        for (const cleanup of cleanups.slice().reverse()) cleanup();
      };
    },
  };
}
