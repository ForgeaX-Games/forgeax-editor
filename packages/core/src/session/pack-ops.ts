// Pack file CRUD operations (M2).
//
// All writes go through the server's POST /api/files. Reads use GET /api/files.
// Schema validation is deferred to engine load time — the editor reads pack
// files as loose JSON and preserves schemaVersion + kind verbatim.
//
// M1: PackAssetEntry/PackFile dual definitions deleted — import from scene-pack.ts
// SSOT (plan-strategy D-4, research Finding #9).

import { type PackFile } from '../scene/scene-pack';
import { sessionAppliers, registerApplier, type ApplierFn } from '../io/appliers';
import { broadcastAssetsChanged } from '../store/assets-changed';
import { resolveGamePath, resolveGamePathOnce } from '../util/path-resolver';
import { clampMaterialPackPath } from '../util/material-pack-path';
import type { DocApplierCtx } from './document';
import { deletedEntryCache, renamedNameCache, duplicatedGuidCache } from '../io/asset-op-caches';
import type { ApplyResult, CreatableAssetKind, EditorOp } from '../types';
import { validateAssetBasename, checkPathNotJailbreak } from './asset-basename';
import { broadcastAssetsError } from '../store/assets-error-bus';
import {
  awaitPostAssetWriteCatalogSync,
  scheduleAuthoredAssetWrite,
  trackPendingAssetWrite,
  untrackAuthoredInlineAsset,
  type AuthoredAssetWrite,
} from './authored-asset-write';
import type { SceneAsset } from '@forgeax/engine-types';
import { Materials } from '@forgeax/engine-render';
import {
  defineParticleEffectSourceV2,
  PARTICLE_CODE_DEFAULT_MODULE_ID,
} from '@forgeax/engine-vfx';
import { classifyUiAuthoring } from '@forgeax/engine-ui/authoring';
import { encodeMaterialPackRefs } from '../io/material-pack-refs';
import {
  readPack, writePack, deleteFile, deleteAsset, generateAssetGuid,
  readMetaSubAsset, writeMetaSubAsset, renameMetaSubAsset,
  type MetaSubAsset,
} from '../io/asset-io-primitives';

export { readPack, writePack, deleteFile, deleteAsset, generateAssetGuid,
  readMetaSubAsset, writeMetaSubAsset, renameMetaSubAsset } from '../io/asset-io-primitives';
export type { MetaSubAsset } from '../io/asset-io-primitives';

type PackAssetEntry = PackFile['assets'][number];

/** Build the opaque resource change consumed by the platform resource port.
 * Pack-ops owns the pack representation; it does not perform a second write. */
export function createPackResourceChange(path: string, content: string): {
  readonly kind: 'put';
  readonly resourceId: string;
  readonly bytes: Uint8Array;
} {
  return { kind: 'put', resourceId: path, bytes: new TextEncoder().encode(content) };
}

// ── async-IO failure hint text (shared by fire-and-forget catch blocks) ────
// The applier synchronously returned `ok:true` (INVALID_ARGS was gated at
// entry), but the disk/network write later failed. Emit through the
// assetsError bus so a subscribed panel can toast — the alternative (silent
// console.warn) leaves the UI showing stale/inconsistent state with no user
// feedback (dev-plan §5 step 3).
function _ioFailHint(op: string, path: string | undefined, e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? 'unknown');
  return path
    ? `${op}("${path}") failed: ${msg}`
    : `${op} failed: ${msg}`;
}

const replacedAssetCache = new Map<string, AuthoredAssetWrite | null>();

