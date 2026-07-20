// scan/scan-diagnostic.ts — scan validation diagnostic types (G5).
//
// Diagnostics are accumulated during scan/import and reported via a session-domain
// `assetValidationFailed` op that both human and AI consumers can read from the ledger.
//
// Anchors:
//   todo: 2026-07-09 startup-asset-scan-auto-import G5

export type DiagnosticSeverity = 'warn' | 'error';

export interface ScanDiagnostic {
  /** Relative source file path (e.g. "assets/models/broken.glb"). */
  file: string;
  /** Severity level. */
  severity: DiagnosticSeverity;
  /** Machine-readable error code (e.g. "empty-file", "invalid-glb-header"). */
  code: string;
  /** Human-readable message. */
  message: string;
  /** Optional suggestion for how to fix. */
  suggestion?: string;
}
