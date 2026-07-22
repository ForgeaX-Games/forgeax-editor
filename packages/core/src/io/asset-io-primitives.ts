// Low-level pack and sidecar IO primitives.
//
// This module deliberately has no gateway/applier/session imports. AssetIOFacade
// and the session CRUD appliers may both depend on it without forming a cycle.
// All callers that mutate authored asset data still go through AssetIOFacade;
// session/pack-ops re-exports these helpers for its legacy session surface.

import { fetchWithTimeout } from './net';
import { validatePackShell, type PackFile } from '../scene/scene-pack';
import { AssetGuid } from '@forgeax/engine-pack/guid';

export async function readPack(packPath: string): Promise<PackFile | null> {
  try {
    const r = await fetchWithTimeout(`/api/files?path=${encodeURIComponent(packPath)}`);
    if (!r.ok) return null;
    const j = (await r.json()) as { content?: string };
    if (!j.content) return null;
    const parsed = JSON.parse(j.content);
    const result = validatePackShell(parsed);
    return result.ok ? result.pack : null;
  } catch {
    return null;
  }
}

export async function writePack(packPath: string, pack: PackFile): Promise<boolean> {
  try {
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

/** Mint a fresh asset GUID through the engine's authoritative generator. */
export function generateAssetGuid(): string {
  return AssetGuid.format(AssetGuid.random());
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

/** Delete one asset entry from a pack or sidecar. */
export async function deleteAsset(packPath: string, guid: string): Promise<boolean> {
  if (packPath.endsWith('.meta.json')) return deleteMetaAsset(packPath, guid);
  const pack = await readPack(packPath);
  if (!pack) return false;
  pack.assets = pack.assets.filter(a => a.guid !== guid);
  if (pack.assets.length === 0) return deleteFile(packPath);
  return writePack(packPath, pack);
}

/** One sub-asset entry inside a .meta.json sidecar. */
export interface MetaSubAsset {
  guid: string;
  kind: string;
  sourceIndex: number;
  name?: string;
  [k: string]: unknown;
}

export async function readMetaSubAsset(metaPath: string, guid: string): Promise<MetaSubAsset | null> {
  const meta = await readJsonFile(metaPath);
  const subs = meta?.subAssets as MetaSubAsset[] | undefined;
  if (!Array.isArray(subs)) return null;
  return subs.find(s => s.guid === guid) ?? null;
}

export async function writeMetaSubAsset(metaPath: string, entry: MetaSubAsset): Promise<boolean> {
  const meta = await readJsonFile(metaPath);
  const subs = meta?.subAssets as MetaSubAsset[] | undefined;
  if (!meta || !Array.isArray(subs)) return false;
  const idx = subs.findIndex(s => s.guid === entry.guid);
  if (idx >= 0) subs[idx] = entry;
  else subs.push(entry);
  return writeJsonFile(metaPath, meta);
}

export async function renameMetaSubAsset(
  metaPath: string,
  guid: string,
  newName: string,
): Promise<{ ok: boolean; oldName: string | null }> {
  const meta = await readJsonFile(metaPath);
  const subs = meta?.subAssets as MetaSubAsset[] | undefined;
  if (!meta || !Array.isArray(subs)) return { ok: false, oldName: null };
  const entry = subs.find(s => s.guid === guid);
  if (!entry) return { ok: false, oldName: null };
  const oldName = entry.name ?? null;
  entry.name = newName;
  const ok = await writeJsonFile(metaPath, meta);
  return { ok, oldName };
}
