// Pack file CRUD operations (M2).
//
// All writes go through the server's POST /api/files. Reads use GET /api/files.
// Schema validation is deferred to engine load time — the editor reads pack
// files as loose JSON and preserves schemaVersion + kind verbatim.
//
// M1: PackAssetEntry/PackFile dual definitions deleted — import from scene-pack.ts
// SSOT (plan-strategy D-4, research Finding #9).

import { fetchWithTimeout } from '../io/net';
import { validatePackShell, type PackFile } from '../scene/scene-pack';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { sessionAppliers, registerApplier, type ApplierFn } from '../io/appliers';
import { broadcastAssetsChanged } from '../store/assets-changed';
import { resolveGamePath } from '../util/path-resolver';
import type { DocApplierCtx } from './document';
import { deletedEntryCache, renamedNameCache, duplicatedGuidCache, type PackAssetEntry } from '../io/asset-io-facade';
import type { ApplyResult, CreatableAssetKind, EditorOp } from '../types';
import type { SceneAsset } from '@forgeax/engine-types';

// ── Helpers ──────────────────────────────────────────────────────────────────

// Low-level pack IO primitives — encapsulated by AssetIOFacade (the asset write
// gate, G-5 / AC-D1). Exported so the facade is the ONLY external caller; any
// other file invoking these directly is a lint-unique-mutator violation.
export async function readPack(packPath: string): Promise<PackFile | null> {
  try {
    const r = await fetchWithTimeout(`/api/files?path=${encodeURIComponent(packPath)}`);
    if (!r.ok) return null;
    const j = (await r.json()) as { content?: string };
    if (!j.content) return null;
    // M1: validate pack shell before returning (AC-01 — plan-strategy D-1/D-3).
    // Replaces the bare `JSON.parse(j.content) as PackFile` cast.
    const parsed = JSON.parse(j.content);
    const result = validatePackShell(parsed);
    return result.ok ? result.pack : null;
  } catch {
    return null;
  }
}

