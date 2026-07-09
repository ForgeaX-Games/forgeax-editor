// packages/interface/src/core/plugins/detached-agents-browser.ts
import type React from 'react';
import type { AppPlugin } from '../app-shell/types';

export function createDetachedAgentsBrowserPlugin(AgentsBrowser: React.ComponentType): AppPlugin {
  return {
    id: 'detached.agents-browser', version: '1.0.0',
    requires: ['panels'],
    setup(ctx) { return ctx.contributePanels({ detached: { AgentsBrowser } }); },
  };
}
