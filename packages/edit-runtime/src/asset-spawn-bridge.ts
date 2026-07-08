/**
 * Asset spawn bridge — listens for addAssetToScene events on the typed editor
 * bus (single-realm M2/M4: panels and surfaces share the same host window).
 */
import { spawnAssetRefToScene, editorBus } from '@forgeax/editor-core';

export { spawnAssetRefToScene };

/** Returns a disposer that removes the listener (used by the single-realm host's
 *  cross-game teardown so a switch doesn't stack N spawn listeners). */
export function installAssetSpawnBridge(): () => void {
  return editorBus.on('addAssetToScene', (ref) => {
    void spawnAssetRefToScene(ref);
  });
}