function scheduleUiAssetWrite(
  ctx: DocApplierCtx,
  targetPack: string,
  asset: AuthoredAssetWrite,
): ApplyResult {
  const cacheKey = `${targetPack}#${asset.guid.toLowerCase()}#${crypto.randomUUID()}`;
  const completion = ctx.assetIO.upsertAssetInPack({ packPath: targetPack, asset })
    .then(async ({ ok, previous }) => {
      if (!ok) throw new Error(`Could not write ${asset.kind} asset ${asset.guid} to ${targetPack}.`);
      replacedAssetCache.set(cacheKey, previous as AuthoredAssetWrite | null);
      await awaitPostAssetWriteCatalogSync(asset.guid);
      broadcastAssetsChanged();
    });
  trackPendingAssetWrite(
    asset.guid,
    completion,
    (error) => console.warn(`[editor-core] write ${asset.kind} asset commit failed:`, error),
  );
  return {
    ok: true,
    inverse: { kind: 'restoreWrittenAsset', packPath: targetPack, guid: asset.guid, cacheKey } as unknown as EditorOp,
    created: [],
  };
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

/** Rename/move a file or directory via the server API. */
export async function renameOnDisk(fromPath: string, toPath: string): Promise<boolean> {
  try {
    const r = await fetch('/api/files/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: fromPath, to: toPath }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Rename a source file and its `.meta.json` sidecar (if it exists).
 *  Also updates the `source` field inside the sidecar to reflect the new name. */
export async function renameSourceFileOnDisk(fromPath: string, toPath: string): Promise<boolean> {
  const ok = await renameOnDisk(fromPath, toPath);
  if (!ok) return false;
  const metaFrom = `${fromPath}.meta.json`;
  const metaTo = `${toPath}.meta.json`;
  const metaOk = await renameOnDisk(metaFrom, metaTo);
  if (metaOk) {
    const newBasename = toPath.slice(toPath.lastIndexOf('/') + 1);
    try {
      const r = await fetch(`/api/files?path=${encodeURIComponent(metaTo)}`);
      if (r.ok) {
        const json = await r.json() as { content?: string };
        if (json.content) {
          const meta = JSON.parse(json.content) as Record<string, unknown>;
          meta.source = newBasename;
          await fetch('/api/files', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: metaTo, content: JSON.stringify(meta, null, 2) + '\n' }),
          });
        }
      }
    } catch {
      // sidecar source field update is best-effort
    }
  }
  return true;
}

// ── Session applier: createDirectory ─────────────────────────────────────────
// Registered into sessionAppliers (D-1) so gateway.dispatch routes it as a
// session op (ledger only, no undo). Human UI and AI are equal callers.
//
// BASENAME VALIDATION (2026-07-23 assets-folder-name-validation): the applier
// is the north-star SSOT for "is this name legal?" — reject illegal input BEFORE
// touching disk so the same illegal input is caught regardless of caller (any
// of the 4 UI entry points, AI dispatch, transaction sub-op). See
// session/asset-basename.ts for the shared rule set (same function used by the
// prompt dialog for UX highlighting).
sessionAppliers.set('createDirectory', (op) => {
  const { parentPath, name } = op as { parentPath: string; name: string };
  const check = validateAssetBasename(name);
  if (!check.ok) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: `createDirectory: ${check.hint}` } };
  }
  const base = parentPath || 'assets';
  const targetPath = `${base}/${check.name}`;
  const fullPath = resolveGamePath(targetPath);
  // Fire-and-forget: applier already returned ok:true. On disk failure the
  // ok:false branch (server said no) AND the .catch branch (promise rejected
  // — network drop, disk full) both emit through assetsError so a subscribed
  // panel can toast. Without this, a failed write is a silent console.warn
  // and the panel keeps showing the pre-op state with no user feedback.
  void createDirectory(fullPath).then(ok => {
    if (ok) broadcastAssetsChanged('directory-only');
    else broadcastAssetsError({ op: 'createDirectory', path: targetPath, hint: `createDirectory("${targetPath}") failed on server` });
  }).catch(e => broadcastAssetsError({ op: 'createDirectory', path: targetPath, hint: _ioFailHint('createDirectory', targetPath, e) }));
  return { ok: true };
});

sessionAppliers.set('deleteDirectory', (op) => {
  const { path } = op as { path: string };
  // Path-level jailbreak defence only — `deleteDirectory` intentionally accepts
  // ANY existing on-disk path (including one that carries a bad basename from
  // an older build predating this validator), so we do NOT run
  // validateAssetBasename on the last segment. That leaves the escape hatch for
  // users to clean up already-created bad folders through the panel.
  const jail = checkPathNotJailbreak(path);
  if (!jail.ok) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: `deleteDirectory: ${jail.hint}` } };
  }
  const fullPath = resolveGamePath(path);
  void deleteDirectory(fullPath).then(ok => {
    if (ok) broadcastAssetsChanged('directory-only');
    else broadcastAssetsError({ op: 'deleteDirectory', path, hint: `deleteDirectory("${path}") failed on server` });
  }).catch(e => broadcastAssetsError({ op: 'deleteDirectory', path, hint: _ioFailHint('deleteDirectory', path, e) }));
  return { ok: true };
});

