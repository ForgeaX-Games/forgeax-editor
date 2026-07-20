// packages/interface/src/core/extensions/overlays-settings.ts
import type React from 'react';
import type { AppExtension } from '../app-shell/types';

export function createOverlaysSettingsExtension(Settings: React.ComponentType): AppExtension {
  return {
    id: 'overlays.settings', version: '1.0.0',
    contributes: { panels: { overlays: { Settings } } },
  };
}
