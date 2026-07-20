/**
 * Asset spawn bridge — listens for addAssetToScene events on the typed editor
 * bus (single-realm M2/M4: panels and surfaces share the same host window).
 */
import { spawnAssetRefToScene, panelBridge, type DragAssetRef } from '@forgeax/editor-core';

export { spawnAssetRefToScene };

/** Returns a disposer that removes the listener (used by the single-realm host's
 *  cross-game teardown so a switch doesn't stack N spawn listeners). */
export function installAssetSpawnBridge(): () => void {
  return panelBridge.on('addAssetToScene', (ref) => {
    void spawnAssetRefToScene(ref);
  });
}

/**
 * Viewport drop zone — drag a Content Browser asset onto the viewport to spawn it.
 *
 * Content Browser emits `dragAssetStart`/`dragAssetEnd` on the typed bridge; this
 * listener owns the matching viewport gesture in the same realm. The drop routes
 * through the SAME live gateway spawn path as Add-to-Scene (spawnAssetRefToScene →
 * gateway.dispatch), so both are one op (undo/ledger/AI-equal).
 *
 * Returns a disposer for cross-game teardown (registered via registerTeardown).
 */
export function installViewportDropZone(container: HTMLElement): () => void {
  let pending: DragAssetRef | null = null;
  const offStart = panelBridge.on('dragAssetStart', (ref) => { pending = ref; });
  const offEnd = panelBridge.on('dragAssetEnd', () => { pending = null; });

  const onDragOver = (e: DragEvent): void => {
    if (!pending) return; // not a Content Browser asset drag — let it pass
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (e: DragEvent): void => {
    const ref = pending;
    if (!ref) return;
    e.preventDefault();
    pending = null;
    void spawnAssetRefToScene(ref);
  };
  container.addEventListener('dragover', onDragOver);
  container.addEventListener('drop', onDrop);

  return () => {
    offStart();
    offEnd();
    container.removeEventListener('dragover', onDragOver);
    container.removeEventListener('drop', onDrop);
  };
}
