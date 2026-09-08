/**
 * Asset spawn bridge — listens for addAssetToScene events on the typed editor
 * bus when panels and surfaces share a host window. Viewport drops also decode
 * the serialised DataTransfer payload so a Content Browser in a shell window
 * can cross the Runtime carrier boundary without sharing a Gateway object.
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

function assetRefFromDataTransfer(dataTransfer: DataTransfer | null): DragAssetRef | null {
  if (dataTransfer === null) return null;
  try {
    const raw = dataTransfer.getData('application/x-forgeax-asset');
    if (!raw) return null;
    const value = JSON.parse(raw) as {
      guid?: unknown;
      kind?: unknown;
      name?: unknown;
      packPath?: unknown;
    };
    if (
      typeof value.guid !== 'string'
      || value.guid.length === 0
      || typeof value.kind !== 'string'
      || value.kind.length === 0
      || typeof value.name !== 'string'
    ) return null;
    return {
      type: 'asset',
      guid: value.guid,
      kind: value.kind,
      name: value.name,
      ...(typeof value.packPath === 'string' ? { path: value.packPath } : {}),
      payload: {},
    };
  } catch {
    return null;
  }
}

function carriesAssetRef(dataTransfer: DataTransfer | null): boolean {
  return dataTransfer?.types.includes('application/x-forgeax-asset') === true;
}

/**
 * Viewport drop zone — drag a Content Browser asset onto the viewport to spawn it.
 *
 * Content Browser emits `dragAssetStart`/`dragAssetEnd` on the typed bridge when
 * it is in the same realm. The DataTransfer fallback is the carrier-safe path
 * for the standalone iframe. Both routes use the same live Gateway spawn path
 * (spawnAssetRefToScene → gateway.dispatch), so both remain one op
 * (undo/ledger/AI-equal).
 *
 * Returns a disposer for cross-game teardown (registered via registerTeardown).
 */
export function installViewportDropZone(container: HTMLElement): () => void {
  let pending: DragAssetRef | null = null;
  const offStart = panelBridge.on('dragAssetStart', (ref) => { pending = ref; });
  const offEnd = panelBridge.on('dragAssetEnd', () => { pending = null; });

  const onDragOver = (e: DragEvent): void => {
    // During dragover browsers may expose the MIME type while protecting the
    // payload itself. Read the JSON only at drop time.
    if (!pending && !carriesAssetRef(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (e: DragEvent): void => {
    const ref = pending ?? assetRefFromDataTransfer(e.dataTransfer);
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
