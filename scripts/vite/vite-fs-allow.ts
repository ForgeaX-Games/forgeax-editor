import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadKnownGames } from '../../packages/platform-io/src/api/lib/known-games.ts';

export type ResolveViteFsAllowRootsOptions = {
  /** Editor package / Vite config root (always allowed). */
  readonly packageDir: string;
  /** Active `--game` directory, if any. */
  readonly gameDir?: string | null;
  /** Additional roots (studio layer, edit-runtime package dir, etc.). */
  readonly extra?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
};

function addRoot(roots: Set<string>, candidate: string | null | undefined): void {
  if (candidate === null || candidate === undefined || candidate.trim() === '') return;
  const abs = resolve(candidate);
  if (existsSync(abs)) roots.add(abs);
}

/**
 * Aggregate Vite `server.fs.allow` roots for standalone/editor dev servers.
 *
 * External game directories (sibling `forgeax-games/`), per-game vite caches,
 * and the user-level known-games registry must be reachable or Play's `@fs`
 * imports and optimizer cache fetches 403.
 */
export function resolveViteFsAllowRoots(options: ResolveViteFsAllowRootsOptions): string[] {
  const env = options.env ?? process.env;
  const roots = new Set<string>();

  addRoot(roots, options.packageDir);
  for (const entry of options.extra ?? []) addRoot(roots, entry);
  addRoot(roots, options.gameDir);
  addRoot(roots, env.FORGEAX_VITE_CACHE_ROOT);

  const siblingGamesDir = resolve(options.packageDir, '..', 'forgeax-games');
  addRoot(roots, siblingGamesDir);

  for (const game of loadKnownGames()) {
    addRoot(roots, game.path);
  }

  return [...roots];
}
