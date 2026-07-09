// store/assets-changed — notify in-process panels that the asset file list changed.
//
// State: none — a stateless window.postMessage broadcast. M3 single-realm:
// panels are in-process React components, so this is a same-window signal.
//
// Anchors:
//   plan-strategy §2 D-2: cluster 14 (store.ts:1342-1344)
//   requirements AC-09: pure structural migration.

export type AssetsChangedHint = 'directory-only' | 'pack-changed';

/** Notify in-process panels that the asset file list changed.
 *  M3: single-realm — panels are in-process React components.
 *  `hint` allows receivers to skip work: 'directory-only' means no pack changed
 *  (only folder CRUD), so viewport refreshCatalog can be skipped. */
export function broadcastAssetsChanged(hint?: AssetsChangedHint): void {
  try { window.postMessage({ type: 'VAG_ASSETS_CHANGED', hint }, '*'); } catch { /* */ }
}
