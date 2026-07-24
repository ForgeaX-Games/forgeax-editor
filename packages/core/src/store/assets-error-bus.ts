// store/assets-error-bus.ts — panel notification for async asset-IO failures.
//
// Companion to store/assets-changed.ts: `assetsChanged` fires when disk state
// changed successfully; `assetsError` fires when a fire-and-forget IO from an
// applier failed AFTER the applier already returned `ok:true`. That failure
// used to be a silent console.warn — panels had no hook to surface it, so a
// broken pack write / dropped fetch would leave the UI showing an outdated
// (or inconsistent) state with no user feedback.
//
// The applier is still the SSOT for STATE mutation (north-star §9); this bus
// is notification-only, so subscribers cannot mutate through it. Panels toast
// or badge; a global error boundary can log. The synchronous INVALID_ARGS
// path (validateAssetBasename fails, applier returns `{ok:false}`) does NOT
// flow through here — that returns on `dispatch()` and the callsite handles
// it directly.
//
// Anchors:
//   feedbacks/2026-07-23-assets-create-folder-name-validation-illegal-chars.dev-plan.md §5 step 3
//   io/panel-bridge.ts PanelBridgeEvents.assetsError

import { panelBridge } from '../io/panel-bridge';

export interface AssetsErrorPayload {
  /** EditorOp.kind that failed (e.g. 'createDirectory', 'renameSourceFile'). */
  op: string;
  /** Optional game-relative path the op was targeting (for context in toasts). */
  path?: string;
  /** Human-readable message safe to display verbatim in a toast. */
  hint: string;
  /** Wall-clock ms since epoch for chronological ordering. */
  ts: number;
}

/** Broadcast a background asset-IO failure to panels (toast subscribers). */
export function broadcastAssetsError(payload: Omit<AssetsErrorPayload, 'ts'>): void {
  panelBridge.emit('assetsError', { ...payload, ts: Date.now() });
}
