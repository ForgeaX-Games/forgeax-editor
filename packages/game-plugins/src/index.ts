// Editor host adapter for asset-resident game plugins.
//
// The engine-app package owns the runtime policy: importing modules once,
// measuring ECS registry deltas, and attaching systems to a fresh Play World.
// This package owns only the editor-specific discovery seam (the game API tree
// and its stable URL space), so Edit and standalone Play cannot drift apart.

import {
  loadGamePluginModules,
  type GamePluginLoad,
  type GamePluginModule,
} from '@forgeax/engine-app';

export type { GamePluginLoad, GamePluginModule, LoadedGamePlugin } from '@forgeax/engine-app';
export type {
  GamePluginInstallResult,
  GamePluginInstallation,
  GamePluginSystemDiagnostic,
} from '@forgeax/engine-app';
export {
  addGamePluginSystems,
  describeGamePluginSystems,
  getPlayPluginFailure,
  installGamePluginProducers,
  loadGamePluginModules,
} from '@forgeax/engine-app';

export interface GamePluginDeps {
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
  readonly gameRoot: string;
  readonly resolveGameFsBase: () => Promise<string>;
}

interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: TreeNode[];
}

function collectPluginPaths(node: TreeNode | null): string[] {
  if (!node) return [];
  if (node.type === 'file') return node.name.endsWith('.plugin.ts') ? [node.path] : [];
  return (node.children ?? []).flatMap(collectPluginPaths);
}

async function listPluginFiles(deps: GamePluginDeps): Promise<string[]> {
  const assetsRoot = deps.gameRoot ? `${deps.gameRoot}/assets` : 'assets';
  const url = `/api/files/tree?root=${encodeURIComponent(assetsRoot)}&optional=1`;
  const response = await deps.fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`/api/files/tree HTTP ${response.status}`);
  const json = await response.json() as { tree?: TreeNode | null };
  return collectPluginPaths(json.tree ?? null).sort();
}

export function gamePluginImportUrl(clientPath: string, gameRoot: string, gameFsBase: string): string {
  const prefix = gameRoot ? `${gameRoot}/` : '';
  const relativePath = clientPath.startsWith(prefix) ? clientPath.slice(prefix.length) : clientPath;
  return `${gameFsBase}/${relativePath}`;
}

const loadCache = new Map<string, Promise<GamePluginLoad>>();

export async function ensureGamePluginsLoaded(deps: GamePluginDeps): Promise<GamePluginLoad> {
  const gameFsBase = await deps.resolveGameFsBase();
  const cached = loadCache.get(gameFsBase);
  if (cached) return cached;

  const pass = (async (): Promise<GamePluginLoad> => {
    let files: string[];
    try {
      files = await listPluginFiles(deps);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const assetsRoot = deps.gameRoot ? `${deps.gameRoot}/assets` : 'assets';
      console.warn('[editor] game-plugins: listing failed:', message);
      return {
        plugins: [],
        systems: [],
        components: [],
        errors: [{ clientPath: assetsRoot, message }],
      };
    }

    const modules: GamePluginModule[] = files.map((clientPath) => ({
      clientPath,
      url: gamePluginImportUrl(clientPath, deps.gameRoot, gameFsBase),
    }));
    return loadGamePluginModules({
      modules,
      importModule: (url) => import(/* @vite-ignore */ url),
    });
  })();

  loadCache.set(gameFsBase, pass);
  return pass;
}
