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
  broadcastAssetsChanged,
  createImportFailure,
  dispatchActiveEditorOperation,
  getViewportRuntimeOperationRun,
  resolveFbxImportDependencies,
  resolveGamePath,
  retryViewportRuntimeOperationRun,
  waitViewportRuntimeOperationRun,
  type ImportFailureCode,
  type FbxDependencyCandidate,
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

async function waitForImportRunWithProgress(
  requestId: string,
  onRunUpdate: (run: OperationRun) => void,
): Promise<OperationRun> {
  let latestRun: OperationRun | undefined;
  const publishLatest = (): void => {
    if (latestRun !== undefined) onRunUpdate(latestRun);
  };

  const poll = setInterval(() => {
    void getViewportRuntimeOperationRun(requestId).then((response) => {
      if (response.error !== undefined || response.result === undefined) return;
      latestRun = response.result as OperationRun;
      publishLatest();
    });
  }, 100);

  try {
    const terminalResponse = await waitViewportRuntimeOperationRun(requestId);
    if (terminalResponse.error !== undefined) {
      throw new Error(terminalResponse.error.hint ?? terminalResponse.error.code);
    }
    latestRun = terminalResponse.result as OperationRun;
    publishLatest();
    return latestRun;
  } finally {
    clearInterval(poll);
  }
}

