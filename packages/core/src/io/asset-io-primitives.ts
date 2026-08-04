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
  const result = await readPackDetailed(packPath);
  return result.status === 'ok' ? result.pack : null;
}

/** Diagnosable pack read. Distinguishes the three states the boolean-ish
 *  `readPack` collapses into one `null`: the file is genuinely ABSENT (safe to
 *  create) versus the file EXISTS but could not be read/validated (a fresh
 *  empty pack written over it would be data loss). */
export type PackReadResult =
  | { readonly status: 'ok'; readonly pack: PackFile }
  | { readonly status: 'missing' }
  | { readonly status: 'error'; readonly hint: string };

export async function readPackDetailed(packPath: string): Promise<PackReadResult> {
  let r: Response;
  try {
    r = await fetchWithTimeout(`/api/files?path=${encodeURIComponent(packPath)}`);
  } catch (e) {
    return { status: 'error', hint: `pack read network error: ${(e as Error)?.message ?? String(e)}` };
  }
  if (r.status === 404) return { status: 'missing' };
  if (!r.ok) return { status: 'error', hint: `pack read failed (HTTP ${r.status})` };
  let content: string;
  try {
    const j = (await r.json()) as { content?: unknown };
    if (typeof j.content !== 'string' || j.content.length === 0) return { status: 'missing' };
    content = j.content;
  } catch (e) {
    return { status: 'error', hint: `pack read envelope parse failed: ${(e as Error)?.message ?? String(e)}` };
  }
  try {
    const parsed = JSON.parse(content);
    const result = validatePackShell(parsed);
    return result.ok
      ? { status: 'ok', pack: result.pack }
      : { status: 'error', hint: `pack shell validation failed: ${result.error.message}` };
  } catch (e) {
    return { status: 'error', hint: `pack JSON parse failed: ${(e as Error)?.message ?? String(e)}` };
  }
}

export type PackWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly hint: string };

export async function writePack(packPath: string, pack: PackFile): Promise<boolean> {
  return (await writePackDetailed(packPath, pack)).ok;
}

/** Diagnosable pack write — same contract as `writePack` but reports WHY a
 *  write was rejected (shell validation / HTTP status / network) so the write
 *  gate can surface a structured failure instead of a bare `false`. */
export async function writePackDetailed(packPath: string, pack: PackFile): Promise<PackWriteResult> {
  const validation = validatePackShell(pack);
  if (!validation.ok) {
    console.warn('[editor-core] writePack: pack shell validation failed — rejecting write', validation.error);
    return { ok: false, hint: `pack shell validation failed before write: ${validation.error.message}` };
  }
  try {
    const r = await fetch('/api/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: packPath, content: JSON.stringify(pack, null, 2) + '\n' }),
    });
    return r.ok
      ? { ok: true }
      : { ok: false, hint: `pack write failed (HTTP ${r.status})` };
  } catch (e) {
    return { ok: false, hint: `pack write network error: ${(e as Error)?.message ?? String(e)}` };
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

export type MetaSourceScope =
  | { readonly sourceKey: string; readonly all?: false }
  | { readonly all: true; readonly sourceKey?: never };

export interface MetaSourceOverrideMutation {
  readonly scope: MetaSourceScope;
  readonly override?: unknown;
  readonly discard?: boolean;
}

/** Parse a sidecar without dropping fields owned by the producer or editor. */
export function parseMetaDocument(contents: string): Record<string, unknown> {
  const value = JSON.parse(contents) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Meta sidecar must contain a JSON object');
  }
  return { ...(value as Record<string, unknown>) };
}

/** Serialize a sidecar with stable human-readable formatting. */
export function serializeMetaDocument(document: Record<string, unknown>): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Apply only the sourceOverrides field, preserving every other Meta field. */
export function mutateMetaSourceOverrides(
  document: Record<string, unknown>,
  mutation: MetaSourceOverrideMutation,
): Record<string, unknown> {
  const current = document.sourceOverrides;
  const sourceOverrides = current !== null && typeof current === 'object' && !Array.isArray(current)
    ? { ...(current as Record<string, unknown>) }
    : {};
  if (mutation.scope.all === true) {
    if (mutation.discard === true) delete document.sourceOverrides;
    else document.sourceOverrides = { ...(mutation.override as Record<string, unknown>) };
    return document;
  }
  if (mutation.discard === true) delete sourceOverrides[mutation.scope.sourceKey];
  else sourceOverrides[mutation.scope.sourceKey] = mutation.override;
  if (Object.keys(sourceOverrides).length === 0) delete document.sourceOverrides;
  else document.sourceOverrides = sourceOverrides;
  return document;
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
