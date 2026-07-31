// session/import-ops — asset import executor + `importAsset` session op.
//
// WHY THIS EXISTS (Invariant 7 convergence): asset import used to live entirely in
// content-browser/src/import-pipeline.ts as three raw `fetch` calls (upload binary,
// write .meta.json sidecar, trigger cook). There was NO `import` op in the catalog,
// so import never entered the ledger, was never traced, and — the real defect per
// the registry razor — an AI could NOT replay "import an asset" while a human could.
// This module makes import a first-class one-door operation:
//
//   - executeAssetImport(spec)  — the SINGLE import implementation. All disk writes
//     go through the assetIO write-gate (uploadSourceBytes / writeMetaSidecar /
//     triggerCook). Reused by BOTH the `importAsset` op applier AND the startup-scan
//     bootstrap path (which runs while the gateway is scan-locked and therefore
//     cannot dispatch — the init/bootstrap carve-out).
//   - `importAsset` session applier — human drag-drop / toolbar / AI dispatch this;
//     ledger-only (no undo: an import is not cleanly reversible — cook produces
//     derived artefacts and references). Its completion is bound by the Gateway
//     OperationRun registry; the applier never owns a second status map.
//
// The op carries only a path ("the source is on disk; import it"), never raw bytes —
// keeping the ledger clean and the op AI-replayable. Human callers upload the bytes
// through the same assetIO gate first, then dispatch with skipUpload:true.
//
// Anchors:
//   AGENTS.md Invariant 7 (one door) + Design principle 4 (registry razor).
//   Mirrors pack-ops.ts createDirectory (session applier) + createAsset (assetIO gate).

import { assetIO } from '../io/asset-io-facade';
import { getImportFormat } from '../scan/ext-importer-map';
import { cookGltfMeta } from '../assets/gltf-cook';
import { cookFbxMeta } from '../assets/fbx-cook';
import { awaitPostAssetWriteCatalogSync, generateAssetGuid } from './pack-ops';
import { sessionAppliers } from '../io/appliers';
import { broadcastAssetsChanged } from '../store/assets-changed';
import { resolveGamePath } from '../util/path-resolver';
import type { EditorOp } from '../types';

/** Terminal status of a single-file import (shared with the content-browser UI). */
export type ImportFileStatus = 'pending' | 'uploading' | 'sidecar' | 'cooking' | 'done' | 'cancelled' | 'error';
export type ImportProgressStage = Extract<ImportFileStatus, 'uploading' | 'sidecar' | 'cooking'>;

export interface ImportProgressEvent {
  readonly stage: ImportProgressStage;
  readonly fraction: number;
}

export interface ImportCancellationPolicy {
  readonly cancellable: boolean;
  readonly hint: string;
}

export type ImportFailureCode =
  | 'IMPORT_UNSUPPORTED_FORMAT'
  | 'IMPORT_SOURCE_BYTES_MISSING'
  | 'IMPORT_UPLOAD_FAILED'
  | 'IMPORT_SOURCE_READ_FAILED'
  | 'IMPORT_COOK_FAILED'
  | 'IMPORT_SIDECAR_WRITE_FAILED'
  | 'IMPORT_COOK_TRIGGER_FAILED'
  | 'IMPORT_NETWORK_ERROR'
  | 'IMPORT_CANCELLED'
  | 'IMPORT_CATALOG_SYNC_FAILED'
  | 'IMPORT_REIMPORT_META_MISSING'
  | 'IMPORT_REIMPORT_IDENTITY_MISSING'
  | 'IMPORT_EXECUTION_FAILED';

export interface ImportFailure {
  readonly code: ImportFailureCode;
  readonly path: string;
  readonly hint: string;
  readonly retryable: boolean;
  readonly recoveryActions: readonly string[];
}

export interface ImportSubAsset {
  readonly guid: string;
  readonly kind: string;
}

/** Result of importing one file — the shape the CB overlay + startup scan consume. */
export interface ImportFileResult {
  filename: string;
  status: ImportFileStatus;
  error?: string;
  errorDetail?: ImportFailure;
  guid?: string;
  subAssets?: readonly ImportSubAsset[];
}

