// Pack file CRUD operations (M2).
//
// All writes go through the server's POST /api/files. Reads use GET /api/files.
// Schema validation is deferred to engine load time — the editor reads pack
// files as loose JSON and preserves schemaVersion + kind verbatim.
//
// M1: PackAssetEntry/PackFile dual definitions deleted — import from scene-pack.ts
// SSOT (plan-strategy D-4, research Finding #9).

import { apiFetch } from '../io/api-client';
import { fetchWithTimeout } from '../io/net';
import { stableGuid, validatePackShell, type PackFile } from '../scene/scene-pack';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function readPack(packPath: string): Promise<PackFile | null> {
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

async function writePack(packPath: string, pack: PackFile): Promise<boolean> {
  try {
    // M1: validate pack shell before writing (AC-02 — plan-strategy D-1/D-3).
    // Bad packs are rejected — disk is never touched with invalid data.
    const validation = validatePackShell(pack);
    if (!validation.ok) {
      console.warn('[editor-core] writePack: pack shell validation failed — rejecting write', validation.error);
      return false;
    }
    const r = await apiFetch('/api/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: packPath, content: JSON.stringify(pack, null, 2) + '\n' }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function deleteFile(filePath: string): Promise<boolean> {
  try {
    const r = await apiFetch(`/api/files?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' });
    return r.ok;
  } catch {
    return false;
  }
}

// ── GUID generation ──────────────────────────────────────────────────────────

let guidCounter = 0;

/** Generate a new asset GUID. Uses stableGuid with a timestamp + counter seed
 *  so GUIDs are deterministic within a session but unique across time. */
export function generateAssetGuid(): string {
  return stableGuid(`editor-new|${Date.now()}|${guidCounter++}`);
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
    const r = await apiFetch('/api/files', {
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
    const r = await apiFetch('/api/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dirPath, content: '', mkdir: true }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
