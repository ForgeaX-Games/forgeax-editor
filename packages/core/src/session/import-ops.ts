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
//     derived artefacts and references). Fire-and-forget like createDirectory.
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
import { generateAssetGuid } from './pack-ops';
import { sessionAppliers } from '../io/appliers';
import { broadcastAssetsChanged } from '../store/assets-changed';
import { resolveGamePath } from '../util/path-resolver';
import type { EditorOp } from '../types';

/** Terminal status of a single-file import (shared with the content-browser UI). */
export type ImportFileStatus = 'pending' | 'uploading' | 'sidecar' | 'cooking' | 'done' | 'error';

/** Result of importing one file — the shape the CB overlay + startup scan consume. */
export interface ImportFileResult {
  filename: string;
  status: ImportFileStatus;
  error?: string;
  guid?: string;
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
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * THE single asset-import implementation. Every disk write routes through the
 * assetIO write-gate (Invariant 7 / write-gate axis). Returns the terminal result;
 * never throws (errors are captured into { status:'error', error }).
 */
export async function executeAssetImport(spec: AssetImportSpec): Promise<ImportFileResult> {
  const { destPath, sourceName, base64, skipUpload } = spec;
  const ext = sourceName.slice(sourceName.lastIndexOf('.')).toLowerCase();
  const format = getImportFormat(ext);

  console.info('[import-diag] executeAssetImport START', { destPath, sourceName, ext, importer: format?.importer, skipUpload, hasBase64: base64 !== undefined });

  if (!format) {
    console.warn('[import-diag] unsupported format', { ext, sourceName });
    return { filename: sourceName, status: 'error', error: `Unsupported format: ${ext}` };
  }

  const guid = generateAssetGuid();
  console.info('[import-diag] generated guid', { guid, sourceName });

  try {
    // 1. Upload bytes (human drag-drop path) unless they are already on disk.
    if (!skipUpload) {
      if (base64 === undefined) {
        console.warn('[import-diag] no base64 bytes for upload', { sourceName });
        return { filename: sourceName, status: 'error', error: 'No source bytes to upload' };
      }
      const uploaded = await assetIO.uploadSourceBytes(destPath, base64);
      if (!uploaded) {
        return { filename: sourceName, status: 'error', error: 'Upload failed' };
      }
    }

    const metaPath = `${destPath}.meta.json`;
    console.info('[import-diag] metaPath computed', { metaPath, destPath });

    // 2. glTF / FBX are cooked into a canonical meta.json on the frontend (engine
    //    SSOT) — the bytes come from `base64` if provided, else read back from disk.
    if (format.importer === 'gltf' || format.importer === 'fbx') {
      console.info('[import-diag] reading source bytes for cook', { destPath, hasBase64: base64 !== undefined });
      const bytes = base64 !== undefined
        ? base64ToArrayBuffer(base64)
        : await assetIO.readSourceBytes(destPath);
      if (!bytes) {
        console.error('[import-diag] no bytes for cook — readSourceBytes returned null', { destPath });
        return { filename: sourceName, status: 'error', error: 'Could not read source bytes for cook' };
      }
      console.info('[import-diag] got bytes, starting cook', { sourceName, byteLength: bytes.byteLength, importer: format.importer });
      const existing = await assetIO.readExistingMeta(metaPath);
      const cooked = format.importer === 'gltf'
        ? await cookGltfMeta(bytes, sourceName, existing)
        : await cookFbxMeta(bytes, sourceName, existing);
      console.info('[import-diag] cook result', { sourceName, ok: cooked.ok, error: cooked.error, hasMetaJson: !!cooked.metaJson });
      if (!cooked.ok || !cooked.metaJson) {
        return { filename: sourceName, status: 'error', error: cooked.error ?? `${format.importer} cook failed` };
      }
      console.info('[import-diag] writing sidecar', { metaPath, metaJsonLen: cooked.metaJson.length });
      const wrote = await assetIO.writeMetaSidecar(metaPath, cooked.metaJson);
      console.info('[import-diag] sidecar write result', { metaPath, wrote });
      return wrote
        ? { filename: sourceName, status: 'done', guid }
        : { filename: sourceName, status: 'error', error: 'Failed to write .meta.json sidecar' };
    }

    // 3. Other importers (image/audio/font/pack): write a simple sidecar + cook.
    const meta = {
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: format.importer,
      source: sourceName,
      importSettings: { ...format.defaultSettings },
      subAssets: [{ guid, sourceIndex: 0, kind: format.subAssetKind }],
    };
    console.info('[import-diag] writing generic sidecar', { metaPath, importer: format.importer });
    const wrote = await assetIO.writeMetaSidecar(metaPath, JSON.stringify(meta, null, 2) + '\n');
    if (!wrote) {
      return { filename: sourceName, status: 'error', error: 'Failed to create .meta.json sidecar' };
    }

    console.info('[import-diag] triggering cook', { guid, sourceName });
    const cookError = await assetIO.triggerCook(guid);
    console.info('[import-diag] cook trigger result', { guid, sourceName, cookError });
    return {
      filename: sourceName,
      status: cookError ? 'error' : 'done',
      guid,
      error: cookError,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[import-diag] executeAssetImport THREW', { sourceName, destPath, error: msg });
    return { filename: sourceName, status: 'error', error: msg };
  }
}

// ── Session applier: importAsset (ledger-only, no undo) ───────────────────────
// Registered into sessionAppliers (D-1) so gateway.dispatch routes it as a session
// op — human UI, AI, and any other caller are equal peers of the one door. Mirrors
// createDirectory's fire-and-forget shape: the applier returns synchronously while
// executeAssetImport completes in a detached promise (the async session-op contract,
// trace.ts F-2). broadcastAssetsChanged() on completion refreshes the catalog.
//
// The op carries { destPath, sourceName, skipUpload? } — the source is expected to
// be on disk already (human path uploaded it through the assetIO gate before
// dispatching; AI passes an on-disk path). destPath may be game-relative; we resolve
// it through resolveGamePath so AI callers can pass "assets/foo.glb".
sessionAppliers.set('importAsset', (op) => {
  const { destPath, sourceName, skipUpload } = op as {
    destPath: string; sourceName?: string; skipUpload?: boolean;
  };
  const resolved = resolveGamePath(destPath);
  const name = sourceName ?? destPath.slice(destPath.lastIndexOf('/') + 1);
  console.info('[import-diag] applier importAsset', { destPath, resolved, sourceName: name, skipUpload });
  void executeAssetImport({ destPath: resolved, sourceName: name, skipUpload: skipUpload ?? true })
    .then((result) => {
      console.info('[import-diag] applier importAsset DONE', { sourceName: name, result });
      broadcastAssetsChanged();
    })
    .catch((e) => console.warn('[editor-core] importAsset IO failed:', e));
  return { ok: true };
});

// Re-export so consumers passing an EditorOp keep the union import shape.
export type { EditorOp };
