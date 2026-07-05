/**
 * Fallback: shell postMessage path (FORGEAX_ADD_ASSET_TO_SCENE) when Add to Scene
 * is triggered outside the BroadcastChannel panel flow.
 */
import { spawnAssetRefToScene } from '@forgeax/editor-core';
import type { DragAssetRef } from '@forgeax/editor-core';

export { spawnAssetRefToScene };

/** Returns a disposer that removes the listener (used by the single-realm host's
 *  cross-game teardown so a switch doesn't stack N spawn listeners). */
export function installAssetSpawnBridge(): () => void {
  const onMessage = (ev: MessageEvent): void => {
    const d = ev.data as { type?: string; ref?: DragAssetRef } | null;
    if (d?.type === 'FORGEAX_ADD_ASSET_TO_SCENE' && d.ref) {
      void spawnAssetRefToScene(d.ref);
    }
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
