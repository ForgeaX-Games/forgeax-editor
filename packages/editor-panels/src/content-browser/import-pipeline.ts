/**
 * Import pipeline — uploads files and creates .meta.json sidecars so the
 * engine import system can cook them into native assets.
 *
 * Flow per file:
 *   1. Upload binary via POST /api/files/upload (base64 body)
 *   2. Create <file>.meta.json sidecar (external-asset-package)
 *   3. Best-effort cook trigger via POST /__import/:guid
 *   4. Notify listeners (broadcastAssetsChanged)
 */

import { cookGltfMeta, generateAssetGuid, getApiClient } from '@forgeax/editor-core';
import { broadcastAssetsChanged, resolveGamePath } from '@forgeax/editor-shared';
import { getImportFormat, isImportable, type ImportFormat } from './import-registry';

export type ImportFileStatus = 'pending' | 'uploading' | 'sidecar' | 'cooking' | 'done' | 'error';

export interface ImportFileResult {
  filename: string;
  status: ImportFileStatus;
  error?: string;
  guid?: string;
}

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

async function uploadFile(destPath: string, file: File): Promise<boolean> {
  const buf = await file.arrayBuffer();
  const data = arrayBufferToBase64(buf);
  const r = await getApiClient().fetch('/api/files/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: destPath, data }),
  });
  return r.ok;
}

async function writeMetaSidecar(
  metaPath: string,
  sourceFilename: string,
  format: ImportFormat,
  guid: string,
): Promise<boolean> {
  const meta = {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: format.importer,
    source: sourceFilename,
    importSettings: { ...format.defaultSettings },
    subAssets: [{
      guid,
      sourceIndex: 0,
      kind: format.subAssetKind,
    }],
  };
  const r = await getApiClient().fetch('/api/files', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: metaPath,
      content: JSON.stringify(meta, null, 2) + '\n',
    }),
  });
  return r.ok;
}

async function triggerCook(guid: string): Promise<string | undefined> {
  try {
    const res = await fetch(`/__import/${guid}`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string; reason?: string; hint?: string };
      return body.reason ?? body.hint ?? `cook failed (${res.status})`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Read an existing `.meta.json` (text) for reimport GUID reuse; undefined on first import. */
async function readExistingMeta(metaPath: string): Promise<unknown> {
  try {
    const r = await getApiClient().fetch(`/api/files/raw?path=${encodeURIComponent(metaPath)}`);
    if (!r.ok) return undefined;
    return JSON.parse(await r.text());
  } catch {
    return undefined;
  }
}

/** Write a pre-built meta.json string to disk via the file API. */
async function writeMetaContent(metaPath: string, content: string): Promise<boolean> {
  const r = await getApiClient().fetch('/api/files', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: metaPath, content }),
  });
  return r.ok;
}

/** Cook a GLB/GLTF into a canonical meta.json on the frontend (engine SSOT) and write it.
 *  Replaces the platform-io `process-gltf` endpoint (which omitted the `scene` sub-asset). */
async function processGltf(file: File, destPath: string): Promise<{ ok: boolean; error?: string }> {
  const metaPath = `${destPath}.meta.json`;
  const sourceName = destPath.slice(destPath.lastIndexOf('/') + 1);
  const existing = await readExistingMeta(metaPath);
  const cooked = await cookGltfMeta(await file.arrayBuffer(), sourceName, existing);
  if (!cooked.ok || !cooked.metaJson) {
    return { ok: false, error: cooked.error ?? 'glTF cook failed' };
  }
  const wrote = await writeMetaContent(metaPath, cooked.metaJson);
  return wrote ? { ok: true } : { ok: false, error: 'Failed to write .meta.json sidecar' };
}

/**
 * Import a single file into the game's asset directory.
 *
 * Returns the generated GUID for the primary sub-asset, or null on failure.
 */
export async function importSingleFile(
  file: File,
  currentPath: string,
): Promise<ImportFileResult> {
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  const format = getImportFormat(ext);

  if (!format) {
    return { filename: file.name, status: 'error', error: `Unsupported format: ${ext}` };
  }

  // Host-resolved import target — the studio games-dir convention lives in the
  // edit-runtime adapter (setPathResolver), not here.
  const basePath = resolveGamePath(currentPath || 'assets');
  const destPath = `${basePath}/${file.name}`;
  const guid = generateAssetGuid();

  try {
    const uploaded = await uploadFile(destPath, file);
    if (!uploaded) {
      return { filename: file.name, status: 'error', error: 'Upload failed' };
    }

    if (format.importer === 'gltf') {
      // GLB/GLTF: cook the canonical meta (external-asset-package incl. the
      // `scene` sub-asset + stable GUIDs) on the frontend via the engine SSOT,
      // then write it. No per-guid cook trigger needed.
      const result = await processGltf(file, destPath);
      if (!result.ok) {
        return { filename: file.name, status: 'error', error: result.error ?? 'glTF import failed' };
      }
      return { filename: file.name, status: 'done', guid };
    }

    const metaPath = `${destPath}.meta.json`;
    const wrote = await writeMetaSidecar(metaPath, file.name, format, guid);
    if (!wrote) {
      return { filename: file.name, status: 'error', error: 'Failed to create .meta.json sidecar' };
    }

    const cookError = await triggerCook(guid);

    return {
      filename: file.name,
      status: cookError ? 'error' : 'done',
      guid,
      error: cookError,
    };
  } catch (err) {
    return {
      filename: file.name,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Import multiple files with progress reporting.
 *
 * Calls `onProgress` after each file completes. Calls `onReload` once at
 * the end to refresh the Content Browser.
 */
export async function importFiles(
  files: File[],
  currentPath: string,
  onProgress?: ImportProgressCallback,
  onReload?: () => void,
): Promise<ImportFileResult[]> {
  const importable = files.filter(f => isImportable(f.name));
  if (importable.length === 0) return [];

  const results: ImportFileResult[] = [];
  const progress: ImportProgress = {
    total: importable.length,
    completed: 0,
    current: '',
    results,
  };

  for (const file of importable) {
    progress.current = file.name;
    onProgress?.(structuredClone(progress));

    const result = await importSingleFile(file, currentPath);
    results.push(result);
    progress.completed++;
    onProgress?.(structuredClone(progress));
  }

  broadcastAssetsChanged();
  onReload?.();

  return results;
}
