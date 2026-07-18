// scan/scan-state.ts — scan-state.json schema (G1: incremental detection core).
//
// Design:
//   - scan-state.json lives at <game-dir>/.forgeax/scan-state.json
//   - It is a local cache (not committed to git) that tracks mtime/size/contentHash
//     for every source file under assets/ so incremental scans can skip unchanged files.
//   - Three-tier detection: L0 (dir mtime) → L1 (file mtime+size) → L2 (content hash).
//
// Anchors:
//   todo: 2026-07-09 startup-asset-scan-auto-import G1

/** Status of a scan entry. */
export type ScanEntryStatus =
  | 'imported'       // meta.json exists, import completed successfully
  | 'pending'        // meta.json exists but DDC may be stale
  | 'needs-reimport' // source changed, needs reimport
  | 'needs-meta'     // source exists but no meta.json generated yet
  | 'error'          // previous import/validation failed
  ;

/** Per-directory L0 cache entry. */
export interface DirEntry {
  /** `stat(dir).mtimeMs` at last scan. Used for L0 subtree skip. */
  mtime: number;
}

/** Per-file L1+L2 cache entry. */
export interface ScanEntry {
  /** `stat(file).mtimeMs` at last scan (L1 fast check). */
  mtime: number;
  /** `stat(file).size` at last scan (L1 fast check — size change guarantees content change). */
  size: number;
  /** Full-file content hash (L2 false-positive guard). Server-side uses SHA-256
   *  via node:crypto; browser-side uses xxHash64 via pure JS. Format: "sha256:<hex>" or "xxh64:<hex>".
   *  null when not yet computed. */
  contentHash: string | null;
  /** Importer key that handles this file extension. */
  importerKey: string;
  /** The importer's formatVersion at import time (used for schema-upgrade detection). */
  importerVersion: number | null;
  /** Relative path to the .meta.json sidecar file. null when meta not yet generated. */
  metaPath: string | null;
  /** Current status. */
  status: ScanEntryStatus;
  /** Error code when status === 'error'. */
  errorCode?: string;
}

/** Top-level scan-state.json shape. */
export interface ScanState {
  /** Schema version for forward-compatible evolution. */
  schemaVersion: string;
  /** ISO-8601 timestamp of the last full scan completion. */
  lastFullScanTimestamp: string | null;
  /** Per-directory L0 mtime cache. Keys are relative paths like "assets/models". */
  dirs: Record<string, DirEntry>;
  /** Per-file L1+L2 cache. Keys are relative paths like "assets/models/bed.glb". */
  entries: Record<string, ScanEntry>;
  /** Snapshot of each importer's formatVersion at last scan (for upgrade detection). */
  importerVersions: Record<string, number>;
}

/** Create an empty scan state (used on first-ever scan). */
export function createEmptyScanState(): ScanState {
  return {
    schemaVersion: '1.0.0',
    lastFullScanTimestamp: null,
    dirs: {},
    entries: {},
    importerVersions: {},
  };
}