sessionAppliers.set('renameDirectory', (op) => {
  const { path, newName } = op as { path: string; newName: string };
  // `path` is an existing on-disk directory — same jailbreak logic as
  // deleteDirectory. `newName` is authored input and must pass full basename
  // validation.
  const jail = checkPathNotJailbreak(path);
  if (!jail.ok) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: `renameDirectory: ${jail.hint}` } };
  }
  const check = validateAssetBasename(newName);
  if (!check.ok) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: `renameDirectory: ${check.hint}` } };
  }
  const fullPath = resolveGamePath(path);
  const parentDir = fullPath.slice(0, fullPath.lastIndexOf('/'));
  const newFullPath = `${parentDir}/${check.name}`;
  void renameOnDisk(fullPath, newFullPath).then(ok => {
    if (ok) broadcastAssetsChanged('directory-only');
    else broadcastAssetsError({ op: 'renameDirectory', path, hint: `renameDirectory("${path}" -> "${check.name}") failed on server` });
  }).catch(e => broadcastAssetsError({ op: 'renameDirectory', path, hint: _ioFailHint('renameDirectory', path, e) }));
  return { ok: true };
});

sessionAppliers.set('renameSourceFile', (op) => {
  const { path, newName } = op as { path: string; newName: string };
  const jail = checkPathNotJailbreak(path);
  if (!jail.ok) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: `renameSourceFile: ${jail.hint}` } };
  }
  const check = validateAssetBasename(newName);
  if (!check.ok) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: `renameSourceFile: ${check.hint}` } };
  }
  const fullPath = resolveGamePath(path);
  const parentDir = fullPath.slice(0, fullPath.lastIndexOf('/'));
  const newFullPath = `${parentDir}/${check.name}`;
  void renameSourceFileOnDisk(fullPath, newFullPath).then(ok => {
    if (ok) broadcastAssetsChanged();
    else broadcastAssetsError({ op: 'renameSourceFile', path, hint: `renameSourceFile("${path}" -> "${check.name}") failed on server` });
  }).catch(e => broadcastAssetsError({ op: 'renameSourceFile', path, hint: _ioFailHint('renameSourceFile', path, e) }));
  return { ok: true };
});

sessionAppliers.set('revealInFileManager', (op) => {
  const { path } = op as { path: string };
  void fetch('/api/files/reveal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  }).catch(() => {});
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
  const { _resolvedPackPath, guid: rawGuid, newGuidCacheKey } = cmd as {
    _resolvedPackPath?: string; guid: string; newGuidCacheKey?: string;
  };
  if (typeof _resolvedPackPath !== 'string' || _resolvedPackPath.length === 0) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'destroyAsset requires a Gateway-derived storage path' } };
  }
  // async-guid resolution: when this destroyAsset is the INVERSE of a
  // duplicateAsset (undo of a duplicate), the guid to destroy is the one the
  // clone allocated INSIDE the gate — unknowable when the inverse skeleton was
  // built. duplicateAsset stashed it in duplicatedGuidCache under newGuidCacheKey;
  // resolve it here. If the cache miss (clone IO not yet landed), fall back to the
  // op's own guid (best-effort, matching the fire-and-forget contract). The entry
  // is left in the cache so a redo→undo cycle can resolve it again.
  const guid = (newGuidCacheKey ? duplicatedGuidCache.get(newGuidCacheKey) : undefined) ?? rawGuid;
  const key = _cacheKey(_resolvedPackPath, guid);
  // Fire the async delete; stash the snapshot so undo can restore the full entry.
  // The document-applier contract is synchronous (returns inverse immediately);
  // the IO is fire-and-forget. A .catch guards against an unhandled rejection if
  // the pack write fails (network/disk) — the op already landed in undo/ledger,
  // so a failed write must not crash the host (D-1: the gateway is the only door).
  const completion = ctx.assetIO.deletePackEntry(_resolvedPackPath, guid).then((entry) => {
    deletedEntryCache.set(key, entry);
    // Symmetric with the createMaterial track seam: if this guid was a
    // post-load authored inline asset, the save baseline must drop it again
    // (a floor bump for a guid that no longer exists would refuse future saves).
    untrackAuthoredInlineAsset(guid);
    broadcastAssetsChanged('pack-changed', 'local-op', { kind: 'deleted', guid });
  });
  trackPendingAssetWrite(
    guid,
    completion,
    (e) => console.warn('[editor-core] destroyAsset IO failed; entry not cached for undo:', e),
  );
  return { ok: true, inverse: { kind: 'restoreAsset', _resolvedPackPath, guid, cacheKey: key } as unknown as EditorOp, created: [] };
}

