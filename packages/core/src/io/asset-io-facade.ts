// io/asset-io-facade — the sole controlled proxy for asset/pack IO.
//
// north-star §2 write-gate axis symmetry: ctx.engine covers ECS World mutation,
// ctx.assetIO covers asset/pack mutation — the SECOND authoritative authored-state
// surface (pack files on disk, reached through the server's /api/files). Every
// asset/pack write outside this file is a lint-unique-mutator violation (G-5 /
// AC-D1). Each write method records its asset-interface name onto the active span
// (AC-D4), symmetric to EngineFacade's engine leaf recording.
//
// Anchors:
//   plan-strategy §2 D-6: facade is the gate — lint-unique-mutator's allowed file
//   requirements AC-05: writes go through ctx.assetIO (trace only)
//   feat (keyboard-router convergence) M2 T2-1: AssetIOFacade encapsulates the
//     pack-ops low-level primitives readPack / writePack / deleteAsset.
import { normalizePackForRuntime, type PackFile } from '../scene/scene-pack';
import {
  readPack, writePack, deleteAsset, generateAssetGuid,
  readPackDetailed, writePackDetailed,
  readMetaSubAsset, writeMetaSubAsset, renameMetaSubAsset, type MetaSubAsset,
  parseMetaDocument, serializeMetaDocument, mutateMetaSourceOverrides,
  type MetaSourceScope,
} from './asset-io-primitives';
import { recordAssetLeaf } from './trace';
import type { CommandError } from '../types';
import { deletedEntryCache as rawDeletedEntryCache } from './asset-op-caches';

/** Mirror of the `/api/files/tree` response node (same shape as assets.ts TreeNode). */
interface TreeNode { name: string; path: string; type: 'dir' | 'file'; children?: TreeNode[] }

/** A single asset entry inside a pack file (derived from the zod PackFile shape). */
export type PackAssetEntry = PackFile['assets'][number];

/** A CRUD-target entry: either an internal `.pack.json` asset (`assets[]`) or an
 *  external `.meta.json` sub-asset (`subAssets[]`). The facade dispatches on the
 *  path suffix; the snapshot cache holds whichever the delete produced. */
export type AssetEntry = PackAssetEntry | MetaSubAsset;

export interface UpsertAssetResult {
  readonly ok: boolean;
  readonly previous: PackAssetEntry | null;
}

export type SourceFileDeleteResult =
  | { ok: true }
  | { ok: false; error: CommandError };

export type SourceFileAbsenceResult =
  | { ok: true; absent: boolean }
  | { ok: false; error: CommandError };

export interface AssetIoError {
  readonly kind: 'http' | 'network';
  readonly hint: string;
  readonly status?: number;
}

export type AssetIoResult<T = void> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AssetIoError };

export type CreateAuthoredPackResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'collision' | 'write-failed'; readonly hint: string };

/** Diagnosable result for createAssetInPack. `read-failed` means the target
 *  pack EXISTS on disk but could not be read/validated — the write was REFUSED
 *  because creating a fresh envelope would clobber the existing scene/material
 *  bodies (the "material written but pack lost" gray-card root cause). */
export type CreateAssetInPackResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'read-failed' | 'write-failed'; readonly hint: string };

export const SOURCE_SIDECAR_REVISION_DOMAIN = 'source-sidecar-file-v1';

export interface AssetResourceRef {
  readonly kind: 'source-sidecar';
  readonly path: string;
}

export interface AssetResourceSnapshot {
  readonly contents: string;
  readonly revision: string;
}

export interface AssetResourceTransactionPort<TInput = unknown> {
  /**
   * Explicit revision-domain contract. A port is eligible for source-sidecar
   * CAS only when the baseline snapshot and commit belong to this same domain.
   */
  readonly supportsExpectedRevision: true;
  readonly revisionDomain: typeof SOURCE_SIDECAR_REVISION_DOMAIN;
  readonly readResource: (resource: AssetResourceRef) => Promise<AssetResourceSnapshot>;
  readonly prepare: (input: TInput) => Promise<{
    readonly commit: () => Promise<{ readonly revision: string; readonly result?: unknown }>;
    readonly rollback?: () => Promise<void>;
  }>;
}

