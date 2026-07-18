// assets/asset-hmr-bridge.ts — browser-side listener for the pack plugin's
// actual runtime contract. Asset changes are notifications only; the PanelBridge
// refresh path owns invalidation and UI updates.

import { broadcastAssetsChanged } from '../store/store';

interface ViteHotContext {
  on(event: string, cb: (...args: unknown[]) => void): void;
  off(event: string, cb: (...args: unknown[]) => void): void;
}

let activeDispose: (() => void) | null = null;

/** Install the single runtime asset-change listener for an editor document. */
export function installAssetHmrBridge(): () => void {
  if (activeDispose) return activeDispose;

  const hot = (import.meta as unknown as { hot?: ViteHotContext }).hot;
  if (!hot) return () => {};

  const onAssetChanged = (data: unknown): void => {
    const change = data as { file?: string; kind?: 'sidecar' | 'source' };
    if (change?.kind === 'sidecar') {
      broadcastAssetsChanged('pack-changed');
    }
  };

  hot.on('forgeax:asset-changed', onAssetChanged);
  activeDispose = () => {
    hot.off('forgeax:asset-changed', onAssetChanged);
    activeDispose = null;
  };
  return activeDispose;
}
