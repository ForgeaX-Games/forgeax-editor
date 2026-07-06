// store/asset-selection — the currently-selected pack asset (Content Browser →
// Material panel cross-panel channel).
//
// State: `selectedAsset` + its listener set. Consumers: clicking an asset card
// in the Content Browser publishes it (setAssetSelection); other panels
// (Material, future Preview) react via useAssetSelection / onAssetSelectionChange.
//
// Anchors:
//   plan-strategy §2 D-2: cluster 12 (store.ts:1276-1306)
//   research F-2: useSyncExternalStore getter+hook kept in one file
//   requirements AC-09: pure structural migration.
import { useSyncExternalStore } from 'react';

// ── Asset selection (cross-panel: Content Browser → Material panel) ──────────
// Lightweight pub/sub for the currently-selected pack asset. When a user clicks
// an asset card in the Content Browser, other panels (Material, future Preview)
// can react by displaying its properties.

export interface SelectedAsset {
  guid: string;
  kind: string;
  name: string;
  payload: Record<string, unknown>;
  packPath: string;
}

let selectedAsset: SelectedAsset | null = null;
const assetSelListeners = new Set<() => void>();
function emitAssetSel(): void { for (const fn of assetSelListeners) fn(); }

export function setAssetSelection(asset: SelectedAsset | null): void {
  if (selectedAsset?.guid === asset?.guid) return;
  selectedAsset = asset;
  emitAssetSel();

}
export function getAssetSelection(): SelectedAsset | null { return selectedAsset; }
function subscribeAssetSel(fn: () => void): () => void {
  assetSelListeners.add(fn);
  return () => assetSelListeners.delete(fn);
}
export function useAssetSelection(): SelectedAsset | null {
  return useSyncExternalStore(subscribeAssetSel, getAssetSelection, getAssetSelection);
}
/** Non-React subscription to asset-selection changes (used by the MAIN window in
 *  main.tsx to load the selected mesh and publish its stats). Returns unsubscribe. */
export function onAssetSelectionChange(fn: () => void): () => void {
  return subscribeAssetSel(fn);
}