export interface SourceOverrideCommitInput {
  readonly metaPath: string;
  readonly expectedRevision: string;
  readonly scope: MetaSourceScope;
  readonly override?: unknown;
  readonly discard?: boolean;
}

export interface SourceOverrideCommitResult {
  readonly revision: string;
  readonly contents: string;
  readonly document: Record<string, unknown>;
}

export class AssetResourceConflictError extends Error {
  readonly code = 'asset-resource-conflict';

  constructor(
    readonly expectedRevision: string,
    readonly currentRevision: string | null,
  ) {
    super(`resource revision mismatch (expected ${expectedRevision}, current ${currentRevision ?? 'missing'})`);
    this.name = 'AssetResourceConflictError';
  }
}

function isSourceSidecarPort(port: AssetResourceTransactionPort | undefined): port is AssetResourceTransactionPort {
  return port?.supportsExpectedRevision === true
    && port.revisionDomain === SOURCE_SIDECAR_REVISION_DOMAIN
    && typeof port.readResource === 'function';
}

interface SourceSidecarPutInput {
  readonly resource: AssetResourceRef;
  readonly expectedRevision: string;
  readonly content: string;
  readonly changes?: readonly [{
    readonly kind: 'put';
    readonly path: string;
    readonly content: string;
  }];
}

function isSourceSidecarPutInput(input: unknown): input is SourceSidecarPutInput {
  const candidate = input as Partial<SourceSidecarPutInput> | null;
  return candidate?.resource?.kind === 'source-sidecar'
    && typeof candidate.resource.path === 'string'
    && typeof candidate.expectedRevision === 'string'
    && typeof candidate.content === 'string';
}

const isMetaPath = (packPath: string): boolean => packPath.endsWith('.meta.json');

/**
 * Snapshot of deleted asset entries, keyed by `${packPath}#${guid}`, captured
 * BEFORE the async delete completes so the document-op inverse (`restoreAsset`)
 * can synchronously restore the full entry on undo (OOS-5 single-asset undo).
 * The gateway's document-applier contract is synchronous, so we cannot await the
 * read inside the applier — instead the entry is stashed here and read back by the
 * inverse op. Entries are evicted once restoreAsset consumes them.
 */
export const deletedEntryCache = rawDeletedEntryCache as Map<string, AssetEntry>;

/**
 * Snapshot of the PRE-rename name, keyed by `${packPath}#${guid}`, captured in the
 * `renameAsset` document applier's fire-and-forget `.then` (renamePackEntry returns
 * the replaced name). Symmetric to `deletedEntryCache`: the document-applier
 * contract is synchronous, so the applier cannot await the read to learn the old
 * name — it stashes the old name here and the inverse `renameAsset` (carrying the
 * same cacheKey) resolves its target name from this map. Chosen over an op-carried
 * `oldName` for AI-parity: an AI caller dispatching `renameAsset` need not (and may
 * not) know the current name — the applier discovers it (SSOT: the pack on disk).
 */

/**
 * Snapshot of the guid a `duplicateAsset` produced, keyed by the SOURCE
 * `${packPath}#${guid}`, captured in the applier's fire-and-forget `.then`
 * (cloneAssetInPack allocates the new guid INSIDE the gate — see line ~105, so it
 * is unknowable synchronously). The inverse `destroyAsset` carries a
 * `newGuidCacheKey` referencing this map; `applyDestroyAsset` resolves the real
 * guid from here at undo time. This is the "async-guid wrinkle" the duplicate op
 * has to route around — the same fire-and-forget cache contract destroyAsset /
 * restoreAsset already rely on for their snapshots.
 */

/**
 * The sole legal path for asset/pack writes outside of document appliers
 * (gateway A for the asset axis, plan-strategy §2 D-6). `destroyAsset` /
 * `restoreAsset` document appliers call `deletePackEntry` / `writePackEntry`
 * through `ctx.assetIO` — the asset axis mirror of `ctx.engine.despawn`.
 *
 * Each method mirrors the matching pack-ops primitive signature so callers keep a
 * same-name same-shape surface (plan-strategy §4 AC-06).
 */
