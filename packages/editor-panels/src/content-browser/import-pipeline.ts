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

import { generateAssetGuid } from '@forgeax/editor-core';
import { broadcastAssetsChanged } from '@forgeax/editor-shared';
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
  const r = await fetch('/api/files/upload', {
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
  const r = await fetch('/api/files', {
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

/** Handle GLB/GLTF through the existing process-gltf endpoint if available. */
async function processGltf(destPath: string): Promise<boolean> {
  try {
    const r = await fetch('/api/assets/process-gltf', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: destPath }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Import a single file into the game's asset directory.
 *
 * Returns the generated GUID for the primary sub-asset, or null on failure.
 */
export async function importSingleFile(
  file: File,
  gameSlug: string,
  currentPath: string,
): Promise<ImportFileResult> {
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  const format = getImportFormat(ext);

  if (!format) {
    return { filename: file.name, status: 'error', error: `Unsupported format: ${ext}` };
  }

  const basePath = `.forgeax/games/${gameSlug}/${currentPath || 'assets'}`;
  const destPath = `${basePath}/${file.name}`;
  const guid = generateAssetGuid();

  try {
    const uploaded = await uploadFile(destPath, file);
    if (!uploaded) {
      return { filename: file.name, status: 'error', error: 'Upload failed' };
    }

    if (format.importer === 'gltf') {
      const processed = await processGltf(destPath);
      if (!processed) {
        const metaPath = `${destPath}.meta.json`;
        await writeMetaSidecar(metaPath, file.name, format, guid);
      }
    } else {
      const metaPath = `${destPath}.meta.json`;
      const wrote = await writeMetaSidecar(metaPath, file.name, format, guid);
      if (!wrote) {
        return { filename: file.name, status: 'error', error: 'Failed to create .meta.json sidecar' };
      }
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
  gameSlug: string,
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

    const result = await importSingleFile(file, gameSlug, currentPath);
    results.push(result);
    progress.completed++;
    onProgress?.(structuredClone(progress));
  }

  broadcastAssetsChanged();
  onReload?.();

  return results;
}
