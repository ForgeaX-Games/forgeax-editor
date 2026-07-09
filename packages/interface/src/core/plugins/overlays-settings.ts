// packages/interface/src/core/plugins/overlays-settings.ts
import type React from 'react';
import type { AppPlugin } from '../app-shell/types';

export function createOverlaysSettingsPlugin(Settings: React.ComponentType): AppPlugin {
  return {
    id: 'overlays.settings', version: '1.0.0',
    requires: ['panels'],
    setup(ctx) {
      return ctx.contributePanels({ overlays: { Settings } });
    },
  };
}