export class AssetIOFacade {
  private resourceTransaction: AssetResourceTransactionPort | undefined;
  /** Per-path serialization chains for read-modify-write pack operations.
   *  Every RMW method (createAssetInPack / writePackEntry / renamePackEntry /
   *  cloneAssetInPack / deletePackEntry) runs its read+mutate+write INSIDE the
   *  chain for its pack path, so two concurrent ops on the same pack can never
   *  interleave into a lost update (read stale → both write → last writer
   *  clobbers the first's asset). Keyed by the exact packPath string. */
  private packWriteChains = new Map<string, Promise<void>>();

  /** Run `fn` serialized against every other pack write on `packPath` routed
   *  through this gate. The scene-save commit path also enters through
   *  runExclusivePackWrite so a save cannot interleave with a createMaterial
   *  read-modify-write on the same scene pack. */
  runExclusivePackWrite<T>(packPath: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.packWriteChains.get(packPath) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Chain tail never rejects, so one failed write cannot wedge later writers.
    const tail = next.then(() => undefined, () => undefined);
    this.packWriteChains.set(packPath, tail);
    void tail.then(() => {
      if (this.packWriteChains.get(packPath) === tail) this.packWriteChains.delete(packPath);
    });
    return next;
  }

  /** Install the public resource port supplied by platform-io. */
  setResourceTransactionPort(port: AssetResourceTransactionPort | undefined): void {
    this.resourceTransaction = port;
  }

  hasResourceTransactionPort(): boolean {
    return this.resourceTransaction !== undefined;
  }

  async prepareResourceTransaction(input: unknown): Promise<Awaited<ReturnType<AssetResourceTransactionPort['prepare']>> | null> {
    if (this.resourceTransaction === undefined) return null;
    return this.resourceTransaction.prepare(input);
  }

