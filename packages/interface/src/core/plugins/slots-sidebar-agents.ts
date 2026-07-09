// packages/interface/src/core/plugins/slots-sidebar-agents.ts
import type React from 'react';
import type { AppPlugin } from '../app-shell/types';

export function createSlotsSidebarAgentsPlugin(SidebarAgents: React.ComponentType): AppPlugin {
  return {
    id: 'slots.sidebar-agents', version: '1.0.0',
    requires: ['panels'],
    setup(ctx) { return ctx.contributePanels({ slots: { SidebarAgents } }); },
  };
}
