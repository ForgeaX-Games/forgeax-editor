// packages/interface/src/core/extensions/detached-files-browser.ts
import type React from 'react';
import type { AppExtension } from '../app-shell/types';

export function createDetachedFilesBrowserExtension(FilesBrowser: React.ComponentType): AppExtension {
  return {
    id: 'detached.files-browser', version: '1.0.0',
    contributes: { panels: { detached: { FilesBrowser } } },
  };
}
