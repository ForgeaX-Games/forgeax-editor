// store/asset-selection — the currently-selected pack asset (Content Browser →
// Material panel cross-panel channel).
//
// State: `selectedAsset` + its listener set. Consumers: clicking an asset card
// in the Content Browser publishes it (setAssetSelection); other panels
// (Material, future Preview) react via useAssetSelection / onAssetSelectionChange.
//
// Anchors:
//   plan-strategy §2 D-2: cluster 12 (store.ts:1276-1306)
//   plan-strategy §2 D-1: setAssetSelection is a TRANSIENT-domain op — the body
//     is the applier, registered into transientAppliers; the setter dispatches
//     (M2 m2-w9). asset-selection belongs to transient (requirements §2 NOTE, q2
//     human answer). No undo, no ledger.
//   research F-2: useSyncExternalStore getter+hook kept in one file
//   requirements AC-03: transient goes through gateway, leaves no trace.
import { useSyncExternalStore } from 'react';
import type { EditorOp } from '../types';
import { transientAppliers } from '../io/appliers';

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

// Transient applier (M2 D-1): setAssetSelection body, registered into the
// transient table. The op payload carries the asset (or null).
function applySetAssetSelection(op: EditorOp): { ok: true } {
  const asset = (op as { asset: SelectedAsset | null }).asset;
  if (selectedAsset?.guid !== asset?.guid) {
    selectedAsset = asset;
    emitAssetSel();
  }
  return { ok: true };
}
transientAppliers.set('setAssetSelection', applySetAssetSelection);

// M3 t22 (S10 / AC-21/22): setAssetSelection write-side sugar deleted — callers
// dispatch gateway.dispatch({ kind: 'setAssetSelection', asset }) directly.
// Read-side (getAssetSelection / useAssetSelection / onAssetSelectionChange) stays.
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