export function applyRestoreAsset(ctx: DocApplierCtx, cmd: EditorOp): ApplyResult {
  const { _resolvedPackPath, guid, cacheKey } = cmd as { _resolvedPackPath: string; guid: string; cacheKey?: string };
  const key = cacheKey ?? _cacheKey(_resolvedPackPath, guid);
  const entry = deletedEntryCache.get(key);
  if (entry) {
    void ctx.assetIO.writePackEntry(_resolvedPackPath, entry as never)
      .then(() => broadcastAssetsChanged())
      .catch((e) => console.warn('[editor-core] restoreAsset IO failed:', e));
    deletedEntryCache.delete(key);
  }
  return { ok: true, inverse: { kind: 'destroyAsset', _resolvedPackPath, guid } as unknown as EditorOp, created: [] };
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
function defaultPayloadFor(
  kind: CreatableAssetKind,
  particleMaterialGuid?: string,
): Record<string, unknown> {
  switch (kind) {
    case 'scene': {
      const scene: SceneAsset = { kind: 'scene', entities: [] };
      return scene as unknown as Record<string, unknown>;
    }
    case 'material':
      throw new Error(
        'material assets must be created via the createMaterial op, not createAsset — ' +
        'createMaterial uses Materials.standard() (engine canonical builder) and is the SSOT for material authoring',
      );
    case 'material-instance':
      throw new Error(
        'material-instance assets must be created via the createMaterialInstance op, not createAsset — ' +
        'createMaterialInstance requires a parentGuid and builds the editor MI payload schema',
      );
    case 'input-map':
      throw new Error(
        'input-map assets must be created via the createInputMap op, not createAsset — ' +
        'createInputMap builds the editor InputMap payload schema',
      );
    case 'particle-effect': {
      if (particleMaterialGuid === undefined) {
        throw new Error('particle-effect creation requires its generated material GUID');
      }
      const source = defineParticleEffectSourceV2({
        schemaVersion: 2,
        emitters: [{
          id: 'default',
          capacity: 256,
          backend: { required: 'gpu' },
          space: 'local',
          schedule: { rate: 8, bursts: [] },
          bounds: { kind: 'sphere', center: [0, 1, 0], radius: 3 },
          program: { module: PARTICLE_CODE_DEFAULT_MODULE_ID },
          renderers: [{ kind: 'billboard', material: particleMaterialGuid, blend: 'alpha' }],
        }],
      });
      return source as unknown as Record<string, unknown>;
    }
  }
}

export function applyCreateAsset(ctx: DocApplierCtx, cmd: EditorOp): ApplyResult {
  const { packPath, guid, assetKind, name, refs } = cmd as {
    packPath: string; guid: string; assetKind: CreatableAssetKind; name: string; refs?: string[];
  };
  const execution = assetKind === 'particle-effect' ? 'cooked' : undefined;

  const extraAssets: Array<{ guid: string; kind: string; name: string; payload: unknown; refs?: string[] }> = [];
  const particleMaterialGuid = assetKind === 'particle-effect' ? generateAssetGuid() : undefined;
  if (assetKind === 'particle-effect') {
    if (particleMaterialGuid === undefined) throw new Error('particle-effect material GUID was not generated');
    const matPayload = Materials.standard({ baseColor: [1, 1, 1, 1] }) as unknown as Record<string, unknown>;
    extraAssets.push({ guid: particleMaterialGuid, kind: 'material', name: `${name}_Mat`, payload: matPayload, refs: [] });
  }
  const payload = defaultPayloadFor(assetKind, particleMaterialGuid);
  // The native VFX cooker derives refs from the authored output material/mesh.
  // Keep the authored particle row aligned with the engine Pack contract rather
  // than duplicating those derived references in the source entry.
  const assetRefs = assetKind === 'particle-effect' ? [] : refs;

  // Fire-and-forget async IO through the asset gate (symmetrical to destroyAsset).
  // The document-applier contract is synchronous: return inverse immediately,
  // IO completes in background. The write result is CHECKED — a failed write is
  // broadcast as an assetsError so the UI does not show an asset that never
  // reached disk (same discipline as createMaterial; no completion tracking
  // here because nothing binds to a fresh blank scene asset).
  void ctx.assetIO.createAssetInPack({
    packPath,
    asset: { guid, kind: assetKind, name, payload, refs: assetRefs, execution },
    extraAssets: extraAssets.length > 0 ? extraAssets : undefined,
  })
    .then((r) => {
      if (!r.ok) {
        console.error('[editor-core] createAsset write failed:', { guid, packPath, reason: r.reason, hint: r.hint });
        broadcastAssetsError({ op: 'createAsset', path: packPath, hint: `createAsset write failed (${r.reason}): ${r.hint}` });
        return;
      }
      broadcastAssetsChanged();
    })
    .catch((e) => {
      console.warn('[editor-core] createAsset IO failed:', e);
      broadcastAssetsError({ op: 'createAsset', path: packPath, hint: _ioFailHint('createAsset', packPath, e) });
    });
  return { ok: true, inverse: { kind: 'destroyAsset', _resolvedPackPath: packPath, guid } as unknown as EditorOp, created: [] };
}

registerApplier('document', 'createAsset', applyCreateAsset as unknown as ApplierFn);

// ── Document applier: createMaterial (solo round-12 / P5 rendering-authoring) ──
// The front-door "AUTHOR a PBR material" op. createAsset (above) mints only BLANK
// payloads per kind ("UI/AI never carry payloads") and supports only 'scene', so it
// cannot author a material's params; bindAssetRef (round-11) only BINDS an existing
// catalogued GUID. This op fills the gap: mint a NEW MaterialAsset from
// sRGB baseColor plus linear metallic/roughness into the pack, so an AI can create a look from scratch
// then bindAssetRef it onto a mesh. DOCUMENT-domain like createAsset (undoable,
// inverse=destroyAsset, writes through ctx.assetIO — the sole asset write gate).
//
// The POD is built by the engine's canonical Materials.standard() builder — NOT a
// hand-rolled passes[] array (§2.5: three cook sites already disagree on pass count;
// the engine owns the SSOT material shape). guid is caller-minted (the dispatch
// contract surfaces no minted value — ApplyResult carries only created[]; round-11
// proved created is null over the eval bridge — so the caller mints the guid and
// reuses it for the follow-up bindAssetRef). packPath is optional: an eval AI has no
// basePath, so it defaults to the active game's scene.pack.json (the same target
// disk-io.ts writes the scene to).
export function applyCreateMaterial(ctx: DocApplierCtx, cmd: EditorOp): ApplyResult {
  const { guid, name, baseColor, metallic, roughness, baseColorTexture, alphaCutoff, packPath, refs } = cmd as {
    guid: string; name: string; baseColor: [number, number, number, number];
    metallic?: number; roughness?: number; baseColorTexture?: string; alphaCutoff?: number; packPath?: string; refs?: string[];
  };
  // Fail Fast (§5): reject a malformed op before it writes a broken pack entry.
  if (typeof guid !== 'string' || guid.length === 0) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'createMaterial requires a non-empty `guid` (mint via crypto.randomUUID(); the caller reuses it for bindAssetRef)' } };
  }
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'createMaterial requires a non-empty `name`' } };
  }
  if (!Array.isArray(baseColor) || baseColor.length !== 4 || !baseColor.every((c) => typeof c === 'number')) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'createMaterial requires sRGB `baseColor` as [r,g,b,a] (four numbers, 0..1; alpha is linear)' } };
  }
  if (metallic !== undefined && typeof metallic !== 'number') {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'createMaterial `metallic` must be a number (0..1) if given' } };
  }
  if (roughness !== undefined && typeof roughness !== 'number') {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'createMaterial `roughness` must be a number (0..1) if given' } };
  }
  if (alphaCutoff !== undefined && (typeof alphaCutoff !== 'number' || alphaCutoff < 0 || alphaCutoff > 1)) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'createMaterial `alphaCutoff` must be a number in [0, 1] if given (UE-Masked equivalent: baseColorTexture alpha below the cutoff is discarded)' } };
  }
  if (baseColorTexture !== undefined) {
    if (typeof baseColorTexture !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(baseColorTexture)) {
      return { ok: false, error: { code: 'INVALID_ARGS', hint: 'createMaterial `baseColorTexture` must be a texture asset GUID (RFC 4122), not a path or display name' } };
    }
    // Fail Fast on a phantom texture ref: a material whose baseColorTexture GUID
    // is not catalogued can NEVER resolve at render — it silently shades with
    // the plain baseColor forever (no retry), which is exactly the "gray quad"
    // failure a stale Content Browser row produces when dragged into the scene.
    // ctx.engine is a facade with a registry in the live gateway; direct-applier
    // unit envs pass a partial ctx without it — isAssetCatalogued also returns
    // undefined when the facade has no registry (validation unavailable), and
    // we reject only on a KNOWN miss.
    const catalogProbe = ctx.engine as { isAssetCatalogued?: (guid: string) => boolean | undefined } | undefined;
    if (catalogProbe?.isAssetCatalogued?.(baseColorTexture) === false) {
      return { ok: false, error: { code: 'INVALID_ARGS', hint: `createMaterial baseColorTexture ${baseColorTexture} is not in the live asset catalog — the texture may have been deleted or its import failed; re-import it before authoring the material` } };
    }
  }
  // Materials have their own pack writer. Appending them to the scene pack violates
  // single-writer ownership: the scene serializer later rewrites that pack from the
  // World snapshot and can erase a newly-authored, not-yet-bound material.
  // Caller paths stay game-relative; only the host resolver knows the disk root.
  let targetPack: string;
  try {
    targetPack = typeof packPath === 'string' && packPath.length > 0
      ? resolveGamePathOnce(packPath)
      : resolveGamePath('assets/materials.pack.json');
  } catch {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'createMaterial requires an active game path resolver; select a game before authoring a material' } };
  }
  const clamped = clampMaterialPackPath(targetPack);
  if (clamped.redirected) {
    console.warn(
      `[editor-core] createMaterial: packPath "${targetPack}" is outside assets/; ` +
      `redirecting to "${clamped.packPath}"`,
    );
  }
  targetPack = clamped.packPath;
  // Canonical PBR POD from the engine builder (SSOT — no hand-rolled passes).
  const payload = Materials.standard({
    baseColor,
    ...(metallic !== undefined ? { metallic } : {}),
    ...(roughness !== undefined ? { roughness } : {}),
    ...(alphaCutoff !== undefined ? { alphaCutoff } : {}),
  }) as unknown as Record<string, unknown>;

  // The editor-owned material wire-format boundary is shared with save,
  // migration, and updateMaterialParams. Keep the authoring API in GUID form;
  // only the pack payload uses refs[] indices.
  if (baseColorTexture !== undefined) {
    const values = (payload.values ?? {}) as Record<string, unknown>;
    payload.values = { ...values, baseColorTexture };
  }
  const encoded = encodeMaterialPackRefs(payload, refs);
  if (!encoded.ok) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: encoded.error.hint } };
  }
  const assetRefs = encoded.refs;
  const encodedPayload = encoded.payload;

  // Fire-and-forget async IO through the asset gate (mirrors createAsset). The
  // document-applier contract is synchronous: return the inverse immediately; IO
  // completes in background; broadcastAssetsChanged() refreshes the catalog.
  // Before broadcasting, await the host's catalog-sync hook (if registered) so
  // the pack-index row + payload envelope for the new GUID are actually live —
  // otherwise the broadcast races the vite-plugin-pack watcher rebuild and a
  // follow-up updateMaterialParams finds no envelope (see the seam above).
  return scheduleAuthoredAssetWrite(ctx, targetPack, {
    guid,
    kind: 'material',
    name,
    payload: encodedPayload,
    refs: assetRefs,
  });
}

