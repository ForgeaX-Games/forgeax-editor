// scan/integrity-scan.ts — startup asset integrity scanner.
//
// Detects "half-imported" assets: source files on disk without a corresponding
// .meta.json sidecar. This happens when a previous import failed mid-pipeline
// (e.g. cook error, network drop, fbx-wasm unavailable) — the source bytes
// were uploaded but the sidecar was never written.
//
// The scanner uses the assetIO.listSourceFiles() gate (GET /api/files/tree) to
// enumerate the assets/ directory, then cross-references source files against
// their expected .meta.json sidecars. Files flagged as `needsMeta` are passed
// to integrity-repair.ts for automatic re-import via executeAssetImport.
//
// Anchors:
//   dev-plan: 2026-07-23-startup-asset-integrity-scan-auto-repair.dev-plan.md §4.4
//   north-star §6/§8: scan is a pre-condition phase (lockForScan)
//   import-ops.ts: executeAssetImport({ skipUpload: true }) — startup-scan bootstrap

import { assetIO } from '../io/asset-io-facade';
import { isImportable } from './ext-importer-map';
import { resolveGamePath } from '../util/path-resolver';
import type { ScanDiagnostic } from './scan-diagnostic';

// ── Result types ────────────────────────────────────────────────────────────

export interface NeedsMetaEntry {
  /** Game-relative source file path (e.g. "assets/model.fbx"). */
  sourcePath: string;
  /** File basename (e.g. "model.fbx") — drives importer selection. */
  sourceName: string;
}

export interface OrphanedSidecarEntry {
  /** Game-relative .meta.json path. */
  metaPath: string;
  /** Expected source file path (meta path without .meta.json suffix). */
  expectedSourcePath: string;
}

export interface IntegrityScanResult {
  /** Source files on disk with no .meta.json sidecar — need import. */
  needsMeta: NeedsMetaEntry[];
  /** .meta.json files whose declared source doesn't exist — orphaned.
   *  (Note: engine-side cleanOrphanMetas may have already removed some.) */
  orphanedSidecar: OrphanedSidecarEntry[];
  /** Source files with a valid .meta.json — no action needed. */
  ok: string[];
  /** Non-importable files (no registered importer) — skipped. */
  skipped: string[];
  /** Diagnostic messages accumulated during the scan. */
  diagnostics: ScanDiagnostic[];
}

// ── Scanner ─────────────────────────────────────────────────────────────────

/**
 * Scan the game's assets/ directory for integrity issues.
 *
 * Returns a categorized result: files needing meta generation, orphaned
 * sidecars, healthy files, and skipped non-importable files.
 *
 * Pure read operation — never modifies disk. Repair is handled separately
 * by integrity-repair.ts.
 */
export async function scanAssetsIntegrity(): Promise<IntegrityScanResult> {
  const result: IntegrityScanResult = {
    needsMeta: [],
    orphanedSidecar: [],
    ok: [],
    skipped: [],
    diagnostics: [],
  };

  let assetsRoot: string;
  try {
    assetsRoot = resolveGamePath('assets');
  } catch {
    console.warn('[integrity-scan] cannot resolve game assets path — skipping scan');
    return result;
  }

  console.info('[integrity-scan] scanning', { assetsRoot });
  const allFiles = await assetIO.listSourceFiles(assetsRoot);
  if (allFiles.length === 0) {
    console.info('[integrity-scan] no files found in assets/ — nothing to scan');
    return result;
  }

  // Partition files into source files, meta sidecars, and pack files.
  const sourceFiles: string[] = [];
  const metaFiles = new Set<string>();
  const packFiles = new Set<string>();

  for (const filePath of allFiles) {
    if (filePath.endsWith('.meta.json')) {
      metaFiles.add(filePath);
    } else if (filePath.endsWith('.pack.json')) {
      packFiles.add(filePath);
    } else {
      sourceFiles.push(filePath);
    }
  }

  console.info('[integrity-scan] file counts', {
    total: allFiles.length,
    source: sourceFiles.length,
    meta: metaFiles.size,
    pack: packFiles.size,
  });

  // Cross-reference: for each importable source file, check if its .meta.json exists.
  for (const sourcePath of sourceFiles) {
    const basename = sourcePath.slice(sourcePath.lastIndexOf('/') + 1);
    const ext = basename.slice(basename.lastIndexOf('.')).toLowerCase();

    if (!isImportable(basename)) {
      result.skipped.push(sourcePath);
      continue;
    }

    const expectedMeta = `${sourcePath}.meta.json`;
    if (metaFiles.has(expectedMeta)) {
      result.ok.push(sourcePath);
    } else {
      console.warn('[integrity-scan] source without sidecar:', { sourcePath, expectedMeta });
      result.needsMeta.push({ sourcePath, sourceName: basename });
      result.diagnostics.push({
        file: sourcePath,
        severity: 'warn',
        code: 'missing-meta',
        message: `Source file "${basename}" has no .meta.json sidecar — import was incomplete`,
        suggestion: 'Will be auto-repaired by re-importing from disk.',
      });
    }
  }

  // Reverse check: meta files whose source doesn't exist.
  // Note: engine-side cleanOrphanMetas (runtime-vite-preset.ts) already runs before
  // pluginPack, so most of these should be cleaned up. We detect any remaining ones.
  for (const metaPath of metaFiles) {
    const expectedSource = metaPath.replace(/\.meta\.json$/, '');
    // Only flag if the source is an importable extension AND not in our source set.
    const basename = expectedSource.slice(expectedSource.lastIndexOf('/') + 1);
    if (isImportable(basename) && !sourceFiles.includes(expectedSource)) {
      result.orphanedSidecar.push({ metaPath, expectedSourcePath: expectedSource });
      result.diagnostics.push({
        file: metaPath,
        severity: 'warn',
        code: 'orphaned-sidecar',
        message: `Sidecar "${metaPath}" has no corresponding source file`,
        suggestion: 'Source was likely deleted. Sidecar can be cleaned up.',
      });
    }
  }

  console.info('[integrity-scan] scan complete', {
    needsMeta: result.needsMeta.length,
    orphanedSidecar: result.orphanedSidecar.length,
    ok: result.ok.length,
    skipped: result.skipped.length,
  });

  return result;
}