function refreshImportedAssets(onReload?: () => void): void {
  onReload?.();
  broadcastAssetsChanged('directory-only', 'local-op');
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

interface ImportDependencyFile {
  readonly file: File;
  readonly relativePath: string;
  readonly sourceRelativePath: string;
}

interface ImportUnit {
  readonly file: File;
  readonly destinationPath: string;
  readonly dependencies?: readonly ImportDependencyFile[];
}

export function mapFbxDependencyResolutionCode(
  code: 'fbx-external-texture-missing'
    | 'fbx-external-texture-ambiguous'
    | 'fbx-external-texture-unsupported'
    | 'fbx-source-invalid',
): 'IMPORT_FBX_DEPENDENCY_SCOPE_REQUIRED'
  | 'IMPORT_FBX_DEPENDENCY_AMBIGUOUS'
  | 'IMPORT_FBX_SOURCE_INVALID'
  | 'IMPORT_FBX_UNSUPPORTED' {
  return code === 'fbx-external-texture-ambiguous'
    ? 'IMPORT_FBX_DEPENDENCY_AMBIGUOUS'
    : code === 'fbx-source-invalid'
      ? 'IMPORT_FBX_SOURCE_INVALID'
      : code === 'fbx-external-texture-unsupported'
        ? 'IMPORT_FBX_UNSUPPORTED'
        : 'IMPORT_FBX_DEPENDENCY_SCOPE_REQUIRED';
}

function normalizeSelectionPath(raw: string): string {
  return raw.replaceAll('\\', '/').replace(/^\.?\//, '').replace(/^\/+|\/+$/g, '');
}

function selectionRelativePath(file: File): string {
  const relative = (file as File & { readonly webkitRelativePath?: string }).webkitRelativePath;
  return normalizeSelectionPath(relative || file.name);
}

function folderPrefix(files: readonly File[]): string {
  const paths = files.map(selectionRelativePath);
  if (paths.length === 0 || paths.some((path) => !path.includes('/'))) return '';
  const first = paths[0]!.split('/')[0]!;
  return paths.every((path) => path.split('/')[0] === first) ? `${first}/` : '';
}

function stripFolderPrefix(path: string, prefix: string): string {
  return prefix !== '' && path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function sourceRelativePath(sourcePath: string, candidatePath: string): string {
  const from = dirname(sourcePath).split('/').filter(Boolean);
  const to = candidatePath.split('/').filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  return [
    ...from.slice(common).map(() => '..'),
    ...to.slice(common),
  ].join('/') || './';
}

function joinGamePath(base: string, relativePath: string): string {
  return `${base.replace(/\/+$/g, '')}/${relativePath.replace(/^\/+/, '')}`;
}

function isFbx(file: File): boolean {
  return file.name.toLowerCase().endsWith('.fbx');
}

async function prepareFolderImportUnit(
  files: readonly File[],
  root: File,
): Promise<
  | { readonly ok: true; readonly unit: ImportUnit }
  | {
      readonly ok: false;
      readonly code:
        | 'IMPORT_FBX_DEPENDENCY_SCOPE_REQUIRED'
        | 'IMPORT_FBX_DEPENDENCY_AMBIGUOUS'
        | 'IMPORT_FBX_PARSE_FAILED'
        | 'IMPORT_FBX_SOURCE_INVALID'
        | 'IMPORT_FBX_UNSUPPORTED';
      readonly hint: string;
    }
> {
  const prefix = folderPrefix(files);
  const rootPath = stripFolderPrefix(selectionRelativePath(root), prefix);
  const candidates: Array<FbxDependencyCandidate & { readonly file: File }> = files
    .filter((file) => file !== root)
    .map((file) => {
      const relativePath = stripFolderPrefix(selectionRelativePath(file), prefix);
      return {
        file,
        relativePath,
        sourceRelativePath: sourceRelativePath(rootPath, relativePath),
      };
    });
  const resolution = await resolveFbxImportDependencies(
    await root.arrayBuffer(),
    rootPath,
    candidates,
  );
  if (!resolution.ok) {
    return {
      ok: false,
      code: mapFbxDependencyResolutionCode(resolution.code),
      hint: resolution.hint,
    };
  }
  const dependencies: ImportDependencyFile[] = [];
  for (const dependency of resolution.files) {
    const candidate = candidates.find((entry) => entry.relativePath.toLowerCase() === dependency.relativePath.toLowerCase());
    if (candidate === undefined) {
      return {
        ok: false,
        code: 'IMPORT_FBX_DEPENDENCY_SCOPE_REQUIRED',
        hint: `The selected FBX dependency ${dependency.relativePath} is not available in the selected file scope; choose the containing folder.`,
      };
    }
    dependencies.push({
      file: candidate.file,
      relativePath: dependency.relativePath,
      sourceRelativePath: dependency.sourceRelativePath,
    });
  }
  return {
    ok: true,
    unit: {
      file: root,
      destinationPath: rootPath,
      dependencies,
    },
  };
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
  try {
    const terminal = await waitForImportRunWithProgress(requestId, (run) => onRun?.(requestId, run));
    onRun?.(requestId, terminal);
    return {
      ok: true,
      requestId,
      terminal,
      result: importRunToResult(record.filename, record.path, terminal),
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'IMPORT_EXECUTION_FAILED',
        hint: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Import multiple files with progress reporting.
 *
 * Sends each file's bytes to Runtime through the `importAsset` op (one door).
 * Calls `onProgress` after each dispatch and refreshes the Content Browser
 * after every terminal file result.
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
  const folderSelection = files.some((file) => {
    const relative = (file as File & { readonly webkitRelativePath?: string }).webkitRelativePath;
    return typeof relative === 'string' && relative.length > 0;
  });
  if (folderSelection) {
    const fbxRoots = files.filter(isFbx);
    if (fbxRoots.length !== 1) {
      const name = fbxRoots.length === 0 ? 'selected-folder' : 'selected-folder (choose one FBX)';
      return [failureResult(
        name,
        name,
        'IMPORT_FBX_ROOT_SELECTION_REQUIRED',
        fbxRoots.length === 0
          ? 'Folder import requires exactly one FBX root file; choose an FBX file or a folder containing one FBX.'
          : `Folder import found ${fbxRoots.length} FBX roots; choose one FBX file instead of importing the whole folder.`,
        false,
      )];
    }
    const prepared = await prepareFolderImportUnit(files, fbxRoots[0]!);
    if (!prepared.ok) {
      return [failureResult(
        fbxRoots[0]!.name,
        selectionRelativePath(fbxRoots[0]!),
        prepared.code,
        prepared.hint,
        false,
      )];
    }
    return importPreparedUnits([prepared.unit], currentPath, onProgress, onReload, files);
  }
  if (importable.length === 1 && isFbx(importable[0]!)) {
    const root = importable[0]!;
    const prepared = await prepareFolderImportUnit([root], root);
    if (!prepared.ok) {
      return [failureResult(
        root.name,
        root.name,
        prepared.code,
        prepared.hint,
        false,
      )];
    }
    return importPreparedUnits([prepared.unit], currentPath, onProgress, onReload, files);
  }
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

  return importPreparedUnits(
    importable.map((file) => ({ file, destinationPath: file.name })),
    currentPath,
    onProgress,
    onReload,
    files,
  );
}

async function importPreparedUnits(
  units: readonly ImportUnit[],
  currentPath: string,
  onProgress?: ImportProgressCallback,
  onReload?: () => void,
  selectedFiles: readonly File[] = [],
): Promise<ImportFileResult[]> {
  const results: ImportFileResult[] = [];
  const progress: ImportProgress = {
    total: units.length,
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

  for (const unit of units) {
    const file = unit.file;
    progress.current = file.name;
    progress.currentRequestId = undefined;
    progress.currentRun = undefined;
    progress.actionError = undefined;
    publishProgress();

    const uploadPath = `${basePath}/${unit.destinationPath}`;
    const gameRelPath = joinGamePath(gameRelBase, unit.destinationPath);
    let result: ImportFileResult;
    try {
      logImport('pipeline.file.readBytes', { filename: file.name, size: file.size, uploadPath, gameRelPath });
      const base64 = arrayBufferToBase64(await file.arrayBuffer());
      const uiCompanion = unit.dependencies === undefined && file.name.toLowerCase().endsWith('.ui.html')
        ? selectedFiles.find(candidate => candidate.name.toLowerCase() === file.name.toLowerCase().replace(/\.ui\.html$/, '.ui.css'))
        : undefined;
      const companionSources = uiCompanion === undefined
        ? undefined
        : [{
          destPath: `${gameRelBase}/${uiCompanion.name}`,
          base64: arrayBufferToBase64(await uiCompanion.arrayBuffer()),
        }];
      const sourceFiles = unit.dependencies === undefined
        ? undefined
        : await Promise.all(unit.dependencies.map(async (dependency) => ({
          destPath: joinGamePath(gameRelBase, dependency.relativePath),
          relativePath: dependency.sourceRelativePath,
          base64: arrayBufferToBase64(await dependency.file.arrayBuffer()),
        })));
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
            ...(sourceFiles === undefined ? {} : { sourceFiles }),
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
            try {
              const terminal = await waitForImportRunWithProgress(requestId, (run) => {
                const record = progress.runs.find(entry => entry.requestId === requestId);
                if (record) record.run = run;
                progress.currentRun = run;
                publishProgress();
              });
              result = importRunToResult(file.name, uploadPath, terminal);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              result = failureResult(file.name, uploadPath, 'IMPORT_EXECUTION_FAILED', msg, false);
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
    refreshImportedAssets(onReload);
  }

  logImport('pipeline.importFiles.complete', { total: results.length, results: results.map(r => ({ f: r.filename, s: r.status, e: r.error })) });

  return results;
}
