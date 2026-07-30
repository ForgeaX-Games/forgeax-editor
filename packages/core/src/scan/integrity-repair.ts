// scan/integrity-repair.ts — startup asset integrity recovery projection.
//
// Takes the result of scanAssetsIntegrity() and emits recovery intents for
// "half-imported" assets. Observation does not write a sidecar or cook data.
//
// Destructive recovery is deferred to a later preflight and dispatch path;
// this module remains UI-free and mutation-free.
//
// Anchors:
//   dev-plan: 2026-07-23-startup-asset-integrity-scan-auto-repair.dev-plan.md §4.5
//   import-ops.ts line 12-14: startup-scan bootstrap carve-out
//   north-star §8: repair runs under scan-lock (gateway rejects dispatch)

import type { IntegrityScanResult } from './integrity-scan';
import type { AssetWorkspaceRecoveryIntent } from '@forgeax/editor-product';
import type { ImportFileResult } from '../session/import-ops';

// ── Result types ────────────────────────────────────────────────────────────

export interface RepairEntry {
  sourcePath: string;
  result: ImportFileResult;
}

export interface RepairReport {
  /** Successfully repaired files (sidecar created). */
  repaired: RepairEntry[];
  /** Files where repair failed (cook error, read failure, etc.). */
  failed: RepairEntry[];
  /** Total wall-clock time for the repair phase (ms). */
  elapsedMs: number;
  /** Observe-only recovery intents; execution belongs to a later preflight task. */
  recoveryIntents: AssetWorkspaceRecoveryIntent[];
}

// ── Recovery intent projection ─────────────────────────────────────────────

/**
 * Convert missing source/meta facts into recovery intents without mutating disk.
 */
export async function repairAssets(scan: IntegrityScanResult): Promise<RepairReport> {
  const report: RepairReport = { repaired: [], failed: [], elapsedMs: 0, recoveryIntents: [] };
  const t0 = performance.now();

  if (scan.needsMeta.length === 0) {
    report.recoveryIntents.push(...scan.orphanedSidecar.map((entry) => ({
      kind: 'await-source' as const,
      scope: entry.metaPath,
    })));
    report.elapsedMs = performance.now() - t0;
    return report;
  }
  report.recoveryIntents.push(...scan.needsMeta.map((item) => ({
    kind: 'await-meta' as const,
    scope: item.sourcePath,
  })));
  report.recoveryIntents.push(...scan.orphanedSidecar.map((entry) => ({
    kind: 'await-source' as const,
    scope: entry.metaPath,
  })));

  report.elapsedMs = performance.now() - t0;
  console.info('[integrity-repair] complete', {
    repaired: report.repaired.length,
    failed: report.failed.length,
    elapsedMs: Math.round(report.elapsedMs),
  });

  return report;
}
