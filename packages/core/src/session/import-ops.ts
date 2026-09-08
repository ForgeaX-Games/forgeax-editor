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

import { assetIO, type AssetIoResult } from '../io/asset-io-facade';
import { getImportFormat } from '../scan/ext-importer-map';
import { cookGltfMeta } from '../assets/gltf-cook';
import { cookFbxMeta } from '../assets/fbx-cook';
import { generateAssetGuid } from './pack-ops';
import { awaitPostAssetWriteCatalogSync } from './authored-asset-write';
import { registerApplier } from '../io/appliers';
import { broadcastAssetsChanged } from '../store/assets-changed';
import { resolveGamePath } from '../util/path-resolver';
import {
  validateImportDestinationPath,
  validateImportSourceRelativePath,
} from './asset-basename';
import type { EditorOp } from '../types';
import { createRuntimeReadiness, type RuntimeReadiness, type RuntimeRevision } from '../io/vfx-runtime-readiness';

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
  | 'IMPORT_SOURCE_TARGET_CONFLICT'
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
  | 'IMPORT_FBX_ROOT_SELECTION_REQUIRED'
  | 'IMPORT_FBX_DEPENDENCY_SCOPE_REQUIRED'
  | 'IMPORT_FBX_DEPENDENCY_AMBIGUOUS'
  | 'IMPORT_FBX_PARSE_FAILED'
  | 'IMPORT_FBX_SOURCE_INVALID'
  | 'IMPORT_FBX_UNSUPPORTED'
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
  runtimeReadiness?: RuntimeReadiness;
}

export function withRuntimeReadiness(
  result: ImportFileResult,
  input: {
    readonly requestId: string;
    readonly assetGuid: string;
    readonly committedRevision: RuntimeRevision;
    readonly residentRevision: RuntimeRevision;
  },
): ImportFileResult {
  if (result.status !== 'done') return result;
  return {
    ...result,
    runtimeReadiness: createRuntimeReadiness({
      state: 'committed-awaiting-reload',
      requestId: input.requestId,
      assetGuid: input.assetGuid,
      committedRevision: input.committedRevision,
      residentRevision: input.residentRevision,
      hint: 'Stop and Play to load the committed revision.',
    }),
  };
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
  companionSources?: readonly {
    destPath: string;
    base64: string;
  }[];
  /**
   * Bounded dependency closure for a compound source. `relativePath` is
   * source-relative to the root FBX; `destPath` preserves the selected folder
   * layout in the game. The root itself remains `destPath` + `base64` above.
   */
  sourceFiles?: readonly {
    destPath: string;
    relativePath: string;
    base64: string;
  }[];
  skipUpload?: boolean;
  /** Caller correlation used to make staging names unique and diagnosable. */
  requestId?: string;
  /** Reimport reads the existing sidecar and refuses to mint a replacement identity. */
  mode?: 'import' | 'reimport';
  onProgress?: (progress: ImportProgressEvent) => void;
  signal?: AbortSignal;
  onCancellationPolicy?: (policy: ImportCancellationPolicy) => void;
}

export interface SourceReimportSpec {
  readonly guid: string;
  readonly metaPath: string;
  readonly signal?: AbortSignal;
}

