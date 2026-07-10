// store/assets-changed — notify in-process panels that the asset file list changed.
//
// State: none — a synchronous typed PanelBridge signal. M3 single-realm means
// panels share this JS realm, so a window.postMessage VAG frame would be a fake
// cross-realm protocol copy. Asset-changing ops still own mutation through the
// gateway; this is notification-only after the fact.
//
// Anchors:
//   plan-strategy §2 D-2: cluster 14 (store.ts:1342-1344)
//   requirements AC-09: pure structural migration.

import { panelBridge } from '../io/panel-bridge';

export type AssetsChangedHint = 'directory-only' | 'pack-changed';

/** Notify in-process panels that the asset file list changed.
 *  `hint` allows receivers to skip work: 'directory-only' means no pack changed
 *  (only folder CRUD), so viewport refreshCatalog can be skipped. */
export function broadcastAssetsChanged(hint?: AssetsChangedHint): void {
  panelBridge.emit('assetsChanged', hint === undefined ? {} : { hint });
}
