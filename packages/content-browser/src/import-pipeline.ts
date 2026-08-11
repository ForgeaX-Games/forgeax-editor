/**
 * Import pipeline — thin UI orchestrator over the core `importAsset` gateway op.
 *
 * WHY THIN (Invariant 7 convergence): the actual import implementation (upload →
 * cook → sidecar → trigger) now lives ONCE in `@forgeax/editor-core`
 * (session/import-ops.ts `executeAssetImport`) behind the assetIO write-gate, and
 * is dispatched as a first-class `importAsset` session op. This file keeps only the
 * UI-side concerns: the multi-file loop and the `ImportProgress` overlay (chrome),
 * plus reading each selected file. Runtime owns source upload and import.
 *
 * Flow per file (human drag-drop / toolbar):
 *   1. Read the selected source bytes in the Shell.
 *   2. Dispatch one importAsset request to Runtime.
 *   3. Runtime uploads, cooks, writes the sidecar, and publishes one terminal run.
 *
 * The startup scan does NOT use this file — it runs while the gateway is scan-locked
 * and calls `executeAssetImport` directly through the shared import executor.
 */

import {
  createImportFailure,
  dispatchActiveEditorOperation,
  resolveGamePath,
  retryViewportRuntimeOperationRun,
  waitViewportRuntimeOperationRun,
  type ImportFailureCode,
  type ImportFileResult,
  type OperationRun,
  isImportable,
  logImport,
} from '@forgeax/editor-core';

// Re-export the core result type so existing consumers keep importing it from here.
export type { ImportFileResult, ImportFileStatus } from '@forgeax/editor-core';

export interface ImportProgress {
  total: number;
  completed: number;
  current: string;
  results: ImportFileResult[];
  currentRequestId?: string;
  currentRun?: OperationRun;
  runs: ImportRunRecord[];
  actionError?: string;
}

export interface ImportRunRecord {
  filename: string;
  path: string;
  requestId: string;
  run: OperationRun;
}

