// Asset loading for the editor — reads the OPEN game's `.pack.json` files (the
// asset system: material / texture / mesh assets, keyed by GUID) so the Assets
// panel can browse + preview them, and so a Material.materialAsset GUID can be
// resolved to a real engine material handle WITHOUT relying on a configured
// pack-index (the editor's is empty): we register the material straight from the
// pack payload's paramValues. Reached through the server's /api/files{,/tree}
// (same-origin via the interface proxy).
import { Materials } from '@forgeax/engine-runtime';

export interface PackAsset {
  guid: string;
  /** 'material' | 'texture' | 'mesh' | … (whatever the pack declares). */
  kind: string;
  name: string;
  payload: Record<string, unknown>;
  packPath: string;
}

interface TreeNode { name: string; path: string; type: 'dir' | 'file'; children?: TreeNode[] }

async function packPaths(slug: string): Promise<string[]> {
  const root = `.forgeax/games/${slug}/assets`;
  try {
    const r = await fetch(`/api/files/tree?root=${encodeURIComponent(root)}`);
    if (!r.ok) return [];
    const j = (await r.json()) as { tree?: TreeNode };
    const out: string[] = [];
    const walk = (n?: TreeNode): void => {
      if (!n) return;
      if (n.type === 'file' && n.name.endsWith('.pack.json')) out.push(n.path);
      n.children?.forEach(walk);
    };
    walk(j.tree);
    return out;
  } catch {
    return [];
  }
}

/** Every `*.pack.json` under the WHOLE game dir (not just assets/) — needed to
 *  find scene packs that live in `scenes/` or at the game root, which `packPaths`
 *  (assets-only) never sees. */
async function allGamePackPaths(slug: string): Promise<string[]> {
  const root = `.forgeax/games/${slug}`;
  try {
    const r = await fetch(`/api/files/tree?root=${encodeURIComponent(root)}`);
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
 * `scenes/rogue-encampment.pack.json`). This is how the editor opens the SAME
 * scene ▶ Play boots, instead of falling back to a stray legacy `scene.pack.json`.
 * Returns null when the GUID isn't found in any pack (caller keeps legacy mode).
 */
export async function findScenePackByGuid(
  slug: string | null | undefined,
  guid: string | null | undefined,
): Promise<string | null> {
  if (!slug || slug === 'default' || !guid) return null;
  const prefix = `.forgeax/games/${slug}/`;
  for (const p of await allGamePackPaths(slug)) {
    try {
      const r = await fetch(`/api/files?path=${encodeURIComponent(p)}`);
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
    const root = `.forgeax/games/${slug}/assets`;
    const r = await fetch(`/api/files/tree?root=${encodeURIComponent(root)}`);
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

/** Load + flatten every asset declared in the game's *.pack.json files. */
export async function loadGameAssets(slug: string | null | undefined): Promise<PackAsset[]> {
  if (!slug || slug === 'default') return [];
  const paths = await packPaths(slug);
  const out: PackAsset[] = [];
  for (const p of paths) {
    try {
      const r = await fetch(`/api/files?path=${encodeURIComponent(p)}`);
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
        ...(Array.isArray(pv.emissive) ? { emissive: pv.emissive as number[], emissiveIntensity: typeof pv.emissiveIntensity === 'number' ? pv.emissiveIntensity : 1 } : {}),
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
