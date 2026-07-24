// scan/integrity-repair.ts — startup asset integrity auto-repair.
//
// Takes the result of scanAssetsIntegrity() and repairs "half-imported" assets
// by re-running executeAssetImport({ skipUpload: true }). Source bytes are
// already on disk; only the .meta.json sidecar + DDC cook are missing.
//
// This module is the "startup-scan bootstrap path" that import-ops.ts documents:
//   "Reused by BOTH the `importAsset` op applier AND the startup-scan
//    bootstrap path (which runs while the gateway is scan-locked and therefore
//    cannot dispatch — the init/bootstrap carve-out)."
//
// Anchors:
//   dev-plan: 2026-07-23-startup-asset-integrity-scan-auto-repair.dev-plan.md §4.5
//   import-ops.ts line 12-14: startup-scan bootstrap carve-out
//   north-star §8: repair runs under scan-lock (gateway rejects dispatch)

import { executeAssetImport, type ImportFileResult } from '../session/import-ops';
import { broadcastAssetsChanged } from '../store/assets-changed';
import type { IntegrityScanResult } from './integrity-scan';

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
}

// ── Repair executor ─────────────────────────────────────────────────────────

/**
 * Repair "needs-meta" assets by re-importing them from disk.
 *
 * Runs executeAssetImport({ skipUpload: true }) for each source file that
 * lacks a .meta.json sidecar. The source bytes are read back from disk by
 * the executor (readSourceBytes gate). Sequential execution avoids flooding
 * the dev server with concurrent cook requests.
 *
 * Returns a report of what was repaired / failed. Never throws.
 */
export async function repairAssets(scan: IntegrityScanResult): Promise<RepairReport> {
  const report: RepairReport = { repaired: [], failed: [], elapsedMs: 0 };
  const t0 = performance.now();

  if (scan.needsMeta.length === 0) {
    report.elapsedMs = performance.now() - t0;
    return report;
  }

  console.info('[integrity-repair] repairing', scan.needsMeta.length, 'files without sidecars');

  for (const item of scan.needsMeta) {
    // sourcePath from the scan is already a server-relative path (e.g.
    // "spin-cube/assets/model.fbx") because it comes from /api/files/tree.
    // Do NOT call resolveGamePath — that would double the game root prefix.
    const destPath = item.sourcePath;

    console.info('[integrity-repair] re-importing:', item.sourcePath, { destPath });

    try {
      const result = await executeAssetImport({
        destPath,
        sourceName: item.sourceName,
        skipUpload: true,
      });

      if (result.status === 'done') {
        console.info('[integrity-repair] ✓ repaired:', item.sourcePath, { guid: result.guid });
        report.repaired.push({ sourcePath: item.sourcePath, result });
      } else {
        console.warn('[integrity-repair] ✗ repair failed:', item.sourcePath, { error: result.error });
        report.failed.push({ sourcePath: item.sourcePath, result });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[integrity-repair] ✗ repair threw:', item.sourcePath, msg);
      report.failed.push({
        sourcePath: item.sourcePath,
        result: { filename: item.sourceName, status: 'error', error: msg },
      });
    }
  }

  // Notify the catalog to refresh after repairs (pluginPack's debounced watcher
  // will pick up the new .meta.json files, but an explicit broadcast ensures
  // the Content Browser UI updates promptly).
  if (report.repaired.length > 0) {
    broadcastAssetsChanged();
  }

  report.elapsedMs = performance.now() - t0;
  console.info('[integrity-repair] complete', {
    repaired: report.repaired.length,
    failed: report.failed.length,
    elapsedMs: Math.round(report.elapsedMs),
  });

  return report;
}
