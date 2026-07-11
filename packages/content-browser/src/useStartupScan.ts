// useStartupScan.ts — startup scan hook (G4, revised for cross-process WS signals).
//
// After review (2026-07-10 承重B): scan runs in Node-side (vite-plugin-pack dev server),
// not in the browser. The browser locks/unlocks the gateway based on WS signals
// from the dev server: `forgeax:scan-started` → lock, `forgeax:scan-done` → unlock.
//
// Progress data arrives via `forgeax:scan-progress` WS events and updates the
// transient scan-progress store, which drives the ScanOverlay UI.
//
// Plan v2 H5: Complex-format files (glb/gltf/fbx) are delivered inside
// scan-done.needBrowserImport. After unlock, we fetch each file from disk,
// create browser File objects, and route through the existing import pipeline
// so the WASM parser (gltf-cook / ufbx) can generate the meta.json.
//
// Anchors:
//   todo: 2026-07-09 startup-asset-scan-auto-import G4 (revised)

import { useEffect, useState } from 'react';
import {
  gateway, getScanProgress, onScanProgress, updateScanProgress,
  resetScanProgress,
  installScanHmrBridge, registerBrowserImportConsumer,
  broadcastAssetsChanged, resolveGamePath,
  executeAssetImport,
} from '@forgeax/editor-core';

export interface UseStartupScanResult {
  /** Whether the scan is currently running (gateway locked). */
  scanning: boolean;
  /** Whether the scan has completed. */
  done: boolean;
}

/**
 * Import complex-format files (glb/gltf/fbx) from disk at startup.
 *
 * BOOTSTRAP CARVE-OUT (Invariant 7): this runs while the gateway is scan-locked
 * (dispatch rejects every op), so it CANNOT route through gateway.dispatch. It
 * calls the shared core executor `executeAssetImport` DIRECTLY — the same
 * implementation the `importAsset` op wraps — with skipUpload:true (the source is
 * already on disk). The executor reads the source bytes itself through the assetIO
 * gate, so no browser File round-trip is needed. Awaiting each result preserves the
 * FBX-WASM-unavailable detection + failure counting.
 */
async function importComplexFilesFromDisk(paths: string[], _basePath: string): Promise<void> {
  console.info(`[useStartupScan] importComplexFilesFromDisk begin paths=${paths.length}`);

  // Pre-flight filter: FBX needs WASM. If the first FBX import fails with a
  // WASM-unavailable error, all remaining FBX files are skipped to avoid N
  // repeated errors in the viewport overlay.
  const fbxPaths = paths.filter(p => /\.fbx$/i.test(p));

  // Lock progress to 'importing' immediately so ScanOverlay stays visible
  // throughout the async import loop (no idle gap before first onProgress).
  updateScanProgress({
    phase: 'importing',
    current: 0,
    total: paths.length,
    currentFile: 'Preparing browser import...',
  });

  try {
    let imported = 0;
    let cookFailed = 0;
    let fbxWasmUnavailable = false;
    const errors: Array<{ file: string; error: string }> = [];

    for (const relPath of paths) {
      // If WASM was detected as unavailable, skip remaining FBX files.
      if (fbxWasmUnavailable && /\.fbx$/i.test(relPath)) continue;

      const sourceName = relPath.slice(relPath.lastIndexOf('/') + 1);
      updateScanProgress({
        phase: 'importing',
        current: imported,
        total: paths.length,
        currentFile: sourceName,
      });

      // Direct executor call (bootstrap; gateway scan-locked). The executor reads
      // the on-disk bytes via the assetIO gate — destPath must be the RESOLVED
      // disk path (the executor does not resolve game-relative paths itself).
      const r = await executeAssetImport({
        destPath: resolveGamePath(relPath),
        sourceName,
        skipUpload: true,
      });

      if (r.status === 'done') {
        imported++;
      } else {
        cookFailed++;
        errors.push({ file: r.filename, error: r.error ?? 'unknown cook error' });

        // Detect WASM-unavailable pattern on first FBX failure — skip remaining.
        if (!fbxWasmUnavailable && r.error?.includes('Failed to fetch dynamically imported module')) {
          fbxWasmUnavailable = true;
          const remainingFbx = fbxPaths.length - 1;
          console.warn(
            `[useStartupScan] ⚠ FBX WASM unavailable — skipping remaining ${remainingFbx} FBX file(s). ` +
            `Fix: run \`pnpm -F @forgeax/engine-fbx fetch-wasm\` or \`build:wasm\``,
          );
        }
      }
    }

    broadcastAssetsChanged();

    // Report summary
    if (errors.length > 0) {
      console.warn(
        `[useStartupScan] ⚠ import completed with errors: ` +
        `success=${imported} cookFail=${cookFailed} total=${paths.length}`,
      );
      for (const e of errors.slice(0, 10)) {
        console.warn(`[useStartupScan]   ✗ ${e.file}: ${e.error}`);
      }
      if (errors.length > 10) {
        console.warn(`[useStartupScan]   ... and ${errors.length - 10} more errors`);
      }
    } else {
      console.info(
        `[useStartupScan] ✓ importComplexFilesFromDisk done success=${imported}/${paths.length}`,
      );
    }
  } finally {
    // Always reset progress so ScanOverlay hides — even if import threw.
    resetScanProgress();
  }
}

/** Listen for dev-server scan signals and manage gateway lock state. */
export function useStartupScan(): UseStartupScanResult {
  const [scanning, setScanning] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    console.info('[useStartupScan] mount — installing HMR bridge + browser-import consumer');
    if (gateway.scanLocked) {
      console.info('[useStartupScan] gateway already scanLocked on mount');
      setScanning(true);
    }

    // Register consumer BEFORE installScanHmrBridge so HTTP race-replay can
    // trigger browser import immediately after unlock.
    registerBrowserImportConsumer(importComplexFilesFromDisk);
    const dispose = installScanHmrBridge();

    const unsub = onScanProgress((state) => {
      if (state.phase === 'scanning' || state.phase === 'generating-meta' || state.phase === 'importing') {
        setScanning(true);
      } else if (state.phase === 'done' || state.phase === 'idle') {
        setScanning(false);
        setDone(true);
      }
    });

    const current = getScanProgress();
    if (current.phase !== 'idle' && current.phase !== 'done') {
      setScanning(true);
    } else if (current.phase === 'done') {
      setDone(true);
    }

    return () => {
      dispose();
      unsub();
    };
  }, []);

  return { scanning, done };
}
