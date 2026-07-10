// scan/scan-broadcast.ts — dispatch scan results as session-domain ops (G4, revised).
//
// After review (2026-07-10): scan runs in Node side, not browser. These functions
// dispatch directly through gateway (browser-side) — called from registered
// session appliers (scan-ops.ts), which are triggered by WS signals from the
// dev server via scan-hmr-bridge.ts.
//
// Anchors:
//   todo: 2026-07-09 startup-asset-scan-auto-import G4
//   north-star §6/§8: session domain ops, AI parity

import { gateway } from '../store/store';
import type { ScanDiagnostic } from './scan-diagnostic';

function dispatch(op: { kind: string; [k: string]: unknown }): void {
  gateway.dispatch(op as never, 'scan' as never);
}

/** Broadcast catalog refresh results. */
export function broadcastCatalogRefreshed(
  added: string[],
  removed: string[],
  reimported: string[],
): void {
  dispatch({ kind: 'assetCatalogRefreshed', added, removed, reimported });
}

/** Broadcast a single file reimport event. */
export function broadcastAssetReimported(
  path: string,
  guid: string,
  reason: 'content-changed' | 'importer-upgraded' | 'ddc-missing',
): void {
  dispatch({ kind: 'assetReimported', path, guid, reason });
}

/** Broadcast an orphan detection event. */
export function broadcastAssetOrphanDetected(
  sourcePath: string,
  metaPath: string,
): void {
  dispatch({ kind: 'assetOrphanDetected', sourcePath, metaPath });
}

/** Broadcast validation errors. */
export function broadcastAssetValidationFailed(diagnostics: ScanDiagnostic[]): void {
  dispatch({ kind: 'assetValidationFailed', diagnostics });
}