/** Retry policy projection: malformed producer input cannot become valid by rerunning it. */
export function isRetryableImportRun(run: OperationRun): boolean {
  return run.status === 'failed'
    && run.retryable
    && run.error?.code !== 'IMPORT_COOK_FAILED';
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

function failureResult(
  filename: string,
  path: string,
  code: ImportFailureCode,
  hint: string,
  retryable = true,
): ImportFileResult {
  const errorDetail = createImportFailure(path, code, hint, { retryable });
  return { filename, status: 'error', error: hint, errorDetail };
}

export function importRunToResult(filename: string, path: string, run: OperationRun): ImportFileResult {
  if (run.status === 'succeeded') {
    const result = run.result as ImportFileResult | undefined;
    return result === undefined
      ? failureResult(filename, path, 'IMPORT_EXECUTION_FAILED', 'Import completed without a terminal result', false)
      : { ...result, filename };
  }
  const terminalError = run.error;
  return failureResult(
    filename,
    terminalError?.subjectRef?.id ?? path,
    typeof terminalError?.code === 'string' && terminalError.code.startsWith('IMPORT_')
      ? terminalError.code as ImportFailureCode
      : 'IMPORT_EXECUTION_FAILED',
    terminalError?.hint ?? terminalError?.code ?? `Import ${run.status}.`,
    terminalError?.retryable ?? false,
  );
}

export type ImportRetryResult =
  | { ok: true; requestId: string; terminal: OperationRun; result: ImportFileResult }
  | { ok: false; error: { code: string; hint: string } };

export async function retryImportRun(
  record: ImportRunRecord,
  onRun?: (requestId: string, run: OperationRun) => void,
): Promise<ImportRetryResult> {
  const requestId = crypto.randomUUID();
  const dispatched = await retryViewportRuntimeOperationRun(record.requestId, requestId);
  if (dispatched.error !== undefined) return { ok: false, error: { code: dispatched.error.code, hint: dispatched.error.hint } };
  const accepted = dispatched.result as OperationRun | undefined;
  if (accepted === undefined) {
    return { ok: false, error: { code: 'IMPORT_EXECUTION_FAILED', hint: 'Retry was accepted without an OperationRun.' } };
  }
  onRun?.(requestId, accepted);
  const response = await waitViewportRuntimeOperationRun(requestId);
  if (response.error !== undefined) return { ok: false, error: { code: response.error.code, hint: response.error.hint } };
  const terminal = response.result as OperationRun;
  onRun?.(requestId, terminal);
  return {
    ok: true,
    requestId,
    terminal,
    result: importRunToResult(record.filename, record.path, terminal),
  };
}

/**
 * Import multiple files with progress reporting.
 *
 * Sends each file's bytes to Runtime through the `importAsset` op (one door).
 * Calls `onProgress` after each dispatch and
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
    runs: [],
  };

  const publishProgress = (): void => {
    onProgress?.(structuredClone(progress));
  };

  // Host-resolved import target — the studio games-dir convention lives in the
  // edit-runtime adapter (setPathResolver), not here.
  // FIX: keep the game-relative path (without slug) for dispatch — the applier
  // calls resolveGamePath() internally, so passing the already-resolved basePath
  // would double-prefix (e.g. hellforge/hellforge/...).
  const gameRelBase = currentPath || 'assets';
  const basePath = resolveGamePath(gameRelBase);
  logImport('pipeline.importFiles.resolvedBase', { basePath, gameRelBase });

  for (const file of importable) {
    progress.current = file.name;
    progress.currentRequestId = undefined;
    progress.currentRun = undefined;
    progress.actionError = undefined;
    publishProgress();

    const uploadPath = `${basePath}/${file.name}`;
    const gameRelPath = `${gameRelBase}/${file.name}`;
    let result: ImportFileResult;
    try {
      logImport('pipeline.file.readBytes', { filename: file.name, size: file.size, uploadPath, gameRelPath });
      const base64 = arrayBufferToBase64(await file.arrayBuffer());
      const uiCompanion = file.name.toLowerCase().endsWith('.ui.html')
        ? files.find(candidate => candidate.name.toLowerCase() === file.name.toLowerCase().replace(/\.ui\.html$/, '.ui.css'))
        : undefined;
      const companionSources = uiCompanion === undefined
        ? undefined
        : [{
          destPath: `${gameRelBase}/${uiCompanion.name}`,
          base64: arrayBufferToBase64(await uiCompanion.arrayBuffer()),
        }];
      {
        // Pass game-relative paths. Runtime owns resolveGamePath and every write.
        logImport('pipeline.file.dispatching', { filename: file.name, gameRelPath });
        const requestId = crypto.randomUUID();
        const r = await dispatchActiveEditorOperation(
          {
            kind: 'importAsset',
            destPath: gameRelPath,
            sourceName: file.name,
            base64,
            ...(companionSources === undefined ? {} : { companionSources }),
            skipUpload: false,
            requestId,
          },
          'human',
        );
        logImport('pipeline.file.dispatchResult', { filename: file.name, ok: r.ok, error: (r as { error?: { code?: string } }).error?.code });
        if (!r.ok) {
          result = { filename: file.name, status: 'error', error: r.error?.code ?? 'import dispatch rejected' };
        } else {
          const acceptedRun = r.result?.operationRun;
          if (acceptedRun === undefined) {
            result = failureResult(file.name, uploadPath, 'IMPORT_EXECUTION_FAILED', 'Import was accepted without an OperationRun', false);
          } else {
            progress.currentRequestId = requestId;
            progress.currentRun = acceptedRun;
            progress.runs.push({ filename: file.name, path: uploadPath, requestId, run: acceptedRun });
            publishProgress();
            const terminalResponse = await waitViewportRuntimeOperationRun(requestId);
            if (terminalResponse.error === undefined) {
              const terminal = terminalResponse.result as OperationRun;
              const record = progress.runs.find(entry => entry.requestId === requestId);
              if (record) record.run = terminal;
              progress.currentRun = terminal;
              result = importRunToResult(file.name, uploadPath, terminal);
            } else {
              result = failureResult(file.name, uploadPath, 'IMPORT_EXECUTION_FAILED', terminalResponse.error.code, false);
            }
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logImport('pipeline.importFiles.fileError', { filename: file.name, error: msg });
      result = { filename: file.name, status: 'error', error: msg };
    }

    results.push(result);
    progress.completed++;
    logImport('pipeline.file.done', { filename: file.name, status: result.status, error: result.error });
    publishProgress();
  }

  logImport('pipeline.importFiles.complete', { total: results.length, results: results.map(r => ({ f: r.filename, s: r.status, e: r.error })) });
  onReload?.();

  return results;
}
