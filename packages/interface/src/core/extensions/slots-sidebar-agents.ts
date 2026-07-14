// packages/interface/src/core/extensions/slots-sidebar-agents.ts
import type React from 'react';
import type { AppExtension } from '../app-shell/types';

export function createSlotsSidebarAgentsExtension(SidebarAgents: React.ComponentType): AppExtension {
  return {
    id: 'slots.sidebar-agents', version: '1.0.0',
    requires: ['panels'],
    setup(ctx) { return ctx.contributePanels({ slots: { SidebarAgents } }); },
  };
}