/**
 * Import specification — "the source at destPath should be imported".
 *
 *  - destPath:  the source file's on-disk path (game-relative already resolved by
 *               the caller, OR resolvable via resolveGamePath — see the op applier).
 *  - sourceName: the file's basename (drives importer selection + cook meta.source).
 *  - base64:    in-memory bytes to upload FIRST (human drag-drop path). When absent,
 *               the executor reads the bytes it needs from disk (AI / startup scan).
 *  - skipUpload: bytes already on disk (startup scan / AI) — do not re-upload
 *               (re-upload trips vite-plugin-pack into a mid-import full reload).
 */
export interface AssetImportSpec {
  destPath: string;
  sourceName: string;
  base64?: string;
  skipUpload?: boolean;
  /** Reimport reads the existing sidecar and refuses to mint a replacement identity. */
  mode?: 'import' | 'reimport';
  onProgress?: (progress: ImportProgressEvent) => void;
  signal?: AbortSignal;
  onCancellationPolicy?: (policy: ImportCancellationPolicy) => void;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function createImportFailure(
  path: string,
  code: ImportFailureCode,
  hint: string,
  options: { readonly retryable?: boolean } = {},
): ImportFailure {
  const retryable = options.retryable ?? true;
  return {
    code,
    path,
    hint,
    retryable,
    recoveryActions: retryable ? ['operation.retry'] : ['import.verifySource'],
  };
}

function failedImport(
  filename: string,
  path: string,
  code: ImportFailureCode,
  hint: string,
  options: { readonly retryable?: boolean; readonly guid?: string } = {},
): ImportFileResult {
  const errorDetail = createImportFailure(path, code, hint, options);
  return {
    filename,
    status: 'error',
    error: hint,
    errorDetail,
    ...(options.guid === undefined ? {} : { guid: options.guid }),
  };
}

function cancelledImport(filename: string, path: string, hint: string): ImportFileResult {
  const errorDetail = createImportFailure(path, 'IMPORT_CANCELLED', hint, { retryable: false });
  return {
    filename,
    status: 'cancelled',
    error: hint,
    errorDetail,
  };
}

function subAssetsFromMetaJson(metaJson: string): readonly ImportSubAsset[] {
  try {
    const value = JSON.parse(metaJson) as { readonly subAssets?: unknown };
    if (!Array.isArray(value.subAssets)) return [];
    return value.subAssets.filter((entry): entry is ImportSubAsset => (
      entry !== null
      && typeof entry === 'object'
      && typeof (entry as { guid?: unknown }).guid === 'string'
      && typeof (entry as { kind?: unknown }).kind === 'string'
    )).map((entry) => ({ guid: entry.guid, kind: entry.kind }));
  } catch {
    return [];
  }
}

interface ExistingSubAsset {
  readonly guid: string;
  readonly kind: string;
  readonly sourceIndex: number;
}

interface ExistingImportMeta {
  readonly subAssets: readonly ExistingSubAsset[];
  readonly importSettings?: Readonly<Record<string, unknown>>;
}

function existingImportMeta(value: unknown): ExistingImportMeta | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as { subAssets?: unknown; importSettings?: unknown };
  if (!Array.isArray(record.subAssets)) return undefined;
  const subAssets = record.subAssets.flatMap((entry): ExistingSubAsset[] => {
    if (entry === null || typeof entry !== 'object') return [];
    const item = entry as { guid?: unknown; kind?: unknown; sourceIndex?: unknown };
    if (typeof item.guid !== 'string' || typeof item.kind !== 'string') return [];
    return [{
      guid: item.guid,
      kind: item.kind,
      sourceIndex: typeof item.sourceIndex === 'number' ? item.sourceIndex : 0,
    }];
  });
  const importSettings = record.importSettings !== null && typeof record.importSettings === 'object'
    ? record.importSettings as Readonly<Record<string, unknown>>
    : undefined;
  return { subAssets, ...(importSettings === undefined ? {} : { importSettings }) };
}

/**
 * THE single asset-import implementation. Every disk write routes through the
 * assetIO write-gate (Invariant 7 / write-gate axis). Returns the terminal result;
 * never throws (errors are captured into { status:'error', error }).
 */
