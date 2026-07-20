// Asset loading for the editor — reads the OPEN game's `.pack.json` files (the
// asset system: material / texture / mesh assets, keyed by GUID) so the Assets
// panel can browse + preview them. Reached through the server's /api/files{,/tree}
// (same-origin via the interface proxy).
import { fetchWithTimeout } from '../io/net';
import { resolveGamePath } from '../util/path-resolver';

export interface PackAsset {
  guid: string;
  /** 'material' | 'texture' | 'mesh' | … (whatever the pack declares). */
  kind: string;
  name: string;
  payload: Record<string, unknown>;
  packPath: string;
}

interface TreeNode { name: string; path: string; type: 'dir' | 'file'; children?: TreeNode[] }

/** Every `*.pack.json` under the WHOLE game dir — needed to find scene packs
 *  regardless of where they live (A2: scenes are ordinary assets, discovered
 *  by `kind` field, not by directory name). */
async function allGamePackPaths(_slug: string): Promise<string[]> {
  const root = resolveGamePath('');
  try {
    const r = await fetchWithTimeout(`/api/files/tree?root=${encodeURIComponent(root)}`);
    if (!r.ok) return [];
    const j = (await r.json()) as { tree?: TreeNode };
    const out: string[] = [];
    const walk = (n?: TreeNode): void => {
      if (!n) return;
      // Skip dirs that never hold authored scene packs (and could be huge).
      if (n.type === 'dir' && (n.name === 'node_modules' || n.name === '.git')) return;
      if (n.type === 'file' && n.name.endsWith('.pack.json')) out.push(n.path);
      n.children?.forEach(walk);
    };
    walk(j.tree);
    return out;
  } catch {
    return [];
  }
}

/**
 * Resolve the engine SSOT `forge.json.defaultScene` (a scene GUID) to the
 * game-relative pack path that DECLARES that scene asset (e.g.
 * `scenes/rogue-encampment.pack.json` or `assets/scene.pack.json`). This is the
 * canonical scene-as-asset path: a scene is a GUID-keyed asset, and the editor
 * opens the SAME scene ▶ Play boots by resolving that GUID — the engine's own
 * templates/game-default ships this shape (`assets/scene.pack.json` + defaultScene).
 * Returns null when the GUID isn't found in any pack (caller falls back to LEGACY
 * single-scene mode: a top-level `scene.pack.json` with no defaultScene GUID).
 */
export async function findScenePackByGuid(
  slug: string | null | undefined,
  guid: string | null | undefined,
): Promise<string | null> {
  if (!slug || slug === 'default' || !guid) return null;
  // Game root (host-resolved) → strip it so callers get a game-relative pack path.
  const root = resolveGamePath('');
  const prefix = root.endsWith('/') ? root : `${root}/`;
  for (const p of await allGamePackPaths(slug)) {
    try {
      const r = await fetchWithTimeout(`/api/files?path=${encodeURIComponent(p)}`);
      if (!r.ok) continue;
      const j = (await r.json()) as { content?: string };
      if (!j.content) continue;
      const parsed = JSON.parse(j.content) as { assets?: Array<{ guid?: string; kind?: string }> };
      const hit = Array.isArray(parsed.assets)
        && parsed.assets.some((a) => a?.kind === 'scene' && a?.guid === guid);
      if (hit) return p.startsWith(prefix) ? p.slice(prefix.length) : p;
    } catch { /* unparseable pack — skip */ }
  }
  return null;
}

/**
 * Discover ALL scene packs in the game by scanning every `*.pack.json` and
 * filtering by `kind === 'scene'` (A2: scenes are ordinary assets, found by
 * kind field, not by directory convention). Returns game-relative pack paths
 * with their scene GUIDs. Used by `initSceneList` at boot (before the engine
 * AssetRegistry is available).
 */
