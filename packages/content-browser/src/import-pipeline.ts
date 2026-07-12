/**
 * Import pipeline — thin UI orchestrator over the core `importAsset` gateway op.
 *
 * WHY THIN (Invariant 7 convergence): the actual import implementation (upload →
 * cook → sidecar → trigger) now lives ONCE in `@forgeax/editor-core`
 * (session/import-ops.ts `executeAssetImport`) behind the assetIO write-gate, and
 * is dispatched as a first-class `importAsset` session op. This file keeps only the
 * UI-side concerns: the multi-file loop and the `ImportProgress` overlay (chrome),
 * plus uploading each file's bytes through the assetIO gate before dispatch (the
 * op carries a path, not bytes — see import-ops.ts for the rationale).
 *
 * Flow per file (human drag-drop / toolbar):
 *   1. Upload binary through assetIO.uploadSourceBytes (write-gate)
 *   2. gateway.dispatch({ kind: 'importAsset', destPath, sourceName, skipUpload:true })
 *      → the applier cooks + writes the sidecar + triggers cook (all gated)
 *   3. Report progress; broadcastAssetsChanged once at the end.
 *
 * The startup scan does NOT use this file — it runs while the gateway is scan-locked
 * and calls `executeAssetImport` directly (bootstrap carve-out; see useStartupScan.ts).
 */

import { assetIO, gateway, resolveGamePath, broadcastAssetsChanged, type ImportFileResult } from '@forgeax/editor-core';
import { isImportable, logImport } from './import-registry';

// Re-export the core result type so existing consumers keep importing it from here.
export type { ImportFileResult, ImportFileStatus } from '@forgeax/editor-core';

export interface ImportProgress {
  total: number;
  completed: number;
  current: string;
  results: ImportFileResult[];
}

export type ImportProgressCallback = (progress: ImportProgress) => void;

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Import multiple files with progress reporting.
 *
 * Uploads each file's bytes through the assetIO gate, then dispatches the
 * `importAsset` op (one door). Calls `onProgress` after each dispatch and
 * `onReload` once at the end to refresh the Content Browser.
 */
export async function importFiles(
  files: File[],
  currentPath: string,
  onProgress?: ImportProgressCallback,
  onReload?: () => void,
): Promise<ImportFileResult[]> {
  logImport('pipeline.importFiles.start', {
    total: files.length,
    names: files.map(f => f.name),
    currentPath,
  });

  const importable = files.filter(f => isImportable(f.name));
  if (importable.length === 0) {
    logImport('pipeline.importFiles.skip', {
      reason: 'no importable files',
      rejected: files.map(f => f.name),
    });
    return [];
  }

  logImport('pipeline.importFiles.accepted', {
    count: importable.length,
    names: importable.map(f => f.name),
  });

  const results: ImportFileResult[] = [];
  const progress: ImportProgress = {
    total: importable.length,
    completed: 0,
    current: '',
    results,
  };

  // Host-resolved import target — the studio games-dir convention lives in the
  // edit-runtime adapter (setPathResolver), not here.
  const basePath = resolveGamePath(currentPath || 'assets');

  for (const file of importable) {
    progress.current = file.name;
    onProgress?.(structuredClone(progress));

    const destPath = `${basePath}/${file.name}`;
    let result: ImportFileResult;
    try {
      const base64 = arrayBufferToBase64(await file.arrayBuffer());
      // Upload bytes through the assetIO write-gate BEFORE dispatch — the op
      // carries a path, not bytes (ledger stays clean, op stays AI-replayable).
      const uploaded = await assetIO.uploadSourceBytes(destPath, base64);
      if (!uploaded) {
        result = { filename: file.name, status: 'error', error: 'Upload failed' };
      } else {
        // Bytes are now on disk → dispatch the one-door import op (skipUpload).
        const r = gateway.dispatch(
          { kind: 'importAsset', destPath, sourceName: file.name, skipUpload: true },
          'human',
        );
        // The applier is fire-and-forget (async session-op contract); a synchronous
        // ok means the op was accepted. Precise per-file cook errors surface through
        // the console + the post-reload catalog (sibling-op parity — see import-ops.ts).
        result = r.ok
          ? { filename: file.name, status: 'done' }
          : { filename: file.name, status: 'error', error: r.error?.code ?? 'import dispatch rejected' };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logImport('pipeline.importFiles.fileError', { filename: file.name, error: msg });
      result = { filename: file.name, status: 'error', error: msg };
    }

    results.push(result);
    progress.completed++;
    onProgress?.(structuredClone(progress));
  }

  broadcastAssetsChanged();
  onReload?.();

  return results;
}
