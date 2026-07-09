// packages/interface/src/core/plugins/chrome-status-feeds.ts
import type React from 'react';
import type { AppPlugin } from '../app-shell/types';

export function createChromeStatusFeedsPlugin(StatusFeeds: React.ComponentType): AppPlugin {
  return {
    id: 'chrome.status-feeds', version: '1.0.0',
    requires: ['panels'],
    setup(ctx) {
      return ctx.contributePanels({ chrome: { StatusFeeds } });
    },
  };
}