export async function findAllScenePacks(
  slug: string | null | undefined,
): Promise<{ pack: string; guid: string }[]> {
  if (!slug || slug === 'default') return [];
  const root = resolveGamePath('');
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const results: { pack: string; guid: string }[] = [];
  for (const p of await allGamePackPaths(slug)) {
    try {
      const r = await fetchWithTimeout(`/api/files?path=${encodeURIComponent(p)}`);
      if (!r.ok) continue;
      const j = (await r.json()) as { content?: string };
      if (!j.content) continue;
      const parsed = JSON.parse(j.content) as { assets?: Array<{ guid?: string; kind?: string }> };
      const sceneAsset = Array.isArray(parsed.assets)
        ? parsed.assets.find((a) => a?.kind === 'scene')
        : undefined;
      if (sceneAsset?.guid) {
        const rel = p.startsWith(prefix) ? p.slice(prefix.length) : p;
        results.push({ pack: rel, guid: sceneAsset.guid });
      }
    } catch { /* unparseable pack — skip */ }
  }
  return results;
}

/** A raw imported file (GLB/PNG/audio) that lives in assets/ but hasn't been
 *  processed into a pack yet, or a processed GLB whose meta.json exists. */
export interface RawAsset {
  kind: 'raw-model' | 'raw-image' | 'raw-audio' | 'raw-other';
  name: string;
  path: string;
  /** true when <path>.meta.json exists alongside (GLB has been imported). */
  processed?: boolean;
}

const RAW_EXTS: Record<string, RawAsset['kind']> = {
  '.glb': 'raw-model', '.gltf': 'raw-model',
  '.png': 'raw-image', '.jpg': 'raw-image', '.jpeg': 'raw-image', '.hdr': 'raw-image',
  '.mp3': 'raw-audio', '.wav': 'raw-audio', '.ogg': 'raw-audio', '.aac': 'raw-audio',
};

/** Load raw imported files from the game's assets/ folder (non-pack.json). */
export async function loadRawAssets(slug: string | null | undefined): Promise<RawAsset[]> {
  if (!slug || slug === 'default') return [];
  try {
    const root = resolveGamePath('assets');
    const r = await fetchWithTimeout(`/api/files/tree?root=${encodeURIComponent(root)}`);
    if (!r.ok) return [];
    const j = (await r.json()) as { tree?: TreeNode };
    const out: RawAsset[] = [];
    const metaPaths = new Set<string>();
    const walk = (n?: TreeNode): void => {
      if (!n) return;
      if (n.type === 'file' && n.name.endsWith('.meta.json')) metaPaths.add(n.path);
      n.children?.forEach(walk);
    };
    walk(j.tree);
    const walkFiles = (n?: TreeNode): void => {
      if (!n) return;
      if (n.type === 'file' && !n.name.endsWith('.pack.json') && !n.name.endsWith('.meta.json')) {
        const ext = n.name.slice(n.name.lastIndexOf('.')).toLowerCase();
        const kind = RAW_EXTS[ext] ?? 'raw-other';
        out.push({ kind, name: n.name, path: n.path, processed: metaPaths.has(`${n.path}.meta.json`) });
      }
      n.children?.forEach(walkFiles);
    };
    walkFiles(j.tree);
    return out;
  } catch {
    return [];
  }
}

/** Extract unique directory paths from pack asset paths, for building a folder tree. */
export function extractPackDirs(assets: PackAsset[]): string[] {
  const dirs = new Set<string>();
  for (const a of assets) {
    const dir = a.packPath.replace(/\/[^/]+$/, '');
    let cur = dir;
    while (cur) {
      dirs.add(cur);
      const slash = cur.lastIndexOf('/');
      cur = slash > 0 ? cur.slice(0, slash) : '';
    }
  }
  return [...dirs].sort();
}

/** CSS color for a material asset's base color (for the panel swatch), or null. */
export function materialSwatch(a: PackAsset): string | null {
  if (a.kind !== 'material') return null;
  const pv = a.payload.paramValues as Record<string, unknown> | undefined;
  const c = pv?.baseColor;
  if (!Array.isArray(c)) return null;
  const u = (v: unknown) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 255);
  return `rgb(${u(c[0])}, ${u(c[1])}, ${u(c[2])})`;
}

