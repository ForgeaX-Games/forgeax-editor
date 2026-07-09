// packages/interface/src/core/plugins/overlays-dashboard.ts
import type React from 'react';
import type { AppPlugin } from '../app-shell/types';

export function createOverlaysDashboardPlugin(Dashboard: React.ComponentType): AppPlugin {
  return {
    id: 'overlays.dashboard', version: '1.0.0',
    requires: ['panels'],
    setup(ctx) {
      return ctx.contributePanels({ overlays: { Dashboard } });
    },
  };
}
