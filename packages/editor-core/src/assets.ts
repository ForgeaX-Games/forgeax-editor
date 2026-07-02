// Asset loading for the editor — reads the OPEN game's `.pack.json` files (the
// asset system: material / texture / mesh assets, keyed by GUID) so the Assets
// panel can browse + preview them, and so a Material.materialAsset GUID can be
// resolved to a real engine material handle WITHOUT relying on a configured
// pack-index (the editor's is empty): we register the material straight from the
// pack payload's paramValues. Reached through the server's /api/files{,/tree}
// (same-origin via the interface proxy).
import { Materials } from '@forgeax/engine-runtime';
import { fetchWithTimeout } from './net';
import { resolveGamePath } from './path-resolver';

export interface PackAsset {
  guid: string;
  /** 'material' | 'texture' | 'mesh' | … (whatever the pack declares). */
  kind: string;
  name: string;
  payload: Record<string, unknown>;
  packPath: string;
}

interface TreeNode { name: string; path: string; type: 'dir' | 'file'; children?: TreeNode[] }

/** Every `*.pack.json` under the WHOLE game dir (not just assets/) — needed to
 *  find scene packs that live in `scenes/` or at the game root. */
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

/** Load + flatten every asset declared in the game's *.pack.json files.
 *  Scans the ENTIRE game directory (assets/, scenes/, root) so materials
 *  embedded in scene packs are also discovered. */
export async function loadGameAssets(slug: string | null | undefined): Promise<PackAsset[]> {
  if (!slug || slug === 'default') return [];
  const paths = await allGamePackPaths(slug);
  const out: PackAsset[] = [];
  for (const p of paths) {
    try {
      const r = await fetchWithTimeout(`/api/files?path=${encodeURIComponent(p)}`);
      if (!r.ok) continue;
      const j = (await r.json()) as { content?: string };
      if (!j.content) continue;
      const pack = JSON.parse(j.content) as { assets?: { guid: string; kind: string; payload?: Record<string, unknown> }[] };
      for (const a of pack.assets ?? []) {
        if (!a.guid) continue;
        out.push({ guid: a.guid, kind: a.kind, name: shortName(a, p), payload: a.payload ?? {}, packPath: p });
      }
    } catch {
      /* skip unreadable/malformed pack */
    }
  }
  return out;
}

interface MetaJson {
  schemaVersion?: string | number;
  kind?: string;
  importer?: string;
  source?: string;
  importSettings?: Record<string, unknown>;
  subAssets?: { guid: string; sourceIndex: number; kind: string; name?: string }[];
}

/** Load sub-assets declared in .meta.json sidecars across the entire game tree.
 *  These represent imported external binary assets (textures, meshes, audio, fonts). */