/** Rebuild an existing source through the producer without rewriting Meta. */
export async function executeSourceReimport(spec: SourceReimportSpec): Promise<ImportFileResult> {
  const snapshot = await assetIO.readMetaSidecar(spec.metaPath);
  if (!snapshot.ok) {
    return failedImport(spec.guid, spec.metaPath, 'IMPORT_REIMPORT_META_MISSING', snapshot.error.hint, { retryable: true, guid: spec.guid });
  }
  try {
    const meta = JSON.parse(snapshot.value.contents) as { subAssets?: unknown };
    if (!Array.isArray(meta.subAssets) || meta.subAssets.length === 0) {
      return failedImport(spec.guid, spec.metaPath, 'IMPORT_REIMPORT_IDENTITY_MISSING', 'Reimport Meta has no producer-owned sub-asset identities.', { retryable: false, guid: spec.guid });
    }
    const cooked = await assetIO.triggerCook(spec.guid, spec.signal);
    if (!cooked.ok) {
      return failedImport(spec.guid, spec.metaPath, 'IMPORT_COOK_TRIGGER_FAILED', cooked.error.hint, { guid: spec.guid });
    }
    await awaitPostAssetWriteCatalogSync(spec.guid);
    broadcastAssetsChanged();
    return { filename: spec.guid, status: 'done', guid: spec.guid, subAssets: subAssetsFromMetaJson(snapshot.value.contents) };
  } catch (error) {
    return failedImport(spec.guid, spec.metaPath, 'IMPORT_EXECUTION_FAILED', error instanceof Error ? error.message : String(error), { guid: spec.guid });
  }
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

/** glTF/FBX imports publish a disk sidecar; sub-assets cook lazily on first use. */
function isSourcePackageImport(sourceName: string): boolean {
  const ext = sourceName.slice(sourceName.lastIndexOf('.')).toLowerCase();
  return ext === '.glb' || ext === '.gltf' || ext === '.fbx';
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
  readonly sourceKey?: string;
}

interface ExistingImportMeta {
  readonly subAssets: readonly ExistingSubAsset[];
  readonly importSettings?: Readonly<Record<string, unknown>>;
  readonly sourceOverrides?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** Preserve authored identity and editor-owned facts across a producer rebuild. */
export function mergeSourceReimportMeta(
  existingValue: unknown,
  rebuiltValue: unknown,
): Record<string, unknown> {
  const existing = existingValue !== null && typeof existingValue === 'object' && !Array.isArray(existingValue)
    ? existingValue as Record<string, unknown>
    : {};
  const rebuilt = rebuiltValue !== null && typeof rebuiltValue === 'object' && !Array.isArray(rebuiltValue)
    ? rebuiltValue as Record<string, unknown>
    : {};
  const merged = { ...rebuilt };
  for (const field of ['guid', 'sourceOverrides', 'importSettings', 'subAssets', 'instances', 'promote'] as const) {
    if (existing[field] !== undefined) merged[field] = existing[field];
  }
  return merged;
}

function existingImportMeta(value: unknown): ExistingImportMeta | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as { subAssets?: unknown; importSettings?: unknown; sourceOverrides?: unknown };
  if (!Array.isArray(record.subAssets)) return undefined;
  const subAssets = record.subAssets.flatMap((entry): ExistingSubAsset[] => {
    if (entry === null || typeof entry !== 'object') return [];
    const item = entry as { guid?: unknown; kind?: unknown; sourceIndex?: unknown };
    if (typeof item.guid !== 'string' || typeof item.kind !== 'string') return [];
    return [{
      guid: item.guid,
      kind: item.kind,
      sourceIndex: typeof item.sourceIndex === 'number' ? item.sourceIndex : 0,
      ...(typeof (item as { sourceKey?: unknown }).sourceKey === 'string'
        ? { sourceKey: (item as { sourceKey: string }).sourceKey }
        : {}),
    }];
  });
  const importSettings = record.importSettings !== null && typeof record.importSettings === 'object'
    ? record.importSettings as Readonly<Record<string, unknown>>
    : undefined;
  const sourceOverrides = record.sourceOverrides !== null
    && typeof record.sourceOverrides === 'object'
    && !Array.isArray(record.sourceOverrides)
    ? record.sourceOverrides as Readonly<Record<string, Readonly<Record<string, unknown>>>>
    : undefined;
  return {
    subAssets,
    ...(importSettings === undefined ? {} : { importSettings }),
    ...(sourceOverrides === undefined ? {} : { sourceOverrides }),
  };
}

function existingFbxCandidatePaths(existing: ExistingImportMeta | undefined): readonly string[] | undefined {
  const candidates = existing?.importSettings?.fbxCandidatePaths;
  return Array.isArray(candidates) && candidates.every((candidate): candidate is string => typeof candidate === 'string')
    ? candidates
    : undefined;
}

type ImportTransactionFailureCode =
  | 'IMPORT_SOURCE_TARGET_CONFLICT'
  | 'IMPORT_UPLOAD_FAILED'
  | 'IMPORT_NETWORK_ERROR'
  | 'IMPORT_SIDECAR_WRITE_FAILED';

interface ImportTransactionFailure {
  readonly code: ImportTransactionFailureCode;
  readonly path: string;
  readonly hint: string;
  readonly retryable: boolean;
}

interface ImportSourceTransaction {
  readonly stagedMetaPath: string;
  readonly writeMeta: (content: string, signal?: AbortSignal) => Promise<AssetIoResult>;
  readonly commit: () => Promise<ImportTransactionFailure | undefined>;
  readonly rollback: () => Promise<void>;
}

function transactionToken(requestId: string | undefined): string {
  const callerToken = (requestId ?? 'import').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return `${callerToken}-${crypto.randomUUID()}`;
}

/**
 * Stage every newly-selected source beside its final target, then promote the
 * complete set with the platform's no-overwrite rename primitive. The source
 * targets and sidecar are therefore either all visible or, on any failure,
 * removed again. Existing files are rejected before the first write.
 */
async function prepareImportSourceTransaction(input: {
  readonly destPath: string;
  readonly base64: string;
  readonly companionSources: readonly { destPath: string; base64: string }[];
  readonly sourceFiles: readonly { destPath: string; relativePath: string; base64: string }[];
  readonly metaPath: string;
  readonly requestId?: string;
  readonly signal?: AbortSignal;
}): Promise<{ readonly ok: true; readonly transaction: ImportSourceTransaction } | { readonly ok: false; readonly failure: ImportTransactionFailure }> {
  const sources = [
    { destPath: input.destPath, base64: input.base64 },
    ...input.companionSources,
    ...input.sourceFiles,
  ];
  const targetPaths = [...sources.map((source) => source.destPath), input.metaPath];
  const uniqueTargets = new Set(targetPaths);
  if (uniqueTargets.size !== targetPaths.length) {
    return {
      ok: false,
      failure: {
        code: 'IMPORT_SOURCE_TARGET_CONFLICT',
        path: input.destPath,
        hint: 'Import source and metadata targets must be unique.',
        retryable: false,
      },
    };
  }

  for (const target of targetPaths) {
    const probe = await assetIO.probeSourceFile(target);
    if (!probe.ok) {
      return {
        ok: false,
        failure: {
          code: probe.error.kind === 'network' ? 'IMPORT_NETWORK_ERROR' : 'IMPORT_UPLOAD_FAILED',
          path: target,
          hint: probe.error.hint,
          retryable: probe.error.kind === 'network',
        },
      };
    }
    if (probe.value) {
      return {
        ok: false,
        failure: {
          code: 'IMPORT_SOURCE_TARGET_CONFLICT',
          path: target,
          hint: `Import target already exists: ${target}`,
          retryable: false,
        },
      };
    }
  }

  const token = transactionToken(input.requestId);
  const stagedSources = sources.map((source) => ({
    finalPath: source.destPath,
    stagedPath: `${source.destPath}.forgeax-importing-${token}`,
    base64: source.base64,
  }));
  const stagedMetaPath = `${input.metaPath}.forgeax-importing-${token}`;
  const promotedSources: string[] = [];
  let metaPromoted = false;

  const cleanup = async (): Promise<void> => {
    const paths = [
      ...stagedSources.map((source) => source.stagedPath),
      stagedMetaPath,
      ...promotedSources,
      ...(metaPromoted ? [input.metaPath] : []),
    ];
    await Promise.all(paths.map(async (path) => { await assetIO.deleteSourceFile(path); }));
  };

  for (const source of stagedSources) {
    const uploaded = await assetIO.uploadSourceBytes(source.stagedPath, source.base64, input.signal);
    if (!uploaded.ok) {
      await cleanup();
      return {
        ok: false,
        failure: {
          code: uploaded.error.kind === 'network' ? 'IMPORT_NETWORK_ERROR' : 'IMPORT_UPLOAD_FAILED',
          path: source.finalPath,
          hint: uploaded.error.hint,
          retryable: uploaded.error.kind === 'network',
        },
      };
    }
  }

  const transaction: ImportSourceTransaction = {
    stagedMetaPath,
    writeMeta: async (content, signal) => {
      return assetIO.writeMetaSidecar(stagedMetaPath, content, signal);
    },
    commit: async () => {
      for (const source of stagedSources) {
        const moved = await assetIO.moveSourceFile(source.stagedPath, source.finalPath);
        if (!moved.ok) {
          await cleanup();
          return {
            code: moved.error.kind === 'network' ? 'IMPORT_NETWORK_ERROR' : 'IMPORT_UPLOAD_FAILED',
            path: source.finalPath,
            hint: moved.error.hint,
            retryable: moved.error.kind === 'network',
          };
        }
        promotedSources.push(source.finalPath);
      }
      const movedMeta = await assetIO.moveSourceFile(stagedMetaPath, input.metaPath);
      if (!movedMeta.ok) {
        await cleanup();
        return {
          code: movedMeta.error.kind === 'network' ? 'IMPORT_NETWORK_ERROR' : 'IMPORT_SIDECAR_WRITE_FAILED',
          path: input.metaPath,
          hint: movedMeta.error.hint,
          retryable: movedMeta.error.kind === 'network',
        };
      }
      metaPromoted = true;
      return undefined;
    },
    rollback: cleanup,
  };
  return { ok: true, transaction };
}

/**
 * THE single asset-import implementation. Every disk write routes through the
 * assetIO write-gate (Invariant 7 / write-gate axis). Returns the terminal result;
 * never throws (errors are captured into { status:'error', error }).
 */
export async function executeAssetImport(spec: AssetImportSpec): Promise<ImportFileResult> {
  const {
    destPath,
    sourceName,
    base64,
    companionSources = [],
    sourceFiles,
    skipUpload,
    requestId,
    mode = 'import',
    onProgress,
    signal,
    onCancellationPolicy,
  } = spec;
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

  const metaPath = format.importer === 'ui'
    ? destPath.replace(/\.ui\.html$/i, '.meta.json')
    : `${destPath}.meta.json`;
  const dependencyFiles = sourceFiles ?? [];
  let sourceTransaction: ImportSourceTransaction | undefined;
  let importCommitted = false;

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
      const prepared = await prepareImportSourceTransaction({
        destPath,
        base64,
        companionSources,
        sourceFiles: dependencyFiles,
        metaPath,
        requestId,
        signal,
      });
      if (!prepared.ok) {
        return failedImport(sourceName, prepared.failure.path, prepared.failure.code, prepared.failure.hint, {
          retryable: prepared.failure.retryable,
        });
      }
      sourceTransaction = prepared.transaction;
    }

    // UI packages keep the sidecar beside the source stem (`hud.meta.json`),
    // while the older external importers use `<source>.meta.json`.
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
        const fbxCandidatePaths = sourceFiles === undefined
          ? existingFbxCandidatePaths(existing)
          : dependencyFiles.map((sourceFile) => sourceFile.relativePath);
        cooked = format.importer === 'gltf'
          ? await cookGltfMeta(bytes, sourceName, existing)
          : await cookFbxMeta(
              bytes,
              sourceName,
              existing,
              fbxCandidatePaths === undefined ? {} : { fbxCandidatePaths },
            );
      } catch (err) {
        if (isCancelled()) return cancelledImport(sourceName, destPath, cancelledHint);
        const hint = err instanceof Error ? err.message : String(err);
        return failedImport(sourceName, destPath, 'IMPORT_COOK_FAILED', hint, { retryable: false });
      }
      if (!cooked.ok || !cooked.metaJson) {
        const cookCode = format.importer === 'fbx' && 'code' in cooked
          ? cooked.code === 'FBX_PARSE_FAILED'
            ? 'IMPORT_FBX_PARSE_FAILED'
            : cooked.code === 'FBX_SOURCE_INVALID'
              ? 'IMPORT_FBX_SOURCE_INVALID'
              : 'IMPORT_COOK_FAILED'
          : 'IMPORT_COOK_FAILED';
        return failedImport(sourceName, destPath, cookCode, cooked.error ?? `${format.importer} cook failed`, { retryable: false });
      }
      if (isCancelled()) return cancelledImport(sourceName, destPath, cancelledHint);
      setCancellationPolicy({
        cancellable: false,
        hint: 'Import is writing the metadata sidecar; cancellation is unavailable until the write completes.',
      });
      onProgress?.({ stage: 'sidecar', fraction: 1 });
      const wrote = sourceTransaction === undefined
        ? await assetIO.writeMetaSidecar(metaPath, cooked.metaJson, signal)
        : await sourceTransaction.writeMeta(cooked.metaJson, signal);
      if (!wrote.ok) {
        return failedImport(
          sourceName,
          destPath,
          wrote.error.kind === 'network' ? 'IMPORT_NETWORK_ERROR' : 'IMPORT_SIDECAR_WRITE_FAILED',
          wrote.error.hint,
          { guid },
        );
      }
      if (sourceTransaction !== undefined) {
        const committed = await sourceTransaction.commit();
        if (committed !== undefined) {
          return failedImport(sourceName, committed.path, committed.code, committed.hint, {
            retryable: committed.retryable,
            guid,
          });
        }
      }
      importCommitted = true;
      return { filename: sourceName, status: 'done', guid, subAssets: subAssetsFromMetaJson(cooked.metaJson) };
    }

    // 3. Other importers (image/audio/font/pack): write a simple sidecar + cook.
    // Font is special: the engine fontImporter expects three sub-assets
    // (texture atlas, sampler, font glyph metrics) declared in the sidecar so
    // it can resolve each by kind. All other importers produce a single
    // sub-asset of their declared kind.
    const subAssets = format.subAssetKinds.map((kind, sourceIndex) => ({
      guid: existing?.subAssets.find((entry) => entry.kind === kind)?.guid
        ?? (sourceIndex === 0 ? guid : generateAssetGuid()),
      sourceIndex,
      kind,
      // Font declares three outputs from one source file; meta.schema requires
      // distinct sourceIndex values and stable sourceKey locators (see dejavu
      // fixture). Reusing sourceIndex 0 for every sub-asset fails scan with
      // pack-malformed-meta / source-index-ambiguous and degrades the catalog.
      ...(format.importer === 'font' ? { sourceKey: `font:${kind}` } : {}),
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
    const wrote = sourceTransaction === undefined
      ? await assetIO.writeMetaSidecar(metaPath, JSON.stringify(meta, null, 2) + '\n', signal)
      : await sourceTransaction.writeMeta(JSON.stringify(meta, null, 2) + '\n', signal);
    if (!wrote.ok) {
      return failedImport(
        sourceName,
        destPath,
        wrote.error.kind === 'network' ? 'IMPORT_NETWORK_ERROR' : 'IMPORT_SIDECAR_WRITE_FAILED',
        wrote.error.hint,
        { guid },
      );
    }

    if (sourceTransaction !== undefined) {
      const committed = await sourceTransaction.commit();
      if (committed !== undefined) {
        return failedImport(sourceName, committed.path, committed.code, committed.hint, {
          retryable: committed.retryable,
          guid,
        });
      }
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
    importCommitted = true;
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
  } finally {
    if (sourceTransaction !== undefined && !importCommitted) await sourceTransaction.rollback();
  }
}

// ── Session appliers: import/reimport (ledger-only, no undo) ─────────────────
// Both operations share this one completion owner. The only semantic difference
// is whether the executor may mint identity (import) or must reuse the existing
// source metadata (reimport).
function registerImportOperation(operationId: 'importAsset' | 'reimportAsset', mode: 'import' | 'reimport'): void {
  registerApplier('session', operationId, (op, ctx) => {
    const { destPath, sourceName, base64, companionSources, sourceFiles, skipUpload, requestId } = op as {
      destPath: string;
      sourceName?: string;
      base64?: string;
      companionSources?: readonly { destPath: string; base64: string }[];
      sourceFiles?: readonly { destPath: string; relativePath: string; base64: string }[];
      skipUpload?: boolean;
      requestId: string;
    };
    if (typeof destPath !== 'string' || destPath.trim() === '') {
      return { ok: false as const, error: { code: 'INVALID_ARGS', hint: `${operationId}.destPath must be a non-empty source path` } };
    }
    if (typeof requestId !== 'string' || requestId.trim() === '') {
      return { ok: false as const, error: { code: 'INVALID_ARGS', hint: `${operationId}.requestId must be a non-empty caller-minted id` } };
    }
    let resolved: string;
    let resolvedCompanions: readonly { destPath: string; base64: string }[] | undefined;
    let resolvedSourceFiles: readonly { destPath: string; relativePath: string; base64: string }[] | undefined;
    try {
      const destination = validateImportDestinationPath(destPath);
      if (!destination.ok) throw new Error(`${operationId}.destPath: ${destination.hint}`);
      const destinationTargets = new Set<string>();
      resolved = resolveGamePath(destPath);
      destinationTargets.add(resolved);
      if (companionSources !== undefined) {
        if (companionSources.length > 1) {
          return { ok: false as const, error: { code: 'INVALID_ARGS', hint: `${operationId}.companionSources accepts at most one bounded companion` } };
        }
        resolvedCompanions = companionSources.map((companion) => {
          if (typeof companion.destPath !== 'string' || companion.destPath.trim() === '' || typeof companion.base64 !== 'string' || companion.base64 === '') {
            throw new Error(`${operationId}.companionSources requires non-empty destPath and base64`);
          }
          const companionDestination = validateImportDestinationPath(companion.destPath);
          if (!companionDestination.ok) throw new Error(`${operationId}.companionSources.destPath: ${companionDestination.hint}`);
          const resolvedDestPath = resolveGamePath(companion.destPath);
          if (destinationTargets.has(resolvedDestPath)) {
            throw new Error(`${operationId}.companionSources contains a destination collision with the root or another source`);
          }
          destinationTargets.add(resolvedDestPath);
          return { destPath: resolvedDestPath, base64: companion.base64 };
        });
      }
      if (sourceFiles !== undefined) {
        const seenRelativePaths = new Set<string>();
        resolvedSourceFiles = sourceFiles.map((sourceFile) => {
          if (
            typeof sourceFile.destPath !== 'string'
            || sourceFile.destPath.trim() === ''
            || typeof sourceFile.relativePath !== 'string'
            || sourceFile.relativePath.trim() === ''
            || typeof sourceFile.base64 !== 'string'
            || sourceFile.base64 === ''
          ) {
            throw new Error(`${operationId}.sourceFiles requires relativePath, destPath, and base64`);
          }
          const sourceDestination = validateImportDestinationPath(sourceFile.destPath);
          if (!sourceDestination.ok) throw new Error(`${operationId}.sourceFiles.destPath: ${sourceDestination.hint}`);
          const sourceRelative = validateImportSourceRelativePath(sourceFile.relativePath);
          if (!sourceRelative.ok) throw new Error(`${operationId}.sourceFiles.relativePath: ${sourceRelative.hint}`);
          const resolvedDestPath = resolveGamePath(sourceFile.destPath);
          if (destinationTargets.has(resolvedDestPath)) {
            throw new Error(`${operationId}.sourceFiles contains a destination collision with the root, companion, or another source`);
          }
          destinationTargets.add(resolvedDestPath);
          const normalizedRelativePath = sourceRelative.name;
          if (seenRelativePaths.has(normalizedRelativePath.toLowerCase())) {
            throw new Error(`${operationId}.sourceFiles contains a duplicate FBX relative dependency path`);
          }
          seenRelativePaths.add(normalizedRelativePath.toLowerCase());
          return {
            destPath: resolvedDestPath,
            relativePath: normalizedRelativePath,
            base64: sourceFile.base64,
          };
        });
      }
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
      base64,
      companionSources: resolvedCompanions,
      sourceFiles: resolvedSourceFiles,
      requestId,
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
          // Source-package imports (glTF/FBX) land as disk sidecars first. Their
          // sub-assets materialize lazily through the engine import transport,
          // so waiting for every pack-index row here races the watcher and marks
          // a successful import as failed while the files are already on disk.
          if (isSourcePackageImport(name)) {
            broadcastAssetsChanged('directory-only', 'local-op');
            return { ok: true as const, result };
          }

          // Cooked importers (image/font/…) must observe every produced GUID in
          // the served catalog before the run claims terminal success.
          const producedGuids = result.subAssets?.map((subAsset) => subAsset.guid) ?? [];
          const catalogGuids = Array.from(new Set(
            producedGuids.length > 0
              ? producedGuids
              : result.guid !== undefined
                ? [result.guid]
                : [],
          ));
          try {
            await Promise.all(catalogGuids.map((catalogGuid) => awaitPostAssetWriteCatalogSync(catalogGuid)));
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
// Canonical GUID/source-scope reimport is descriptor-only in M2. Its producer
// coordinator is introduced by the next milestone; keep dispatch fail-closed
// instead of retaining the old path-addressed writer.

// Re-export so consumers passing an EditorOp keep the union import shape.
export type { EditorOp };