export async function writePack(packPath: string, pack: PackFile): Promise<boolean> {
  try {
    // M1: validate pack shell before writing (AC-02 — plan-strategy D-1/D-3).
    // Bad packs are rejected — disk is never touched with invalid data.
    const validation = validatePackShell(pack);
    if (!validation.ok) {
      console.warn('[editor-core] writePack: pack shell validation failed — rejecting write', validation.error);
      return false;
    }
    const r = await fetch('/api/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: packPath, content: JSON.stringify(pack, null, 2) + '\n' }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function deleteFile(filePath: string): Promise<boolean> {
  try {
    const r = await fetch(`/api/files?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' });
    return r.ok;
  } catch {
    return false;
  }
}

// ── GUID generation ──────────────────────────────────────────────────────────

/** Mint a fresh, unique asset GUID via the engine's authoritative generator
 *  (dash-form string). Single minting seam — mirrors fbx-cook.ts. AGENTS.md #1
 *  / architecture-principles §2: never hand-roll a second GUID generator, the
 *  engine owns this. (Old stableGuid(timestamp+counter) seed was effectively
 *  random anyway — it gained nothing from stableGuid's determinism.) */
export function generateAssetGuid(): string {
  return AssetGuid.format(AssetGuid.random());
}

// ── Dangling refs check ──────────────────────────────────────────────────────

/** Find assets in `pack` that reference `removingGuid` in their refs[]. */
function findDanglingRefs(pack: PackFile, removingGuid: string): string[] {
  return pack.assets
    .filter(a => a.guid !== removingGuid && a.refs.includes(removingGuid))
    .map(a => a.name ?? a.guid);
}

// ── CRUD API ─────────────────────────────────────────────────────────────────

/** Add a new asset entry to an existing pack file. */
export async function addAssetToPack(
  packPath: string,
  asset: { guid: string; kind: string; name: string; payload: unknown; refs?: string[] },
): Promise<boolean> {
  const pack = await readPack(packPath);
  if (!pack) return false;
  pack.assets.push({
    guid: asset.guid,
    kind: asset.kind,
    name: asset.name,
    payload: asset.payload,
    refs: asset.refs ?? [],
  });
  return writePack(packPath, pack);
}

/** Remove an asset entry from a pack. Returns list of assets with dangling refs. */
export async function removeAssetFromPack(
  packPath: string,
  guid: string,
): Promise<{ ok: boolean; danglingRefs: string[] }> {
  const pack = await readPack(packPath);
  if (!pack) return { ok: false, danglingRefs: [] };
  const dangling = findDanglingRefs(pack, guid);
  pack.assets = pack.assets.filter(a => a.guid !== guid);
  const ok = await writePack(packPath, pack);
  return { ok, danglingRefs: dangling };
}

/** Rename an asset within a pack (change its `name` field). */
export async function renameAssetInPack(
  packPath: string,
  guid: string,
  newName: string,
): Promise<boolean> {
  const pack = await readPack(packPath);
  if (!pack) return false;
  const entry = pack.assets.find(a => a.guid === guid);
  if (!entry) return false;
  entry.name = newName;
  return writePack(packPath, pack);
}

/** Duplicate an asset within the same pack (new GUID, same kind/payload). */
export async function duplicateAssetInPack(
  packPath: string,
  guid: string,
): Promise<{ ok: boolean; newGuid: string }> {
  const pack = await readPack(packPath);
  if (!pack) return { ok: false, newGuid: '' };
  const source = pack.assets.find(a => a.guid === guid);
  if (!source) return { ok: false, newGuid: '' };
  const newGuid = generateAssetGuid();
  pack.assets.push({
    guid: newGuid,
    kind: source.kind,
    name: source.name ? `${source.name} (copy)` : undefined,
    payload: structuredClone(source.payload),
    refs: [...source.refs],
  });
  const ok = await writePack(packPath, pack);
  return { ok, newGuid };
}

/** Move an asset from one pack to another (GUID preserved). */
export async function moveAsset(
  sourcePackPath: string,
  targetPackPath: string,
  guid: string,
): Promise<boolean> {
  const sourcePack = await readPack(sourcePackPath);
  if (!sourcePack) return false;
  const entry = sourcePack.assets.find(a => a.guid === guid);
  if (!entry) return false;

  let targetPack = await readPack(targetPackPath);
  if (!targetPack) {
    targetPack = { schemaVersion: sourcePack.schemaVersion, kind: 'internal-text-package', assets: [] };
  }

  sourcePack.assets = sourcePack.assets.filter(a => a.guid !== guid);
  targetPack.assets.push(entry);

  const [s1, s2] = await Promise.all([
    writePack(sourcePackPath, sourcePack),
    writePack(targetPackPath, targetPack),
  ]);
  return s1 && s2;
}

/** Delete an asset. Handles both .pack.json and .meta.json sidecars.
 *  For .meta.json: removes the sub-asset entry; if empty, deletes the sidecar
 *  AND the source file it references. For .pack.json: removes the asset entry;
 *  if empty, deletes the pack file. */
export async function deleteAsset(packPath: string, guid: string): Promise<boolean> {
  if (packPath.endsWith('.meta.json')) {
    return deleteMetaAsset(packPath, guid);
  }
  const pack = await readPack(packPath);
  if (!pack) return false;
  pack.assets = pack.assets.filter(a => a.guid !== guid);
  if (pack.assets.length === 0) {
    return deleteFile(packPath);
  }
  return writePack(packPath, pack);
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetchWithTimeout(`/api/files?path=${encodeURIComponent(path)}`);
    if (!r.ok) return null;
    const j = (await r.json()) as { content?: string };
    if (!j.content) return null;
    return JSON.parse(j.content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function writeJsonFile(path: string, obj: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await fetch('/api/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, content: JSON.stringify(obj, null, 2) + '\n' }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function deleteMetaAsset(metaPath: string, guid: string): Promise<boolean> {
  const meta = await readJsonFile(metaPath);
  if (!meta) return false;
  const subs = meta.subAssets as { guid: string }[] | undefined;
  if (!Array.isArray(subs)) return false;

  meta.subAssets = subs.filter(s => s.guid !== guid);

  if ((meta.subAssets as unknown[]).length === 0) {
    const sourceFile = typeof meta.source === 'string' ? meta.source : null;
    const dir = metaPath.replace(/\/[^/]+$/, '');
    const results = await Promise.all([
      deleteFile(metaPath),
      sourceFile ? deleteFile(`${dir}/${sourceFile}`) : Promise.resolve(true),
    ]);
    return results[0];
  }
  return writeJsonFile(metaPath, meta);
}

/** Create a new empty pack file. */
export async function createPack(
  dirPath: string,
  packName: string,
  schemaVersion = '1.0',
): Promise<string | null> {
  const path = `${dirPath}/${packName}.pack.json`;
  const pack: PackFile = {
    schemaVersion,
    kind: 'internal-text-package',
    assets: [],
  };
  const ok = await writePack(path, pack);
  return ok ? path : null;
}

/** Create a directory via the server API. */
export async function createDirectory(dirPath: string): Promise<boolean> {
  try {
    const r = await fetch('/api/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dirPath, content: '', mkdir: true }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Delete a directory (recursive) via the server API. */
export async function deleteDirectory(dirPath: string): Promise<boolean> {
  try {
    const r = await fetch(`/api/files?path=${encodeURIComponent(dirPath)}`, {
      method: 'DELETE',
    });
    return r.ok;
  } catch {
    return false;
  }
}

// ── Session applier: createDirectory ─────────────────────────────────────────
// Registered into sessionAppliers (D-1) so gateway.dispatch routes it as a
// session op (ledger only, no undo). Human UI and AI are equal callers.
sessionAppliers.set('createDirectory', (op) => {
  const { parentPath, name } = op as { parentPath: string; name: string };
  const base = parentPath || 'assets';
  const fullPath = resolveGamePath(`${base}/${name}`);
  void createDirectory(fullPath).then(ok => {
    if (ok) broadcastAssetsChanged('directory-only');
  });
  return { ok: true };
});

sessionAppliers.set('deleteDirectory', (op) => {
  const { path } = op as { path: string };
  const fullPath = resolveGamePath(path);
  void deleteDirectory(fullPath).then(ok => {
    if (ok) broadcastAssetsChanged('directory-only');
  });
  return { ok: true };
});

// ── Document appliers: destroyAsset / restoreAsset (G-4 / AC-C5) ──────────────
// These are DOCUMENT-domain ops: they carry an inverse → undo + ledger (G-4).
// The actual pack mutation is async (HTTP /api/files), but the gateway's document
// applier contract is SYNCHRONOUS, so we:
//   1. snapshot the entry into deletedEntryCache BEFORE firing the async delete,
//      so the inverse op can synchronously restore the full entry on undo;
//   2. return { ok, inverse } synchronously; the IO runs fire-and-forget (same
//      pattern as the createDirectory session applier).
// destroyAsset → ctx.assetIO.deletePackEntry ; restoreAsset → ctx.assetIO.writePackEntry.
// AC-D4: both go through the asset write gate, recording assetIO.* leaves.

function _cacheKey(packPath: string, guid: string): string {
  return `${packPath}#${guid}`;
}

export function applyDestroyAsset(ctx: DocApplierCtx, cmd: EditorOp): ApplyResult {
  const { packPath, guid: rawGuid, newGuidCacheKey } = cmd as {
    packPath: string; guid: string; newGuidCacheKey?: string;
  };
  // async-guid resolution: when this destroyAsset is the INVERSE of a
  // duplicateAsset (undo of a duplicate), the guid to destroy is the one the
  // clone allocated INSIDE the gate — unknowable when the inverse skeleton was
  // built. duplicateAsset stashed it in duplicatedGuidCache under newGuidCacheKey;
  // resolve it here. If the cache miss (clone IO not yet landed), fall back to the
  // op's own guid (best-effort, matching the fire-and-forget contract). The entry
  // is left in the cache so a redo→undo cycle can resolve it again.
  const guid = (newGuidCacheKey ? duplicatedGuidCache.get(newGuidCacheKey) : undefined) ?? rawGuid;
  const key = _cacheKey(packPath, guid);
  // Fire the async delete; stash the snapshot so undo can restore the full entry.
  // The document-applier contract is synchronous (returns inverse immediately);
  // the IO is fire-and-forget. A .catch guards against an unhandled rejection if
  // the pack write fails (network/disk) — the op already landed in undo/ledger,
  // so a failed write must not crash the host (D-1: the gateway is the only door).
  void ctx.assetIO.deletePackEntry(packPath, guid).then((entry) => {
    deletedEntryCache.set(key, entry);
  }).catch((e) => console.warn('[editor-core] destroyAsset IO failed; entry not cached for undo:', e));
  return { ok: true, inverse: { kind: 'restoreAsset', packPath, guid, cacheKey: key } as unknown as EditorOp };
}

export function applyRestoreAsset(ctx: DocApplierCtx, cmd: EditorOp): ApplyResult {
  const { packPath, guid, cacheKey } = cmd as { packPath: string; guid: string; cacheKey?: string };
  const key = cacheKey ?? _cacheKey(packPath, guid);
  const entry = deletedEntryCache.get(key);
  if (entry) {
    void ctx.assetIO.writePackEntry(packPath, entry).catch((e) => console.warn('[editor-core] restoreAsset IO failed:', e));
    deletedEntryCache.delete(key);
  }
  return { ok: true, inverse: { kind: 'destroyAsset', packPath, guid } as unknown as EditorOp };
}

// Seed the two document appliers (symmetric inverse pair). Registered into the
// unified table as document-domain → undo + ledger (G-4).
registerApplier('document', 'destroyAsset', applyDestroyAsset as unknown as ApplierFn);
registerApplier('document', 'restoreAsset', applyRestoreAsset as unknown as ApplierFn);

// ── Document applier: createAsset (G-5 create gate) ──────────────────────────
// D2: createAsset is a DOCUMENT-domain op — it produces an inverse (destroyAsset)
// for free Undo, enters the ledger, and writes through ctx.assetIO (the sole
// asset write gate, symmetric to ctx.engine for ECS writes).

/** Payload factory — the ONLY location with knowledge of what a blank asset looks
 *  like per kind. UI/AI never carry payloads; the applier constructs them here.
 *  switch has NO default branch — TS enforces that every CreatableAssetKind member
 *  has a case (future extensions must add one here or fail to compile). */
function defaultPayloadFor(kind: CreatableAssetKind): Record<string, unknown> {
  switch (kind) {
    case 'scene': {
      const scene: SceneAsset = { kind: 'scene', entities: [] };
      return scene as unknown as Record<string, unknown>;
    }
    // Future extension example (TS enforces matching cases here):
    // case 'material': { const mat: MaterialAsset = { kind:'material', passes:[], paramValues:{} }; return mat as unknown as Record<string,unknown>; }
  }
}

function applyCreateAsset(ctx: DocApplierCtx, cmd: EditorOp): ApplyResult {
  const { packPath, guid, assetKind, name, refs } = cmd as {
    packPath: string; guid: string; assetKind: CreatableAssetKind; name: string; refs?: string[];
  };
  const payload = defaultPayloadFor(assetKind);
  // Fire-and-forget async IO through the asset gate (symmetrical to destroyAsset).
  // The document-applier contract is synchronous: return inverse immediately,
  // IO completes in background. On success the ledger entry is valid; on failure
  // the op is still committed (same pattern as destroyAsset/createDirectory).
  void ctx.assetIO.createAssetInPack({ packPath, asset: { guid, kind: assetKind, name, payload, refs } })
    .then(() => broadcastAssetsChanged())
    .catch((e) => console.warn('[editor-core] createAsset IO failed:', e));
  return { ok: true, inverse: { kind: 'destroyAsset', packPath, guid } as unknown as EditorOp };
}

registerApplier('document', 'createAsset', applyCreateAsset as unknown as ApplierFn);

// ── Document appliers: renameAsset / duplicateAsset (G-4) ─────────────────────
// Two MORE DOCUMENT-domain ops (undoable) added by the keyboard-router/context-menu
// gateway convergence — the last two asset mutations that still bypassed the door
// (edit-runtime keyboard-router-deps + CBContextMenu called renameAssetInPack /
// cloneAssetInPack directly). Both mirror the destroyAsset/restoreAsset shape:
//   - synchronous applier returns { ok, inverse } immediately;
//   - the pack IO is fire-and-forget through ctx.assetIO (the sole write gate);
//   - the inverse's undoable payload (old name / new guid) is discovered ASYNC
//     inside the gate, so it is stashed in a cache (renamedNameCache /
//     duplicatedGuidCache) at apply time and read back by the inverse op — the
//     exact same trick deletedEntryCache uses for restoreAsset (the document
//     applier contract is synchronous, so we cannot await the read here).

/** renameAsset — DOCUMENT op. The inverse is a renameAsset back to the OLD name.
 *  Callers (human UI + AI) pass ONLY the newName: the old name is NOT required on
 *  the op (an AI may not know it). The applier captures the replaced name from
 *  renamePackEntry's return into renamedNameCache under a per-(pack,guid) key; the
 *  inverse op carries that cacheKey and reads its target name back. (AI-parity:
 *  the pack on disk is the SSOT for the current name, not the caller.) */
export function applyRenameAsset(ctx: DocApplierCtx, cmd: EditorOp): ApplyResult {
  const { packPath, guid, newName } = cmd as { packPath: string; guid: string; newName: string };
  const key = _cacheKey(packPath, guid);
  // Fire the async rename; stash the replaced (old) name so the inverse can
  // restore it synchronously. A .catch guards against an unhandled rejection —
  // the op already landed in undo/ledger (D-1: the gateway is the only door).
  void ctx.assetIO.renamePackEntry(packPath, guid, newName).then((r) => {
    if (r.ok && r.oldName !== null) renamedNameCache.set(key, r.oldName);
    broadcastAssetsChanged();
  }).catch((e) => console.warn('[editor-core] renameAsset IO failed; old name not cached for undo:', e));
  // The inverse renames back. Its newName is resolved from renamedNameCache via
  // renameCacheKey; if the cache misses (IO not landed), it falls back to any
  // oldName the op happened to carry (UI knows the current name; AI may not).
  return {
    ok: true,
    inverse: {
      kind: 'renameAsset', packPath, guid,
      newName: (cmd as { oldName?: string }).oldName ?? newName,
      renameCacheKey: key,
    } as unknown as EditorOp,
  };
}

/** duplicateAsset — DOCUMENT op. Clones an asset in-pack (new guid allocated
 *  INSIDE the gate). Inverse is destroyAsset on the NEW guid — but that guid is
 *  async (cloneAssetInPack returns it only after the pack read/write), so we stash
 *  it in duplicatedGuidCache under the SOURCE key and hand destroyAsset a
 *  newGuidCacheKey to resolve it at undo time (the async-guid wrinkle — same
 *  fire-and-forget cache contract as destroyAsset's deletedEntryCache). */
export function applyDuplicateAsset(ctx: DocApplierCtx, cmd: EditorOp): ApplyResult {
  const { packPath, guid } = cmd as { packPath: string; guid: string };
  const key = _cacheKey(packPath, guid);
  void ctx.assetIO.cloneAssetInPack(packPath, guid).then((r) => {
    if (r.ok && r.newGuid) duplicatedGuidCache.set(key, r.newGuid);
    broadcastAssetsChanged();
  }).catch((e) => console.warn('[editor-core] duplicateAsset IO failed; new guid not cached for undo:', e));
  // Inverse destroys the produced clone. The clone's guid is not known
  // synchronously, so the inverse carries newGuidCacheKey; applyDestroyAsset reads
  // the real guid back from duplicatedGuidCache. The `guid` field is a best-effort
  // placeholder (the source guid) for the cache-miss fallback path.
  return {
    ok: true,
    inverse: {
      kind: 'destroyAsset', packPath, guid, newGuidCacheKey: key,
    } as unknown as EditorOp,
  };
}

registerApplier('document', 'renameAsset', applyRenameAsset as unknown as ApplierFn);
registerApplier('document', 'duplicateAsset', applyDuplicateAsset as unknown as ApplierFn);