registerApplier('document', 'createMaterial', applyCreateMaterial as unknown as ApplierFn);

export function applyWriteUi(ctx: DocApplierCtx, cmd: EditorOp): ApplyResult {
  const { guid, name, html, css, sourcePath, packPath } = cmd as {
    guid: string; name: string; html: string; css: string; sourcePath?: string; packPath?: string;
  };
  if (typeof guid !== 'string' || guid.length === 0) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'writeUi requires a non-empty caller-minted `guid`' } };
  }
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'writeUi requires a non-empty `name`' } };
  }
  if (typeof html !== 'string' || html.length === 0 || typeof css !== 'string') {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'writeUi requires non-empty `html` and string `css` fields' } };
  }
  const diagnosticPath = typeof sourcePath === 'string' && sourcePath.length > 0
    ? sourcePath
    : `${name}.ui.html`;
  const classification = classifyUiAuthoring({ sourcePath: diagnosticPath, html, css });
  if (classification.blocking) {
    const issue = classification.diagnostics.find((entry) => entry.severity === 'error');
    const location = issue?.sourceRange;
    return { ok: false, error: {
      code: 'INVALID_ARGS',
      hint: issue === undefined
        ? 'writeUi rejected invalid UI authoring input'
        : `${issue.code} at ${issue.sourcePath}:${location?.line ?? 1}:${location?.column ?? 1}: ${issue.hint}`,
      ...(issue?.expected === undefined ? {} : { expected: issue.expected }),
      ...(issue?.actual === undefined ? {} : { current: issue.actual }),
    } };
  }
  let targetPack: string;
  try {
    targetPack = resolveGamePath(
      typeof packPath === 'string' && packPath.length > 0 ? packPath : 'assets/ui.pack.json',
    );
  } catch {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'writeUi requires an active game path resolver; select a game before authoring UI' } };
  }
  return scheduleUiAssetWrite(ctx, targetPack, {
    guid,
    kind: 'ui',
    name,
    payload: { guid, html, css },
    refs: [],
  });
}

