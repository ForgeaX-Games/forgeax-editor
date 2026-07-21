// game-plugins.ts — load asset-resident game-logic plugins (`*.plugin.ts` under
// the game's assets/ root) into the ONE live engine registry, WITHOUT any code in
// the game's main.ts.
//
// WHY THIS EXISTS
// The engine already has every primitive: `defineComponent` / `defineSystem`
// register into a process-global registry as an import side effect, and the
// `gameEngineResolve` vite plugin (runtime-vite-preset.ts) re-anchors a game
// file's bare `@forgeax/*` imports to the editor's single engine instance. What
// was missing was the WIRING: nobody imported the game's `*.plugin.ts` files, so
// their components/systems never reached the editor's registry. This module is
// that wiring.
//
// EDIT vs PLAY (the one important asymmetry)
//   • EDIT: we import the plugin modules ONCE (stable tokens — no cache-bust) so
//     their COMPONENTS register. That makes `Rotator` attachable to an entity and
//     round-trippable through the scene pack (collect-scene-asset iterates every
//     registered component). We do NOT add the systems to the edit world — the
//     ball must not spin while you author.
//   • PLAY: the fresh play world calls `addGamePluginSystems(playWorld, …)`, which
//     `world.addSystem`s each plugin-defined system so `rotate` actually ticks.
//
// DERIVE, DON'T DUPLICATE: which systems a scene runs is DERIVED from which
// `*.plugin.ts` files exist under assets/ — it is NOT persisted per-scene. So
// there is no scene-schema change and no "which systems" field to keep in sync.
//
// Import stability: unlike editor-core's `discoverModules` (built for HOT RELOAD,
// so it cache-busts every import — which would mint a NEW component token each
// time and break identity between edit-attach, save, and play), this loader
// imports each module exactly once and memoizes the pass. Edit and play therefore
// share the same `Rotator` token and the same `rotate` handle.

import { getRegisteredComponents, getRegisteredSystems, Update } from '@forgeax/engine-ecs';
import type { World } from '@forgeax/engine-ecs';

/** One discovered plugin module's registration delta. */
export interface LoadedGamePlugin {
  /** Client-space path, e.g. `sample/assets/rotator.plugin.ts`. */
  readonly clientPath: string;
  /** `/@fs/…` URL the module was imported from. */
  readonly url: string;
  /** Component names this module newly registered. */
  readonly components: string[];
  /** System names this module newly registered. */
  readonly systems: string[];
}

/** Aggregate result of one plugin-load pass. */
export interface GamePluginLoad {
  readonly plugins: LoadedGamePlugin[];
  /** Union of every plugin-registered system name (what play adds to its world). */
  readonly systems: string[];
  /** Union of every plugin-registered component name. */
  readonly components: string[];
  /** Per-file import failures (graceful degradation — one bad plugin does not
   *  abort the others; the editor still boots). */
  readonly errors: Array<{ clientPath: string; message: string }>;
}

/** Explicit inputs (Pipeline Isolation — the headless test can fake all three). */
export interface GamePluginDeps {
  /** Platform fetch (deps.fetch) — same-origin `/api` router. */
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** Client-space game root (resolveGamePath('') — `<slug>` in standalone). */
  readonly gameRoot: string;
  /** Resolve the game dir's `/@fs/…` base URL (host-session.resolveGameFsBase). */
  readonly resolveGameFsBase: () => Promise<string>;
}

interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: TreeNode[];
}

/** Depth-first collect every `*.plugin.ts` leaf's client-space path. */
function collectPluginPaths(node: TreeNode | null): string[] {
  if (!node) return [];
  if (node.type === 'file') {
    return node.name.endsWith('.plugin.ts') ? [node.path] : [];
  }
  const out: string[] = [];
  for (const child of node.children ?? []) out.push(...collectPluginPaths(child));
  return out;
}

/**
 * List `assets/**\/*.plugin.ts` via the `/api/files/tree` router. `optional=1`
 * so a game with no assets dir yields `{ tree: null }` (no red 404), not an error.
 */
