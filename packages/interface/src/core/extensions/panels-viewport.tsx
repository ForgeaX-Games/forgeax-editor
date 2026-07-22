// packages/interface/src/core/extensions/panels-viewport.tsx
//
// The viewport is a dockview panel like every other dock body. Its heavy
// SceneEditor surface is still kept alive by SurfaceKeepAliveLayer; this panel
// descriptor only renders the in-dock anchor that the keep-alive layer tracks.
import type { AppExtension } from '../app-shell/types';
import { ViewportPanel } from '../../components/MainArea/SurfacePanels';

export const panelsViewportExtension: AppExtension = {
  id: 'panels.viewport',
  version: '1.0.0',
  contributes: {
    panels: {
      panels: {
        viewport: {
          title: 'Viewport',
          order: 0,
          header: { visible: true, showTitle: false },
          content: { padding: 'none', scroll: 'none', tone: 'tool' },
          dockChrome: { singleTab: 'hideTitle' },
          render: () => <ViewportPanel />,
        },
      },
    },
  },
};
