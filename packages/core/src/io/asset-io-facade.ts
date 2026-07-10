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
import type { PackFile } from '../scene/scene-pack';
import { readPack, writePack, deleteAsset, generateAssetGuid } from '../session/pack-ops';
import { recordAssetLeaf } from './trace';

/** A single asset entry inside a pack file (derived from the zod PackFile shape). */
export type PackAssetEntry = PackFile['assets'][number];

/**
 * Snapshot of deleted asset entries, keyed by `${packPath}#${guid}`, captured
 * BEFORE the async delete completes so the document-op inverse (`restoreAsset`)
 * can synchronously restore the full entry on undo (OOS-5 single-asset undo).
 * The gateway's document-applier contract is synchronous, so we cannot await the
 * read inside the applier — instead the entry is stashed here and read back by the
 * inverse op. Entries are evicted once restoreAsset consumes them.
 */
export const deletedEntryCache = new Map<string, PackAssetEntry>();

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
export const renamedNameCache = new Map<string, string>();

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
export const duplicatedGuidCache = new Map<string, string>();

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
  /** Read one asset entry from a pack file (null if pack/entry missing). */
  async readPackEntry(packPath: string, guid: string): Promise<PackAssetEntry | null> {
    recordAssetLeaf('assetIO.readPackEntry');
    const pack = await readPack(packPath);
    if (!pack) return null;
    return pack.assets.find((a) => a.guid === guid) ?? null;
  }

  /** Delete one asset entry, returning the SNAPSHOT of the deleted entry so the
   *  op's inverse can restore it (OOS-5 single-asset undo). Throws if the entry
   *  could not be read or the delete failed. */
  async deletePackEntry(packPath: string, guid: string): Promise<PackAssetEntry> {
    recordAssetLeaf('assetIO.deletePackEntry');
    const entry = await this.readPackEntry(packPath, guid);
    if (!entry) throw new Error(`[editor-core] assetIO.deletePackEntry: entry ${guid} not found in ${packPath}`);
    const ok = await deleteAsset(packPath, guid);
    if (!ok) throw new Error(`[editor-core] assetIO.deletePackEntry: failed to delete ${guid} from ${packPath}`);
    return entry;
  }

  /** Write (create or replace) one asset entry. Returns true on success. */
  async writePackEntry(packPath: string, entry: PackAssetEntry): Promise<boolean> {
    recordAssetLeaf('assetIO.writePackEntry');
    const pack = await readPack(packPath);
    if (!pack) return false;
    const idx = pack.assets.findIndex((a) => a.guid === entry.guid);
    if (idx >= 0) pack.assets[idx] = entry;
    else pack.assets.push(entry);
    return writePack(packPath, pack);
  }

  /** Create a new asset entry in a pack (creates the pack file if missing).
   *  Single gate for `createAsset` document op — all other callers are lint-gated. */
  async createAssetInPack(opts: {
    packPath: string;
    asset: { guid: string; kind: string; name: string; payload: unknown; refs?: string[] };
  }): Promise<{ ok: boolean }> {
    recordAssetLeaf('assetIO.createAssetInPack');
    let pack = await readPack(opts.packPath);
    if (!pack) {
      // Create the pack file on first asset
      pack = { schemaVersion: '1.0', kind: 'internal-text-package', assets: [] };
    }
    pack.assets.push({
      guid: opts.asset.guid,
      kind: opts.asset.kind,
      name: opts.asset.name,
      payload: opts.asset.payload as Record<string, unknown>,
      refs: opts.asset.refs ?? [],
    });
    const ok = await writePack(opts.packPath, pack);
    return { ok };
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
    const pack = await readPack(packPath);
    if (!pack) return { ok: false, oldName: null };
    const entry = pack.assets.find((a) => a.guid === guid);
    if (!entry) return { ok: false, oldName: null };
    const oldName = entry.name ?? null;
    entry.name = newName;
    const ok = await writePack(packPath, pack);
    return { ok, oldName };
  }

  /** Clone an asset within the same pack (new GUID, same kind/payload).
   *  Exposed via assetIO singleton for OOS-3 compliant external consumers
   *  (CBContextMenu etc.) — pack writes stay inside the gate. */
  async cloneAssetInPack(packPath: string, guid: string): Promise<{ ok: boolean; newGuid: string }> {
    recordAssetLeaf('assetIO.cloneAssetInPack');
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
  }
}

/** Shared singleton — AssetIOFacade holds no per-instance state, so a single
 *  instance is used by the gateway ctx builder and document.ts's ctx builder. */
export const assetIO = new AssetIOFacade();
