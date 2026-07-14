// packages/interface/src/core/extensions/chrome-status-feeds.ts
import type React from 'react';
import type { AppExtension } from '../app-shell/types';

export function createChromeStatusFeedsExtension(StatusFeeds: React.ComponentType): AppExtension {
  return {
    id: 'chrome.status-feeds', version: '1.0.0',
    requires: ['panels'],
    setup(ctx) {
      return ctx.contributePanels({ chrome: { StatusFeeds } });
    },
  };
}
