// packages/interface/src/core/plugins/detached-files-browser.ts
import type React from 'react';
import type { AppPlugin } from '../app-shell/types';

export function createDetachedFilesBrowserPlugin(FilesBrowser: React.ComponentType): AppPlugin {
  return {
    id: 'detached.files-browser', version: '1.0.0',
    requires: ['panels'],
    setup(ctx) { return ctx.contributePanels({ detached: { FilesBrowser } }); },
  };
}
