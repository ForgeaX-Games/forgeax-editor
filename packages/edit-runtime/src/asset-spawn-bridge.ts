/**
 * Fallback: shell postMessage path (FORGEAX_ADD_ASSET_TO_SCENE) when Add to Scene
 * is triggered outside the BroadcastChannel panel flow.
 */
import { spawnAssetRefToScene } from '@forgeax/editor-core';
import type { DragAssetRef } from '@forgeax/editor-core';

export { spawnAssetRefToScene };

export function installAssetSpawnBridge(): void {
  window.addEventListener('message', (ev) => {
    const d = ev.data as { type?: string; ref?: DragAssetRef } | null;
    if (d?.type === 'FORGEAX_ADD_ASSET_TO_SCENE' && d.ref) {
      void spawnAssetRefToScene(d.ref);
    }
  });
}