async function listPluginFiles(deps: GamePluginDeps): Promise<string[]> {
  const assetsRoot = deps.gameRoot ? `${deps.gameRoot}/assets` : 'assets';
  const url = `/api/files/tree?root=${encodeURIComponent(assetsRoot)}&optional=1`;
  const r = await deps.fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`/api/files/tree HTTP ${r.status}`);
  const j = (await r.json()) as { tree?: TreeNode | null };
  return collectPluginPaths(j.tree ?? null).sort();
}

/**
 * Turn a client-space plugin path (`<slug>/assets/x.plugin.ts`) into its `/@fs/…`
 * import URL. Strips the game-root prefix so the remainder is game-dir-relative
 * (`assets/x.plugin.ts`) and appends it to the game's `/@fs` base — the exact
 * shape host-session uses to import the bootstrap module, so the plugin file's
 * importer lives under the game dir and `gameEngineResolve` resolves its bare
 * `@forgeax/*` imports to the editor's single engine instance.
 */
function toImportUrl(clientPath: string, gameRoot: string, gameFsBase: string): string {
  const prefix = gameRoot ? `${gameRoot}/` : '';
  const rel = clientPath.startsWith(prefix) ? clientPath.slice(prefix.length) : clientPath;
  return `${gameFsBase}/${rel}`;
}

// Memoize the whole pass per game-fs base so edit boot + every ▶ Play reuse the
// SAME imported modules (stable tokens). Keyed by the base URL (stable per session).
const _loadCache = new Map<string, Promise<GamePluginLoad>>();

/**
 * Import every asset-resident `*.plugin.ts` exactly once, recording which
 * components/systems each registered (registry delta). Idempotent + memoized: a
 * second call returns the first pass's result, so component/system tokens never
 * change between edit and play. Import errors are collected per-file (graceful),
 * never thrown — a broken plugin must not black-hole the editor boot.
 */
export async function ensureGamePluginsLoaded(deps: GamePluginDeps): Promise<GamePluginLoad> {
  const gameFsBase = await deps.resolveGameFsBase();
  const cached = _loadCache.get(gameFsBase);
  if (cached) return cached;

  const pass = (async (): Promise<GamePluginLoad> => {
    const plugins: LoadedGamePlugin[] = [];
    const errors: Array<{ clientPath: string; message: string }> = [];
    const allSystems: string[] = [];
    const allComponents: string[] = [];

    let files: string[];
    try {
      files = await listPluginFiles(deps);
    } catch (e) {
      // No listing → no plugins (graceful). Surface once for diagnosis.
      console.warn('[editor] game-plugins: listing failed:', e instanceof Error ? e.message : e);
      return { plugins: [], systems: [], components: [], errors: [] };
    }

    for (const clientPath of files) {
      const url = toImportUrl(clientPath, deps.gameRoot, gameFsBase);
      const beforeComps = new Map(getRegisteredComponents());
      const beforeSystems = new Map(getRegisteredSystems());
      try {
        // No cache-bust: import ONCE for stable tokens (contrast discoverer.ts,
        // which cache-busts for hot reload). @vite-ignore — the URL is dynamic.
        await import(/* @vite-ignore */ url);
      } catch (e) {
        errors.push({ clientPath, message: e instanceof Error ? e.message : String(e) });
        continue;
      }

      const comps: string[] = [];
      for (const k of getRegisteredComponents().keys()) {
        if (!beforeComps.has(k)) comps.push(k);
      }
      const systems: string[] = [];
      for (const k of getRegisteredSystems().keys()) {
        if (!beforeSystems.has(k)) systems.push(k);
      }
      plugins.push({ clientPath, url, components: comps, systems });
      allComponents.push(...comps);
      allSystems.push(...systems);
    }

    return { plugins, systems: allSystems, components: allComponents, errors };
  })();

  _loadCache.set(gameFsBase, pass);
  return pass;
}

/**
 * Add every plugin-registered system to a world (▶ Play only). Looks each name up
 * in the process-global system registry (populated by ensureGamePluginsLoaded's
 * imports) and `world.addSystem`s the handle. Unknown names are skipped
 * defensively. Returns the names actually added.
 */
export function addGamePluginSystems(world: World, load: GamePluginLoad): string[] {
  const added: string[] = [];
  const registry = getRegisteredSystems();
  for (const name of load.systems) {
    const handle = registry.get(name);
    if (handle) {
      world.addSystem(Update, handle).unwrap();
      added.push(name);
    }
  }
  return added;
}
