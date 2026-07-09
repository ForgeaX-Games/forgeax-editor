// packages/interface/src/core/plugins/slots-main-area-body.ts
import type React from 'react';
import type { AppPlugin } from '../app-shell/types';

export function createSlotsMainAreaBodyPlugin(MainAreaBody: React.ComponentType): AppPlugin {
  return {
    id: 'slots.main-area-body', version: '1.0.0',
    requires: ['panels'],
    setup(ctx) { return ctx.contributePanels({ slots: { MainAreaBody } }); },
  };
}
