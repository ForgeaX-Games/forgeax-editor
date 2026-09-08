import { panelBridge, type DragAssetRef } from '@forgeax/editor-core';

let activeDrag: DragAssetRef | null = null;
let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  panelBridge.on('dragAssetStart', (ref) => { activeDrag = ref; });
  panelBridge.on('dragAssetEnd', () => { activeDrag = null; });
}

/** Live Content Browser drag payload while a same-realm asset drag is in flight. */
export function getActiveAssetDrag(): DragAssetRef | null {
  install();
  return activeDrag;
}

/** Test-only reset — avoids cross-test leakage when panelBridge events are simulated. */
export function resetActiveAssetDragForTests(): void {
  activeDrag = null;
}