export async function loadMetaAssets(slug: string | null | undefined): Promise<PackAsset[]> {
  if (!slug || slug === 'default') return [];
  const root = resolveGamePath('');
  try {
    const r = await fetchWithTimeout(`/api/files/tree?root=${encodeURIComponent(root)}`);
    if (!r.ok) return [];
    const j = (await r.json()) as { tree?: TreeNode };
    const metaPaths: string[] = [];
    const walk = (n?: TreeNode): void => {
      if (!n) return;
      if (n.type === 'dir' && (n.name === 'node_modules' || n.name === '.git')) return;
      if (n.type === 'file' && n.name.endsWith('.meta.json')) metaPaths.push(n.path);
      n.children?.forEach(walk);
    };
    walk(j.tree);

    const out: PackAsset[] = [];
    for (const mp of metaPaths) {
      try {
        const res = await fetchWithTimeout(`/api/files?path=${encodeURIComponent(mp)}`);
        if (!res.ok) continue;
        const body = (await res.json()) as { content?: string };
        if (!body.content) continue;
        const meta = JSON.parse(body.content) as MetaJson;
        if (meta.kind !== 'external-asset-package' || !Array.isArray(meta.subAssets)) continue;
        const stem = meta.source
          ? meta.source.replace(/\.[^.]+$/, '')
          : mp.replace(/\.meta\.json$/, '').replace(/^.*\//, '');
        for (const sub of meta.subAssets) {
          if (!sub.guid) continue;
          const normalizedKind = sub.kind === 'image' ? 'texture' : sub.kind;
          const subRec = sub as Record<string, unknown>;
          out.push({
            guid: sub.guid,
            kind: normalizedKind,
            name: sub.name ?? `${stem} · ${sub.guid.slice(0, 8)}`,
            payload: {
              importer: meta.importer,
              source: meta.source,
              importSettings: meta.importSettings,
              ...(subRec.width != null ? { width: subRec.width } : {}),
              ...(subRec.height != null ? { height: subRec.height } : {}),
              ...(subRec.format != null ? { format: subRec.format } : {}),
            },
            packPath: mp,
          });
        }
      } catch { /* skip unreadable meta */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** A friendly label for a sub-pack asset row: "<pack-stem> · <guid8>".
 *  e.g. `level1 · 1c720a13`, `grasscalf · b73e4290`. The pack stem tells
 *  a human which level / monster / character / effect the material came
 *  from — much more useful than `material 1c720a13` in a 50-row list. */
function shortName(
  a: { guid: string; kind: string; payload?: Record<string, unknown> },
  packPath?: string,
): string {
  const stem = packPath
    ? packPath.replace(/^.*\//, '').replace(/\.(fx|pack)\.json$/i, '').replace(/\.json$/i, '')
    : '';
  const tail = a.guid.slice(0, 8);
  return stem ? `${stem} · ${tail}` : `${a.kind} ${tail}`;
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

/** Minimal slice of the engine World used for asset allocation. The engine
 *  removed AssetRegistry.register; shared assets are now minted via
 *  `world.allocSharedRef(brand, payload)` which returns a u32 column handle
 *  directly (no Result / no .unwrap()). */
interface WorldLike { allocSharedRef(target: string, payload: unknown): unknown }

/** CSS color for a material asset's base color (for the panel swatch), or null. */
export function materialSwatch(a: PackAsset): string | null {
  if (a.kind !== 'material') return null;
  const pv = a.payload.paramValues as Record<string, unknown> | undefined;
  const c = pv?.baseColor;
  if (!Array.isArray(c)) return null;
  const u = (v: unknown) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 255);
  return `rgb(${u(c[0])}, ${u(c[1])}, ${u(c[2])})`;
}

/** Mint an engine material handle from a pack material payload. */
function registerMaterial(world: WorldLike, payload: Record<string, unknown>): unknown {
  const pv = (payload.paramValues as Record<string, unknown> | undefined) ?? {};
  const base = Array.isArray(pv.baseColor) ? (pv.baseColor as number[]) : [0.8, 0.8, 0.8, 1];
  const passes = payload.passes as { shader?: string }[] | undefined;
  const shader = passes?.[0]?.shader ?? '';
  const desc = /unlit/i.test(shader)
    ? Materials.unlit(base as [number, number, number, number])
    : Materials.standard({
        baseColor: base as [number, number, number, number],
        roughness: typeof pv.roughness === 'number' ? pv.roughness : 0.8,
        metallic: typeof pv.metallic === 'number' ? pv.metallic : 0,
        ...(Array.isArray(pv.emissive) ? { emissive: pv.emissive as [number, number, number], emissiveIntensity: typeof pv.emissiveIntensity === 'number' ? pv.emissiveIntensity : 1 } : {}),
      });
  return world.allocSharedRef('MaterialAsset', desc);
}

/** Build a sync GUID→material-handle resolver (for instantiateScene). Material
 *  handles are registered on first use + cached. GUIDs absent from the loaded
 *  packs return null → the instantiator falls back to the entity's inline PBR. */
export function makeMaterialResolver(world: WorldLike, packAssets: PackAsset[]): (guid: string) => unknown | null {
  const byGuid = new Map(packAssets.filter((a) => a.kind === 'material').map((a) => [a.guid, a]));
  const cache = new Map<string, unknown>();
  return (guid: string) => {
    if (cache.has(guid)) return cache.get(guid)!;
    const a = byGuid.get(guid);
    if (!a) return null;
    const h = registerMaterial(world, a.payload);
    cache.set(guid, h);
    return h;
  };
}

/** Build a sync GUID→mesh-handle resolver (for instantiateScene's Mesh.meshAsset).
 *  Two sources, in priority order:
 *    1. `preloaded` — handles minted from imported mesh sub-assets that live in
 *       .meta.json/DDC (NOT *.pack.json), loaded async via the runtime asset
 *       registry (loadByGuid → allocSharedRef) and populated by the caller. This
 *       is how a dragged glTF mesh sub-asset renders.
 *    2. `packAssets` — mesh assets present in the game's loaded *.pack.json files.
 *  GUIDs absent from both return null → the instantiator falls back to the
 *  entity's builtin `kind` (placeholder cube). Mirrors makeMaterialResolver so the
 *  instantiator stays synchronous. */
export function makeMeshResolver(
  world: WorldLike,
  packAssets: PackAsset[],
  preloaded?: ReadonlyMap<string, unknown>,
): (guid: string) => unknown | null {
  const byGuid = new Map(packAssets.filter((a) => a.kind === 'mesh').map((a) => [a.guid, a]));
  const cache = new Map<string, unknown>();
  return (guid: string) => {
    const pre = preloaded?.get(guid);
    if (pre !== undefined) return pre;
    if (cache.has(guid)) return cache.get(guid)!;
    const a = byGuid.get(guid);
    if (!a) return null;
    const h = world.allocSharedRef('MeshAsset', a.payload);
    cache.set(guid, h);
    return h;
  };
}