export async function executeAssetImport(spec: AssetImportSpec): Promise<ImportFileResult> {
  const { destPath, sourceName, base64, skipUpload, mode = 'import', onProgress, signal, onCancellationPolicy } = spec;
  let cancellationPolicy: ImportCancellationPolicy = {
    cancellable: false,
    hint: 'Import is preparing; wait for the current write boundary to finish.',
  };
  const setCancellationPolicy = (policy: ImportCancellationPolicy): void => {
    cancellationPolicy = policy;
    onCancellationPolicy?.(policy);
  };
  const isCancelled = (): boolean => signal?.aborted === true && cancellationPolicy.cancellable;
  const cancelledHint = 'Import cancelled before its next write boundary; no temporary sidecar was created.';
  const ext = sourceName.slice(sourceName.lastIndexOf('.')).toLowerCase();
  const format = getImportFormat(sourceName);

  if (!format) {
    return failedImport(sourceName, destPath, 'IMPORT_UNSUPPORTED_FORMAT', `Unsupported format: ${ext}`, { retryable: false });
  }

  if (signal?.aborted === true) return cancelledImport(sourceName, destPath, cancelledHint);

  try {
    // 1. Upload bytes (human drag-drop path) unless they are already on disk.
    if (!skipUpload) {
      setCancellationPolicy({
        cancellable: false,
        hint: 'Import is uploading the source; cancellation is unavailable until the write completes.',
      });
      if (base64 === undefined) {
        return failedImport(sourceName, destPath, 'IMPORT_SOURCE_BYTES_MISSING', 'No source bytes to upload', { retryable: false });
      }
      onProgress?.({ stage: 'uploading', fraction: 0.2 });
      const uploaded = await assetIO.uploadSourceBytes(destPath, base64, signal);
      if (!uploaded.ok) {
        return failedImport(
          sourceName,
          destPath,
          uploaded.error.kind === 'network' ? 'IMPORT_NETWORK_ERROR' : 'IMPORT_UPLOAD_FAILED',
          uploaded.error.hint,
        );
      }
    }

    // UI packages keep the sidecar beside the source stem (`hud.meta.json`),
    // while the older external importers use `<source>.meta.json`.
    const metaPath = format.importer === 'ui'
      ? destPath.replace(/\.ui\.html$/i, '.meta.json')
      : `${destPath}.meta.json`;
    if (mode === 'reimport' || format.importer === 'gltf' || format.importer === 'fbx') {
      setCancellationPolicy({
        cancellable: true,
        hint: 'Import can be cancelled while reading and cooking the source; no sidecar write has started.',
      });
    }
    let existing: ExistingImportMeta | undefined;
    if (mode === 'reimport') {
      existing = existingImportMeta(await assetIO.readExistingMeta(metaPath));
      if (isCancelled()) return cancelledImport(sourceName, destPath, cancelledHint);
      if (existing === undefined) {
        return failedImport(
          sourceName,
          destPath,
          'IMPORT_REIMPORT_META_MISSING',
          `Reimport requires an existing metadata sidecar at ${metaPath}.`,
          { retryable: false },
        );
      }
      if (existing.subAssets.length === 0) {
        return failedImport(
          sourceName,
          destPath,
          'IMPORT_REIMPORT_IDENTITY_MISSING',
          `Reimport metadata at ${metaPath} has no producer-owned sub-asset identities.`,
          { retryable: false },
        );
      }
    }
    const guid = existing?.subAssets[0]?.guid ?? generateAssetGuid();

    // 2. glTF / FBX are cooked into a canonical meta.json on the frontend (engine
    //    SSOT) — the bytes come from `base64` if provided, else read back from disk.
    if (format.importer === 'gltf' || format.importer === 'fbx') {
      setCancellationPolicy({
        cancellable: true,
        hint: 'Import can be cancelled while reading and cooking the source; no sidecar write has started.',
      });
      onProgress?.({ stage: 'cooking', fraction: 0.55 });
      const sourceBytes = base64 !== undefined
        ? { ok: true as const, value: base64ToArrayBuffer(base64) }
        : await assetIO.readSourceBytes(destPath, signal);
      if (isCancelled()) return cancelledImport(sourceName, destPath, cancelledHint);
      if (!sourceBytes.ok) {
        return failedImport(
          sourceName,
          destPath,
          sourceBytes.error.kind === 'network' ? 'IMPORT_NETWORK_ERROR' : 'IMPORT_SOURCE_READ_FAILED',
          sourceBytes.error.hint,
          { retryable: sourceBytes.error.kind === 'network' },
        );
      }
      const bytes = sourceBytes.value;
      if (existing === undefined) existing = existingImportMeta(await assetIO.readExistingMeta(metaPath));
      if (isCancelled()) return cancelledImport(sourceName, destPath, cancelledHint);
      let cooked: Awaited<ReturnType<typeof cookGltfMeta>> | Awaited<ReturnType<typeof cookFbxMeta>>;
      try {
        cooked = format.importer === 'gltf'
          ? await cookGltfMeta(bytes, sourceName, existing)
          : await cookFbxMeta(bytes, sourceName, existing);
      } catch (err) {
        if (isCancelled()) return cancelledImport(sourceName, destPath, cancelledHint);
        const hint = err instanceof Error ? err.message : String(err);
        return failedImport(sourceName, destPath, 'IMPORT_COOK_FAILED', hint, { retryable: false });
      }
      if (!cooked.ok || !cooked.metaJson) {
        return failedImport(sourceName, destPath, 'IMPORT_COOK_FAILED', cooked.error ?? `${format.importer} cook failed`, { retryable: false });
      }
      if (isCancelled()) return cancelledImport(sourceName, destPath, cancelledHint);
      setCancellationPolicy({
        cancellable: false,
        hint: 'Import is writing the metadata sidecar; cancellation is unavailable until the write completes.',
      });
      onProgress?.({ stage: 'sidecar', fraction: 1 });
      const wrote = await assetIO.writeMetaSidecar(metaPath, cooked.metaJson, signal);
      if (!wrote.ok) {
        return failedImport(
          sourceName,
          destPath,
          wrote.error.kind === 'network' ? 'IMPORT_NETWORK_ERROR' : 'IMPORT_SIDECAR_WRITE_FAILED',
          wrote.error.hint,
          { guid },
        );
      }
      return { filename: sourceName, status: 'done', guid, subAssets: subAssetsFromMetaJson(cooked.metaJson) };
    }

    // 3. Other importers (image/audio/font/pack): write a simple sidecar + cook.
    // Font is special: the engine fontImporter expects three sub-assets
    // (texture atlas, sampler, font glyph metrics) declared in the sidecar so
    // it can resolve each by kind. All other importers produce a single
    // sub-asset of their declared kind.
    const subAssets = format.subAssetKinds.map((kind) => ({
      guid: existing?.subAssets.find((entry) => entry.kind === kind && entry.sourceIndex === 0)?.guid
        ?? (kind === format.subAssetKinds[0] ? guid : generateAssetGuid()),
      sourceIndex: 0,
      kind,
    }));
    const meta = {
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: format.importer,
      source: sourceName,
      importSettings: { ...format.defaultSettings, ...(existing?.importSettings ?? {}) },
      subAssets,
    };
    setCancellationPolicy({
      cancellable: false,
      hint: 'Import is writing the metadata sidecar; cancellation is unavailable until the write completes.',
    });
    onProgress?.({ stage: 'sidecar', fraction: format.importer === 'audio' ? 1 : 0.5 });
    const wrote = await assetIO.writeMetaSidecar(metaPath, JSON.stringify(meta, null, 2) + '\n', signal);
    if (!wrote.ok) {
      return failedImport(
        sourceName,
        destPath,
        wrote.error.kind === 'network' ? 'IMPORT_NETWORK_ERROR' : 'IMPORT_SIDECAR_WRITE_FAILED',
        wrote.error.hint,
        { guid },
      );
    }

    // Audio is pass-through — sidecar alone is sufficient for catalog fold.
    if (format.importer !== 'audio') {
      setCancellationPolicy({
        cancellable: false,
        hint: 'Import is triggering the engine cook; cancellation is unavailable after the sidecar write.',
      });
      onProgress?.({ stage: 'cooking', fraction: 1 });
      const cooked = await assetIO.triggerCook(guid, signal);
      if (!cooked.ok) {
        return failedImport(
          sourceName,
          destPath,
          cooked.error.kind === 'network' ? 'IMPORT_NETWORK_ERROR' : 'IMPORT_COOK_TRIGGER_FAILED',
          cooked.error.hint,
          { guid },
        );
      }
    }
    return {
      filename: sourceName,
      status: 'done',
      guid,
      subAssets: subAssets.map(({ guid: subAssetGuid, kind }) => ({ guid: subAssetGuid, kind })),
    };
  } catch (err) {
    if (isCancelled()) return cancelledImport(sourceName, destPath, cancelledHint);
    const msg = err instanceof Error ? err.message : String(err);
    return failedImport(sourceName, destPath, 'IMPORT_EXECUTION_FAILED', msg, { retryable: false });
  }
}

