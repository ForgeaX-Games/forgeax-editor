// store/asset-selection — the currently-selected pack assets (Content Browser →
// Material panel cross-panel channel).
//
// Migrated to the SESSION domain (north-star §6: selection IS session-state) and
// expanded to carry a MULTI-SELECTION set (AC-B2): one op carries the whole
// selection set, so the Content Browser's high-frequency click no longer churns
// the ledger per-branch (batching — T0-6). The legacy single-{ asset } form is
// still accepted by the applier (forwarded to the multi form) so old call sites
// keep working; the catalog marks it `sugar` (AC-B2).
//
// Anchors:
//   M1 (keyboard-router convergence): setAssetSelection moved from transientAppliers
//     to sessionAppliers; payload is now { assets: SelectedAsset[]; primary }.
//   G-2: selection is a session op → ledger-visible (AI can observe "CB selected 3
//     assets"). clearAssetSelection is a lifecycle direct call (NOT dispatch, NOT
//     ledger, does NOT update lastSelectionDomain — C2-1).
//   research F-2: useSyncExternalStore getter+hook kept in one file.
import { useSyncExternalStore } from 'react';
import type { EditorOp } from '../types';
import { registerApplier } from '../io/appliers';
import { panelBridge } from '../io/panel-bridge';
// Single-active-selection-domain: selecting an asset clears any entity selection
// so Delete / blank-click resolve to one target. Direct clear (guarded on
// non-empty) goes through the shared selection-domain seam.
import {
  clearSelectionDomains,
  registerSelectionDomainClear,
} from './selection-domain-clears';

export interface SelectedAsset {
  guid: string;
  kind: string;
  name: string;
  payload: Record<string, unknown>;
  packPath: string;
}
export interface SelectedAssetIdentity extends SelectedAsset {
  readonly status: 'available' | 'missing';
}
export interface AssetIdentityRecord { readonly kind: string; readonly name?: string; readonly packPath?: string }
let identityReader: ((guid: string) => AssetIdentityRecord | undefined) | null = null;
export function registerAssetIdentityReader(reader: (guid: string) => AssetIdentityRecord | undefined): () => void {
  identityReader = reader;
  notifyIdentityConsumers();
  return () => { if (identityReader === reader) identityReader = null; };
}

let selectedAssets: SelectedAsset[] = [];
let primaryAsset: SelectedAsset | null = null;
const assetSelListeners = new Set<() => void>();
let identityRevision = 0;
let identityCache: { revision: number; value: SelectedAssetIdentity | null } | null = null;
function emitAssetSel(): void { for (const fn of assetSelListeners) fn(); }
function notifyIdentityConsumers(): void {
  identityRevision += 1;
  identityCache = null;
  emitAssetSel();
}
panelBridge.on('assetsChanged', notifyIdentityConsumers);

/** Set equality by guid (order-independent) — dedup guard so an unchanged
 *  selection does not re-emit or re-push to the ledger (T0-1). */
function sameSet(a: SelectedAsset[], b: SelectedAsset[]): boolean {
  if (a.length !== b.length) return false;
  const bg = new Set(b.map((x) => x.guid));
  return a.every((x) => bg.has(x.guid));
}

// SESSION applier (G-2 / AC-B1): the setAssetSelection body. Accepts both the new
// multi form { assets, primary } and the legacy single form { asset } (forwarded).
// Dedups identical (set, primary) so idempotent re-dispatches are no-ops.
function applySetAssetSelection(op: EditorOp): { ok: true } {
  const o = op as {
    assets?: SelectedAsset[];
    primary?: SelectedAsset | null;
    asset?: SelectedAsset | null;
  };
  const assets = o.assets ?? (o.asset ? [o.asset] : []);
  const primary = o.primary ?? o.asset ?? null;
  if (sameSet(selectedAssets, assets) && primaryAsset?.guid === primary?.guid) {
    return { ok: true };
  }
  // Only a forward (non-empty) asset selection is the active domain — clear the
  // entity selection FIRST, then emit assets LAST so lastSelectionDomain = 'asset'.
  // An empty set (deselect) must NOT clear the entity selection.
  if (assets.length > 0) clearSelectionDomains('entity');
  selectedAssets = assets;
  primaryAsset = primary;
  notifyIdentityConsumers();
  return { ok: true };
}
registerApplier('session', 'setAssetSelection', applySetAssetSelection);

// Sugar alias: legacy single-asset form. Forwards to the multi base op (AC-B2).
// Registered so old callers dispatching { kind: 'setAssetSelectionOne', asset }
// keep working; the catalog marks this `sugar: true`.
registerApplier('session', 'setAssetSelectionOne', (op) => {
  const o = op as unknown as { asset: SelectedAsset | null };
  return applySetAssetSelection({
    kind: 'setAssetSelection',
    assets: o.asset ? [o.asset] : [],
    primary: o.asset ?? null,
  });
});

/**
 * Directly clear the asset selection — lifecycle seam (G-2 / C2-1). Not an edit
 * op, not dispatched, not recorded in ledger/undo, and does NOT update
 * lastSelectionDomain (which only moves on a forward select). Content Browser
 * calls this on blur / project switch.
 */
export function clearAssetSelection(): void {
  if (selectedAssets.length !== 0 || primaryAsset !== null) {
    selectedAssets = [];
    primaryAsset = null;
    notifyIdentityConsumers();
  }
}

registerSelectionDomainClear('asset', clearAssetSelection);

/** The full selected-asset list (live reference — treat as read-only). */
export function getAssetSelectionList(): SelectedAsset[] { return selectedAssets; }
/** The primary selected asset (first / last-clicked) — backward-compat with the
 *  Material panel's single-asset contract (onAssetSelectionChange read interface). */
export function getAssetSelection(): SelectedAsset | null { return primaryAsset; }

function subscribeAssetSel(fn: () => void): () => void {
  assetSelListeners.add(fn);
  return () => assetSelListeners.delete(fn);
}

/** Non-React subscription to asset-selection changes (used by UI layers + the
 *  router's lastSelectionDomain derive). Returns unsubscribe. */
export function onAssetSelectionChange(fn: () => void): () => void {
  return subscribeAssetSel(fn);
}

/** Reactive multi-selection list (Content Browser / Material). */
export function useAssetSelectionList(): SelectedAsset[] {
  return useSyncExternalStore(subscribeAssetSel, getAssetSelectionList, getAssetSelectionList);
}
/** Reactive primary asset (legacy single-asset consumers). */
export function useAssetSelection(): SelectedAsset | null {
  return useSyncExternalStore(subscribeAssetSel, getAssetSelection, getAssetSelection);
}

export function getSelectedAssetIdentity(): SelectedAssetIdentity | null {
  if (identityCache?.revision === identityRevision) return identityCache.value;
  if (!primaryAsset) {
    identityCache = { revision: identityRevision, value: null };
    return null;
  }
  const entry = identityReader?.(primaryAsset.guid);
  const value: SelectedAssetIdentity = {
    ...primaryAsset,
    kind: entry?.kind ?? primaryAsset.kind,
    name: entry?.name ?? primaryAsset.name,
    packPath: entry?.packPath ?? primaryAsset.packPath,
    status: entry ? 'available' : 'missing',
  };
  identityCache = { revision: identityRevision, value };
  return value;
}

export function useSelectedAssetIdentity(): SelectedAssetIdentity | null {
  return useSyncExternalStore(subscribeAssetSel, getSelectedAssetIdentity, getSelectedAssetIdentity);
}
