// packages/interface/src/core/extensions/slots-main-area-body.ts
import type React from 'react';
import type { AppExtension } from '../app-shell/types';

export function createSlotsMainAreaBodyExtension(MainAreaBody: React.ComponentType): AppExtension {
  return {
    id: 'slots.main-area-body', version: '1.0.0',
    requires: ['panels'],
    setup(ctx) { return ctx.contributePanels({ slots: { MainAreaBody } }); },
  };
}
