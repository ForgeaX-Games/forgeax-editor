// packages/interface/src/core/extensions/detached-agents-browser.ts
import type React from 'react';
import type { AppExtension } from '../app-shell/types';

export function createDetachedAgentsBrowserExtension(AgentsBrowser: React.ComponentType): AppExtension {
  return {
    id: 'detached.agents-browser', version: '1.0.0',
    requires: ['panels'],
    setup(ctx) { return ctx.contributePanels({ detached: { AgentsBrowser } }); },
  };
}
