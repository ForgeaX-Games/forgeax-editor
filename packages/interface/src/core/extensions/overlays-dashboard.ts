// packages/interface/src/core/extensions/overlays-dashboard.ts
import type React from 'react';
import type { AppExtension } from '../app-shell/types';

export function createOverlaysDashboardExtension(Dashboard: React.ComponentType): AppExtension {
  return {
    id: 'overlays.dashboard', version: '1.0.0',
    requires: ['panels'],
    setup(ctx) {
      return ctx.contributePanels({ overlays: { Dashboard } });
    },
  };
}