registerApplier('document', 'writeUi', applyWriteUi as unknown as ApplierFn);

export function applyRestoreWrittenAsset(ctx: DocApplierCtx, cmd: EditorOp): ApplyResult {
  const { packPath, guid, cacheKey } = cmd as { packPath: string; guid: string; cacheKey: string };
  const previous = replacedAssetCache.get(cacheKey);
  if (previous !== undefined) {
    const mutation = previous === null
      ? ctx.assetIO.deletePackEntry(packPath, guid).then(() => true)
      : ctx.assetIO.writePackEntry(packPath, previous as never);
    void mutation
      .then(() => broadcastAssetsChanged())
      .catch((error) => console.warn('[editor-core] restoreWrittenAsset IO failed:', error));
    replacedAssetCache.delete(cacheKey);
  }
  return { ok: true, inverse: cmd, created: [] };
}

registerApplier('document', 'restoreWrittenAsset', applyRestoreWrittenAsset as unknown as ApplierFn);

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
  // Fail Fast (asset name shares the basename SSOT with folders — same
  // asset-basename.ts rule set). NOTE on undo: if a legacy pack contains an
  // asset with an already-invalid name, undoing a rename BACK to that name
  // will trip this guard. That is intentional loud failure — the alternative
  // is silently re-writing a name that no filesystem-derived tooling can
  // round-trip. Clean up the legacy name first, then re-do the rename.
  const check = validateAssetBasename(newName);
  if (!check.ok) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: `renameAsset: ${check.hint}` } };
  }
  const key = _cacheKey(packPath, guid);
  // Fire the async rename; stash the replaced (old) name so the inverse can
  // restore it synchronously. A .catch guards against an unhandled rejection —
  // the op already landed in undo/ledger (D-1: the gateway is the only door).
  void ctx.assetIO.renamePackEntry(packPath, guid, newName).then((r) => {
    if (!r.ok) {
      console.warn('[editor-core] renameAsset IO failed; pack entry was not renamed:', { packPath, guid, newName });
      return;
    }
    if (r.oldName !== null) renamedNameCache.set(key, r.oldName);
    broadcastAssetsChanged('pack-changed', 'local-op', { kind: 'renamed', guid, name: newName });
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
    created: [],
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
      kind: 'destroyAsset', _resolvedPackPath: packPath, guid, newGuidCacheKey: key,
    } as unknown as EditorOp,
    created: [],
  };
}

registerApplier('document', 'renameAsset', applyRenameAsset as unknown as ApplierFn);
registerApplier('document', 'duplicateAsset', applyDuplicateAsset as unknown as ApplierFn);