// ── Session appliers: import/reimport (ledger-only, no undo) ─────────────────
// Both operations share this one completion owner. The only semantic difference
// is whether the executor may mint identity (import) or must reuse the existing
// source metadata (reimport).
function registerImportOperation(operationId: 'importAsset' | 'reimportAsset', mode: 'import' | 'reimport'): void {
  sessionAppliers.set(operationId, (op, ctx) => {
    const { destPath, sourceName, skipUpload, requestId } = op as {
      destPath: string; sourceName?: string; skipUpload?: boolean; requestId: string;
    };
    if (typeof destPath !== 'string' || destPath.trim() === '') {
      return { ok: false as const, error: { code: 'INVALID_ARGS', hint: `${operationId}.destPath must be a non-empty source path` } };
    }
    if (typeof requestId !== 'string' || requestId.trim() === '') {
      return { ok: false as const, error: { code: 'INVALID_ARGS', hint: `${operationId}.requestId must be a non-empty caller-minted id` } };
    }
    let resolved: string;
    try {
      resolved = resolveGamePath(destPath);
    } catch (err) {
      return { ok: false as const, error: { code: 'INVALID_ARGS', hint: err instanceof Error ? err.message : String(err) } };
    }
    const name = sourceName ?? destPath.slice(destPath.lastIndexOf('/') + 1);
    const cancellation = new AbortController();
    let cancellationPolicy: ImportCancellationPolicy = {
      cancellable: false,
      hint: 'Import is preparing; wait for the current write boundary to finish.',
    };
    ctx?.operationRun?.registerCancelHandler?.(() => {
      if (!cancellationPolicy.cancellable) {
        return {
          ok: false as const,
          error: {
            code: 'run-not-cancellable',
            hint: cancellationPolicy.hint,
            retryable: false,
            recoveryActions: ['run.wait'],
          },
        };
      }
      cancellation.abort();
      return { ok: true as const };
    });
    const completion = executeAssetImport({
      destPath: resolved,
      sourceName: name,
      skipUpload: mode === 'reimport' ? true : (skipUpload ?? true),
      mode,
      signal: cancellation.signal,
      onCancellationPolicy: (policy) => {
        cancellationPolicy = policy;
      },
      onProgress: (progress) => ctx?.operationRun?.reportProgress({ ...progress }),
    })
      .then(async (result) => {
        if (result.status === 'done') {
          const catalogGuid = result.subAssets?.[0]?.guid ?? result.guid;
          try {
            if (catalogGuid !== undefined) await awaitPostAssetWriteCatalogSync(catalogGuid);
          } catch (err) {
            const hint = err instanceof Error ? err.message : String(err);
            return {
              ok: false as const,
              error: {
                code: 'IMPORT_CATALOG_SYNC_FAILED',
                hint,
                subjectRef: { kind: 'source-file', id: destPath },
                retryable: true,
                recoveryActions: ['operation.retry'],
              },
            };
          }
          broadcastAssetsChanged();
          return { ok: true as const, result };
        }
        const detail = result.errorDetail;
        return {
          ok: false as const,
          error: {
            code: detail?.code ?? 'IMPORT_EXECUTION_FAILED',
            hint: detail?.hint ?? result.error ?? `Asset import failed for ${name}.`,
            subjectRef: { kind: 'source-file', id: destPath },
            retryable: detail?.retryable ?? false,
            recoveryActions: detail?.recoveryActions ?? ['import.verifySource'],
          },
        };
      });
    return { ok: true as const, completion };
  });
}

registerImportOperation('importAsset', 'import');
registerImportOperation('reimportAsset', 'reimport');

// Re-export so consumers passing an EditorOp keep the union import shape.
export type { EditorOp };