  async prepareRevisionAwareResourceTransaction(
    input: unknown,
  ): Promise<Awaited<ReturnType<AssetResourceTransactionPort['prepare']>> | null> {
    if (this.resourceTransaction !== undefined) {
      if (!isSourceSidecarPort(this.resourceTransaction)) return null;
      return this.resourceTransaction.prepare(input);
    }
    if (!isSourceSidecarPutInput(input)) return null;
    // Prepare is deliberately side-effect free. The file router owns the only
    // disk write and performs compare + replace under its per-path serializer.
    const prepared = { ...input, resource: { ...input.resource } };
    return {
      commit: async () => {
        const response = await fetch('/api/files', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            path: prepared.resource.path,
            content: prepared.content,
            expectedRevision: prepared.expectedRevision,
          }),
        });
        if (response.status === 409) {
          const body = await response.json().catch(() => ({})) as { currentRevision?: unknown };
          throw new AssetResourceConflictError(
            prepared.expectedRevision,
            typeof body.currentRevision === 'string' ? body.currentRevision : null,
          );
        }
        if (!response.ok) throw new Error(`sidecar CAS failed (HTTP ${response.status})`);
        const body = await response.json() as { revision?: unknown };
        if (typeof body.revision !== 'string' || body.revision.length === 0) {
          throw new Error('sidecar CAS response did not include a revision');
        }
        return { revision: body.revision, result: body };
      },
    };
  }

  /**
   * Compare-and-swap only the sourceOverrides field. The read is used to retain
   * all producer-owned Meta fields; the resource port remains the sole commit
   * boundary and arbitrates concurrent writers on the expected revision.
   */
  async commitSourceOverrides(input: SourceOverrideCommitInput): Promise<SourceOverrideCommitResult> {
    recordAssetLeaf('assetIO.writeMetaSidecar');
    const snapshot = await this.readMetaSidecar(input.metaPath);
    if (!snapshot.ok) throw new Error(snapshot.error.hint);
    if (snapshot.value.revision !== input.expectedRevision) {
      throw new AssetResourceConflictError(input.expectedRevision, snapshot.value.revision);
    }
    const document = mutateMetaSourceOverrides(
      parseMetaDocument(snapshot.value.contents),
      { scope: input.scope, override: input.override, discard: input.discard },
    );
    const contents = serializeMetaDocument(document);
    const prepared = await this.prepareRevisionAwareResourceTransaction({
      resource: { kind: 'source-sidecar', path: input.metaPath },
      expectedRevision: input.expectedRevision,
      content: contents,
      changes: [{ kind: 'put', path: input.metaPath, content: contents }],
    });
    if (prepared === null) throw new Error('source-sidecar CAS is unavailable');
    const committed = await prepared.commit();
    return { revision: committed.revision, contents, document };
  }

  /** Delete exactly one resolved source file. This is separate from pack-entry
   * deletion and intentionally does not infer or cascade to sidecars/DDC. */
  async deleteSourceFile(resolvedPath: string): Promise<SourceFileDeleteResult> {
    recordAssetLeaf('assetIO.deleteSourceFile');
    try {
      const response = await fetch(`/api/files?path=${encodeURIComponent(resolvedPath)}`, {
        method: 'DELETE',
      });
      if (response.ok) return { ok: true };
      return {
        ok: false,
        error: {
          code: 'SOURCE_FILE_DELETE_FAILED',
          hint: `source file delete failed for ${resolvedPath} (HTTP ${response.status})`,
          retryable: true,
          recoveryActions: ['operation.retry'],
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'SOURCE_FILE_DELETE_FAILED',
          hint: `source file delete failed for ${resolvedPath}: ${(err as Error)?.message ?? String(err)}`,
          retryable: true,
          recoveryActions: ['operation.retry'],
        },
      };
    }
  }

  /** Read one complete pack through the asset gate's read side. Scene lifecycle
   * guards use this to inspect the producer-owned refs[] before deleting a pack. */
  async readPack(packPath: string): Promise<PackFile | null> {
    recordAssetLeaf('assetIO.readPack');
    return readPack(packPath);
  }

  /** Verify a file really disappeared after a successful DELETE response. */
  async verifySourceFileAbsent(resolvedPath: string): Promise<SourceFileAbsenceResult> {
    recordAssetLeaf('assetIO.verifySourceFileAbsent');
    try {
      const response = await fetch(`/api/files?path=${encodeURIComponent(resolvedPath)}`, {
        cache: 'no-store',
      });
      if (response.status === 404) return { ok: true, absent: true };
      if (!response.ok) {
        return {
          ok: false,
          error: {
            code: 'SOURCE_FILE_VERIFY_FAILED',
            hint: `source file absence check failed for ${resolvedPath} (HTTP ${response.status})`,
            retryable: true,
            recoveryActions: ['operation.retry'],
          },
        };
      }
      return { ok: true, absent: false };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'SOURCE_FILE_VERIFY_FAILED',
          hint: `source file absence check failed for ${resolvedPath}: ${(err as Error)?.message ?? String(err)}`,
          retryable: true,
          recoveryActions: ['operation.retry'],
        },
      };
    }
  }

  /** Read one asset entry (null if pack/sidecar or entry missing). Dispatches on
   *  the path suffix: `.meta.json` → external sub-asset, else `.pack.json`. */
  async readPackEntry(packPath: string, guid: string): Promise<AssetEntry | null> {
    recordAssetLeaf('assetIO.readPackEntry');
    if (isMetaPath(packPath)) return readMetaSubAsset(packPath, guid);
    const pack = await readPack(packPath);
    if (!pack) return null;
    return pack.assets.find((a) => a.guid === guid) ?? null;
  }

  /** Delete one asset entry, returning the SNAPSHOT of the deleted entry so the
   *  op's inverse can restore it (OOS-5 single-asset undo). Throws if the entry
   *  could not be read or the delete failed. `deleteAsset` already routes
   *  `.meta.json` targets to the sidecar-aware path. */
  async deletePackEntry(packPath: string, guid: string): Promise<AssetEntry> {
    recordAssetLeaf('assetIO.deletePackEntry');
    return this.runExclusivePackWrite(packPath, async () => {
      const entry = await this.readPackEntry(packPath, guid);
      if (!entry) throw new Error(`[editor-core] assetIO.deletePackEntry: entry ${guid} not found in ${packPath}`);
      const ok = await deleteAsset(packPath, guid);
      if (!ok) throw new Error(`[editor-core] assetIO.deletePackEntry: failed to delete ${guid} from ${packPath}`);
      return entry;
    });
  }

  /** Write (create or replace) one asset entry. Returns true on success.
   *  Dispatches on the path suffix like readPackEntry. */
  async writePackEntry(packPath: string, entry: AssetEntry): Promise<boolean> {
    recordAssetLeaf('assetIO.writePackEntry');
    if (isMetaPath(packPath)) return writeMetaSubAsset(packPath, entry as MetaSubAsset);
    return this.runExclusivePackWrite(packPath, async () => {
      const pack = await readPack(packPath);
      if (!pack) return false;
      const packEntry = entry as PackAssetEntry;
      const idx = pack.assets.findIndex((a) => a.guid === packEntry.guid);
      if (idx >= 0) pack.assets[idx] = packEntry;
      else pack.assets.push(packEntry);
      return writePack(packPath, pack);
    });
  }

  /** Create a new asset entry in a pack (creates the pack file if missing).
   *  Single gate for `createAsset`/`createMaterial` document ops — all other
   *  callers are lint-gated.
   *
   *  Failure discipline (material-persistence fix): the result is DIAGNOSABLE.
   *  `read-failed` refuses the write when the pack exists but is unreadable or
   *  fails shell validation — the legacy `readPack → null → fresh envelope`
   *  collapse would otherwise overwrite a valid scene pack with one containing
   *  ONLY the new asset, silently dropping every existing scene/material/refs
   *  body. `write-failed` reports the exact write rejection (validation/HTTP/
   *  network). Only `ok:true` may be treated as "the asset is on disk". */
  createAssetInPack(opts: {
    packPath: string;
    asset: { guid: string; kind: string; name: string; payload: unknown; refs?: string[] };
  }): Promise<CreateAssetInPackResult> {
    recordAssetLeaf('assetIO.createAssetInPack');
    return this.runExclusivePackWrite(opts.packPath, async () => {
      const read = await readPackDetailed(opts.packPath);
      let pack: PackFile;
      if (read.status === 'error') {
        return {
          ok: false as const,
          reason: 'read-failed' as const,
          hint: `refusing to overwrite existing pack ${opts.packPath}: ${read.hint}`,
        };
      }
      if (read.status === 'missing') {
        // Create the pack file on first asset.
        // The engine runtime's loadByGuid boundary accepts Pack v2 only. The
        // editor's read validator intentionally keeps accepting legacy string
        // versions, but every authored write must emit the runtime envelope.
        pack = { schemaVersion: '2.0.0', kind: 'internal-text-package', assets: [] };
      } else {
        pack = read.pack;
      }
      if (pack.assets.some((entry) => entry.guid.toLowerCase() === opts.asset.guid.toLowerCase())) {
        return {
          ok: false as const,
          reason: 'write-failed' as const,
          hint: `asset ${opts.asset.guid} already exists in ${opts.packPath}`,
        };
      }
      pack.assets.push({
        guid: opts.asset.guid,
        kind: opts.asset.kind,
        name: opts.asset.name,
        payload: opts.asset.payload as Record<string, unknown>,
        refs: opts.asset.refs ?? [],
      });
      // Upgrade legacy editor-created packs and add the asset-local artifact
      // map required by the Pack v2 loader. normalizePackForRuntime preserves
      // unknown fields, so this remains a lossless repair at the shared write
      // gate for both human UI and AI dispatches.
      pack = normalizePackForRuntime(pack as unknown as Record<string, unknown>) as PackFile;
      const written = await writePackDetailed(opts.packPath, pack);
      return written.ok
        ? { ok: true as const }
        : { ok: false as const, reason: 'write-failed' as const, hint: written.hint };
    });
  }

  /** Create or replace one authored pack asset by stable GUID. The pack on disk
   *  is the SSOT for deciding which arm applies; live catalog state may be cold. */
  async upsertAssetInPack(opts: {
    packPath: string;
    asset: { guid: string; kind: string; name: string; payload: unknown; refs?: string[] };
  }): Promise<UpsertAssetResult> {
    recordAssetLeaf('assetIO.createAssetInPack');
    let pack = await readPack(opts.packPath);
    if (!pack) pack = { schemaVersion: '2.0.0', kind: 'internal-text-package', assets: [] };
    const index = pack.assets.findIndex(
      (entry) => entry.guid.toLowerCase() === opts.asset.guid.toLowerCase(),
    );
    const previous = index < 0 ? null : structuredClone(pack.assets[index]!);
    const next = {
      guid: opts.asset.guid,
      kind: opts.asset.kind,
      name: opts.asset.name,
      payload: opts.asset.payload as Record<string, unknown>,
      refs: opts.asset.refs ?? [],
    };
    if (index < 0) pack.assets.push(next);
    else pack.assets[index] = next;
    pack = normalizePackForRuntime(pack as unknown as Record<string, unknown>) as PackFile;
    return { ok: await writePack(opts.packPath, pack), previous };
  }

  /**
   * Create one authored pack without reading or modifying imported source,
   * metadata, or DDC. The existence probe is read-only; success performs exactly
   * one candidate write through the asset gate.
   */
  async createAuthoredPackIfAbsent(packPath: string, content: string): Promise<CreateAuthoredPackResult> {
    recordAssetLeaf('assetIO.writePackEntry');
    return this.runExclusivePackWrite(packPath, async () => {
      try {
        const existing = await fetch(`/api/files/raw?path=${encodeURIComponent(packPath)}`);
        if (existing.ok) {
          return { ok: false, reason: 'collision', hint: `An authored resource already exists at ${packPath}.` };
        }
        if (existing.status !== 404) {
          return { ok: false, reason: 'write-failed', hint: `Could not validate target availability (HTTP ${existing.status}).` };
        }
        const written = await fetch('/api/files', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: packPath, content }),
        });
        return written.ok
          ? { ok: true }
          : { ok: false, reason: 'write-failed', hint: `Authored pack write failed (HTTP ${written.status}).` };
      } catch (cause) {
        return {
          ok: false,
          reason: 'write-failed',
          hint: `Authored pack write failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
      }
    });
  }

  /** Rename one asset entry (change its `name` field), returning the REPLACED
   *  (old) name so the `renameAsset` document op's inverse can restore it (the
   *  asset-axis mirror of deletePackEntry returning the deleted snapshot). The
   *  WRITE goes through this gate (writePack) — the sole legal pack-write path
   *  (G-5 / AC-D1), replacing the pre-gateway bare `renameAssetInPack`. Returns
   *  `ok:false` (with `oldName:null`) if the pack/entry is missing or the write
   *  fails — the applier leaves the inverse cache untouched in that case. */
  async renamePackEntry(
    packPath: string,
    guid: string,
    newName: string,
  ): Promise<{ ok: boolean; oldName: string | null }> {
    recordAssetLeaf('assetIO.renamePackEntry');
    if (isMetaPath(packPath)) return renameMetaSubAsset(packPath, guid, newName);
    return this.runExclusivePackWrite(packPath, async () => {
      const pack = await readPack(packPath);
      if (!pack) return { ok: false, oldName: null };
      const entry = pack.assets.find((a) => a.guid === guid);
      if (!entry) return { ok: false, oldName: null };
      const oldName = entry.name ?? null;
      entry.name = newName;
      const ok = await writePack(packPath, pack);
      return { ok, oldName };
    });
  }

  // ── Import write-gate (source-file / cook axis) ─────────────────────────────
  // The import pipeline used to make three raw `fetch` calls straight from
  // content-browser (upload binary, write .meta.json, trigger cook), bypassing the
  // one-door gateway entirely (no `import` op existed). These four methods pull
  // those writes INSIDE the asset gate so the `importAsset` op (session domain) and
  // the startup-scan bootstrap path share a single controlled surface — symmetric
  // to how create/rename/duplicate route their pack writes here. `readSourceBytes`
  // is the read side used by the executor when there is no in-memory File (AI /
  // startup-scan callers whose source already lives on disk).

  /** Upload raw source bytes (base64) to disk at destPath. `POST /api/files/upload`. */
  async uploadSourceBytes(destPath: string, base64: string, signal?: AbortSignal): Promise<AssetIoResult> {
    recordAssetLeaf('assetIO.uploadSourceBytes');
    console.info('[import-diag] uploadSourceBytes', { destPath, base64Len: base64.length });
    try {
      const r = await fetch('/api/files/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: destPath, data: base64 }),
        signal,
      });
      console.info('[import-diag] uploadSourceBytes response', { status: r.status, ok: r.ok });
      return r.ok
        ? { ok: true, value: undefined }
        : { ok: false, error: { kind: 'http', status: r.status, hint: `source upload failed (HTTP ${r.status})` } };
    } catch (err) {
      console.error('[import-diag] uploadSourceBytes THREW', err);
      return { ok: false, error: { kind: 'network', hint: `source upload network error: ${(err as Error)?.message ?? String(err)}` } };
    }
  }

  /** Write a pre-built `.meta.json` sidecar (text content) to disk. `POST /api/files`. */
  async writeMetaSidecar(metaPath: string, content: string, signal?: AbortSignal): Promise<AssetIoResult> {
    recordAssetLeaf('assetIO.writeMetaSidecar');
    console.info('[import-diag] writeMetaSidecar', { metaPath, contentLen: content.length });
    try {
      const r = await fetch('/api/files', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: metaPath, content }),
        signal,
      });
      console.info('[import-diag] writeMetaSidecar response', { metaPath, status: r.status, ok: r.ok });
      return r.ok
        ? { ok: true, value: undefined }
        : { ok: false, error: { kind: 'http', status: r.status, hint: `sidecar write failed (HTTP ${r.status})` } };
    } catch (err) {
      console.error('[import-diag] writeMetaSidecar THREW', { metaPath }, err);
      return { ok: false, error: { kind: 'network', hint: `sidecar write network error: ${(err as Error)?.message ?? String(err)}` } };
    }
  }

  /** Best-effort cook trigger for a freshly-written sidecar. `POST /__import/:guid`.
   *  Returns a structured success/failure result so the executor preserves the
   *  first decisive boundary instead of collapsing it into a generic error. */
  async triggerCook(guid: string, signal?: AbortSignal): Promise<AssetIoResult> {
    recordAssetLeaf('assetIO.triggerCook');
    console.info('[import-diag] triggerCook', { guid });
    try {
      const res = await fetch(`/__import/${guid}`, { method: 'POST', signal });
      console.info('[import-diag] triggerCook response', { guid, status: res.status, ok: res.ok });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string; reason?: string; hint?: string };
        const reason = body.reason ?? body.hint ?? `cook failed (${res.status})`;
        console.warn('[import-diag] triggerCook FAILED', { guid, reason, body });
        return { ok: false, error: { kind: 'http', status: res.status, hint: reason } };
      }
      return { ok: true, value: undefined };
    } catch (err) {
      console.error('[import-diag] triggerCook THREW', { guid }, err);
      return { ok: false, error: { kind: 'network', hint: `triggerCook network error: ${(err as Error)?.message ?? String(err)}` } };
    }
  }

  /** Read raw source bytes from disk (for cook when no in-memory File exists).
   *  `GET /api/files/raw`. Returns a structured failure on 404 / network error. */
  async readSourceBytes(path: string, signal?: AbortSignal): Promise<AssetIoResult<ArrayBuffer>> {
    recordAssetLeaf('assetIO.readSourceBytes');
    console.info('[import-diag] readSourceBytes', { path });
    try {
      const r = await fetch(`/api/files/raw?path=${encodeURIComponent(path)}`, { signal });
      console.info('[import-diag] readSourceBytes response', { path, status: r.status, ok: r.ok });
      if (!r.ok) return { ok: false, error: { kind: 'http', status: r.status, hint: `source read failed (HTTP ${r.status})` } };
      const buf = await r.arrayBuffer();
      console.info('[import-diag] readSourceBytes got', { path, byteLength: buf.byteLength });
      return { ok: true, value: buf };
    } catch (err) {
      console.error('[import-diag] readSourceBytes THREW', { path }, err);
      return { ok: false, error: { kind: 'network', hint: `source read network error: ${(err as Error)?.message ?? String(err)}` } };
    }
  }

  /** List all files under a directory via `/api/files/tree`. Returns flat array of
   *  relative paths (e.g. `['assets/foo.fbx', 'assets/foo.fbx.meta.json']`).
   *  Used by the startup integrity scan to discover source files without sidecars. */
  async listSourceFiles(root: string): Promise<string[]> {
    try {
      const r = await fetch(`/api/files/tree?root=${encodeURIComponent(root)}`);
      if (!r.ok) return [];
      const j = (await r.json()) as { tree?: TreeNode };
      const out: string[] = [];
      const walk = (n?: TreeNode): void => {
        if (!n) return;
        if (n.type === 'dir' && (n.name === 'node_modules' || n.name === '.git' || n.name === '.forgeax')) return;
        if (n.type === 'file') out.push(n.path);
        (n as { children?: TreeNode[] }).children?.forEach(walk);
      };
      walk(j.tree);
      return out;
    } catch {
      return [];
    }
  }

  /** Read an existing `.meta.json` (parsed) for reimport GUID reuse; null on first
   *  import / missing / parse error. The optional text-file route keeps the
   *  expected first-import miss out of the browser's failed-resource console. */
  async readExistingMeta(metaPath: string): Promise<unknown> {
    recordAssetLeaf('assetIO.readSourceBytes');
    try {
      const r = await fetch(`/api/files?path=${encodeURIComponent(metaPath)}&optional=1`);
      if (!r.ok) return undefined;
      const body = await r.json() as { content?: unknown };
      return typeof body.content === 'string' ? JSON.parse(body.content) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Read exact sidecar bytes and their same-snapshot strong revision. */
  async readMetaSidecar(metaPath: string): Promise<AssetIoResult<AssetResourceSnapshot>> {
    recordAssetLeaf('assetIO.readSourceBytes');
    if (this.resourceTransaction !== undefined) {
      if (!isSourceSidecarPort(this.resourceTransaction)) {
        return {
          ok: false,
          error: {
            kind: 'network',
            hint: `installed resource transaction port does not expose the ${SOURCE_SIDECAR_REVISION_DOMAIN} snapshot domain`,
          },
        };
      }
      try {
        return {
          ok: true,
          value: await this.resourceTransaction.readResource({ kind: 'source-sidecar', path: metaPath }),
        };
      } catch (err) {
        return {
          ok: false,
          error: { kind: 'network', hint: `sidecar snapshot failed: ${(err as Error)?.message ?? String(err)}` },
        };
      }
    }
    try {
      const response = await fetch(`/api/files/raw?path=${encodeURIComponent(metaPath)}&revision=1`);
      if (!response.ok) {
        return { ok: false, error: { kind: 'http', status: response.status, hint: `sidecar read failed (HTTP ${response.status})` } };
      }
      const revision = response.headers.get('etag');
      if (revision === null || revision.startsWith('W/')) {
        return { ok: false, error: { kind: 'http', status: response.status, hint: 'sidecar read did not return a strong revision' } };
      }
      const contents = await response.text();
      return { ok: true, value: { contents, revision } };
    } catch (err) {
      return { ok: false, error: { kind: 'network', hint: `sidecar read network error: ${(err as Error)?.message ?? String(err)}` } };
    }
  }

  /** Clone an asset within the same pack (new GUID, same kind/payload).
   *  Exposed via assetIO singleton for OOS-3 compliant external consumers
   *  (CBContextMenu etc.) — pack writes stay inside the gate. */
  async cloneAssetInPack(packPath: string, guid: string): Promise<{ ok: boolean; newGuid: string }> {
    recordAssetLeaf('assetIO.cloneAssetInPack');
    return this.runExclusivePackWrite(packPath, async () => {
      const pack = await readPack(packPath);
      if (!pack) return { ok: false, newGuid: '' };
      const source = pack.assets.find((a) => a.guid === guid);
      if (!source) return { ok: false, newGuid: '' };
      const targetGuid = generateAssetGuid();
      pack.assets.push({
        guid: targetGuid,
        kind: source.kind,
        name: source.name ? `${source.name} (copy)` : undefined,
        payload: structuredClone(source.payload),
        refs: [...source.refs],
      });
      const ok = await writePack(packPath, pack);
      return { ok, newGuid: targetGuid };
    });
  }
}

/** Shared singleton — the gateway ctx builder and document.ts's ctx builder
 *  share ONE instance so the per-path write chains serialize all pack writes
 *  across every consumer. */
export const assetIO = new AssetIOFacade();
