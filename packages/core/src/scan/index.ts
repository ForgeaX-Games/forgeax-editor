// scan/index.ts — asset scan module barrel export (browser-side only).
//
// After review (2026-07-10): scan fs/stat/hash/scan-state IO moves to Node side
// (vite-plugin-pack + platform-io). Core keeps: types, pure functions, progress
// UI state, session ops, WS signal consumption.
//
// Anchors:
//   todo: 2026-07-09 startup-asset-scan-auto-import

// Types
export {
  type ScanState,
  type DirEntry,
  type ScanEntry,
  type ScanEntryStatus,
  createEmptyScanState,
} from './scan-state';

export { type ScanDiagnostic, type DiagnosticSeverity } from './scan-diagnostic';

export {
  type ScanDiff,
  type DirStat,
  type FileStat,
  fullScanDiff,
  diffDirs,
  diffFilesL1,
  diffFilesL2,
} from './scan-diff';

// Content hash (pure JS xxHash64, browser-safe; server uses SHA-256 via node:crypto)
export {
  computeContentHash,
  computeContentHashFromBytes,
  xxh64,
} from './scan-content-hash';

// Extension → importer mapping
export {
  IMPORT_FORMATS,
  getImportFormat,
  isImportable,
  getAllExtensions,
  type ImportFormat,
  type ImporterKey,
  type SubAssetKind,
} from './ext-importer-map';

// Source validation (pure functions, no fs)
export {
  validateSource,
  validateSourceQuick,
} from './validate-source';

// Scan progress (transient UI state)
export {
  type ScanProgressState,
  type ScanPhase,
  getScanProgress,
  onScanProgress,
  updateScanProgress,
  resetScanProgress,
} from './scan-progress';

// Scan broadcast (session ops — dispatched from browser)
export {
  broadcastCatalogRefreshed,
  broadcastAssetReimported,
  broadcastAssetOrphanDetected,
  broadcastAssetValidationFailed,
} from './scan-broadcast';

// HMR bridge (WS signal consumption — browser-side)
export {
  installScanHmrBridge,
  registerScanDiagnosticsConsumer,
  registerBrowserImportConsumer,
} from './scan-hmr-bridge';
