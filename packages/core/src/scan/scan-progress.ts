// scan/scan-progress.ts — scan progress observable (G4: transient/chrome).
//
// Progress is transient UI state (§8 chrome): it does NOT go through gateway.dispatch
// and does NOT produce ledger entries. Consumers subscribe directly via listener.
//
// Anchors:
//   todo: 2026-07-09 startup-asset-scan-auto-import G4

import type { ScanDiagnostic } from './scan-diagnostic';

export type ScanPhase = 'idle' | 'scanning' | 'generating-meta' | 'importing' | 'done';

export interface ScanProgressState {
  phase: ScanPhase;
  /** Number of files processed so far (scanned + meta-generated + imported). */
  current: number;
  /** Total number of files to process. */
  total: number;
  /** Relative path of the file currently being processed. */
  currentFile: string;
  /** Accumulated diagnostics (errors + warnings). */
  errors: ScanDiagnostic[];
}

type ProgressListener = (state: ScanProgressState) => void;
const listeners = new Set<ProgressListener>();

let _state: ScanProgressState = {
  phase: 'idle',
  current: 0,
  total: 0,
  currentFile: '',
  errors: [],
};

/** Read current progress snapshot. */
export function getScanProgress(): ScanProgressState {
  return { ..._state };
}

/** Subscribe to progress changes. Returns unsubscribe function. */
export function onScanProgress(fn: ProgressListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Update progress and notify subscribers. */
export function updateScanProgress(patch: Partial<ScanProgressState>): void {
  _state = { ..._state, ...patch };
  for (const fn of listeners) fn(getScanProgress());
}

/** Reset progress back to idle. */
export function resetScanProgress(): void {
  _state = {
    phase: 'idle',
    current: 0,
    total: 0,
    currentFile: '',
    errors: [],
  };
  for (const fn of listeners) fn(getScanProgress());
}
