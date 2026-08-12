// edit-runtime vite config — the Edit-mode iframe/dev server (:15280, base
// '/editor/'). Independent dev + e2e webServer entry (`bun -F edit-runtime dev`).
//
// The engine-serve mechanism (forgeaxShader emit, scoped pluginPack middleware,
// base-strip, preserveSymlinks, optimizeDeps.exclude
// @forgeax family, build.target esnext) lives in the editor-level
// engine-vite-preset so the
// :15290 host config can serve the engine in-process too. This config CONSUMES
// that preset and keeps only its edit-runtime-specific parts: root,
// base '/editor/', hmr.clientPort, the --game /api + /preview proxies, and the
// fs.allow for the injected --game dir.

import { defineConfig } from 'vite';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { ENGINE_EXECUTION_ISOLATION_HEADERS, engineVitePreset } from '../../scripts/vite/engine-vite-preset';
import { readWorktreePorts, resolveWorktreePorts } from '../../scripts/lib/worktree-ports';
import { runtimeScopePath, type RuntimeAssetBinding } from '@forgeax/engine-types';

const here = dirname(fileURLToPath(import.meta.url));
const worktreeRoot = resolve(here, '../..');
const worktreePorts = resolveWorktreePorts(worktreeRoot);
const assignedWorktreePorts = readWorktreePorts(worktreeRoot);

const PORT = Number(process.env.FORGEAX_EDITOR_PORT ?? worktreePorts.editRuntime);
const HOST = process.env.FORGEAX_EDITOR_HOST ?? '0.0.0.0';
const BASE = '/editor/';
const BASE_PATH = BASE.replace(/\/$/, '');

// ── standalone `--game DIR` game root (abs) ───────────────────────────────────
// The Play resolver (main.tsx resolveGameModuleForPlay) imports the game entry
// through edit vite's `/editor/@fs<abs>/…` so its @forgeax/engine-* imports bind
// to THIS runtime's single engine instance. It needs the game's abs dir; also
// feeds engineVitePreset's self-hosted pluginPack (Part C standalone catalog).
// null when embedded in studio -> resolver keeps its legacy branch; preset skips
// the self-hosted pluginPack (studio's /preview proxy owns the catalog).
const GAME_DIR_ABS = process.env.FORGEAX_GAME_DIR
  ? resolve(process.env.FORGEAX_GAME_DIR)
  : null;
// Game slug = basename of the --game dir (the game-backend addresses files by
// <slug>/<rel>). The dev entry passes it to ViewportComponent as props; null
// (no --game / embedded studio) -> empty scene.
const GAME_SLUG = GAME_DIR_ABS ? basename(GAME_DIR_ABS) : null;
const SELF_HOST_PACK = GAME_DIR_ABS !== null;
const STANDALONE_SCOPE_ID = process.env.FORGEAX_RUNTIME_SCOPE_ID
  ?? (GAME_SLUG === null ? '' : `edit-${GAME_SLUG}`);
const STANDALONE_GENERATION = Number(process.env.FORGEAX_RUNTIME_GENERATION ?? 1);
const STANDALONE_RUNTIME_BINDING: RuntimeAssetBinding | undefined = (
  GAME_DIR_ABS !== null
  && GAME_SLUG !== null
  && /^[a-zA-Z0-9._:-]{1,256}$/.test(STANDALONE_SCOPE_ID)
  && Number.isSafeInteger(STANDALONE_GENERATION)
  && STANDALONE_GENERATION > 0
) ? {
  schemaVersion: 'runtime-asset-binding-v1',
  gameId: GAME_SLUG,
  scopeId: STANDALONE_SCOPE_ID,
  generation: STANDALONE_GENERATION,
  status: 'ready',
  catalogUrl: `${BASE_PATH}${runtimeScopePath({ scopeId: STANDALONE_SCOPE_ID, generation: STANDALONE_GENERATION }, 'catalog.json')}`,
  importUrlBase: `${BASE_PATH}${runtimeScopePath({ scopeId: STANDALONE_SCOPE_ID, generation: STANDALONE_GENERATION }, 'import')}`,
  packageUrlBase: `${BASE_PATH}${runtimeScopePath({ scopeId: STANDALONE_SCOPE_ID, generation: STANDALONE_GENERATION }, 'asset')}`,
} : undefined;

// D7: the shared engine-serve fragment (shader/pack serve + optimizeDeps.exclude
// + preserveSymlinks + build.target esnext). base '/editor/' so its base-strip
// middleware is included; gameDirAbs threads the self-hosted pluginPack catalog.
const enginePreset = engineVitePreset({
  base: BASE,
  gameDirAbs: GAME_DIR_ABS,
  // The iframe is now a real carrier boundary, so this host no longer needs
  // symlink identity to distinguish it from the outer shell. Resolve workspace
  // packages to their producer realpaths: Bun/pnpm keep transitive dependencies
  // beside those realpaths, while the preserved virtual @forgeax path cannot
  // see peers such as parse5/entities or css-tree/source-map-js.
  preserveSymlinks: false,
  ...(STANDALONE_RUNTIME_BINDING === undefined ? {} : { runtimeBinding: STANDALONE_RUNTIME_BINDING }),
});

export default defineConfig({
  root: here,
  base: BASE,
  cacheDir: resolve(here, '.vite'),
  publicDir: resolve(here, 'public'),
  // Expose the standalone `--game DIR` abs path to the client so the Play
  // resolver builds its `@fs<abs>` game-entry URL without the studio-only
  // `/api/health` round-trip. null (embedded studio) -> resolver legacy branch.
  define: {
    __FORGEAX_GAME_DIR_ABS__: JSON.stringify(GAME_DIR_ABS),
    __FORGEAX_GAME_SLUG__: JSON.stringify(GAME_SLUG),
    __FORGEAX_RUNTIME_BINDING__: JSON.stringify(STANDALONE_RUNTIME_BINDING ?? null),
    __FORGEAX_CATALOG_ASSET_ROOTS__: JSON.stringify(enginePreset.catalogRoots),
  },
  plugins: [
    react(),
    ...enginePreset.plugins,
  ],
  optimizeDeps: enginePreset.optimizeDeps,
  resolve: enginePreset.resolve,
  server: {
    port: PORT,
    host: HOST,
    strictPort: true,
    open: false,
    headers: ENGINE_EXECUTION_ISOLATION_HEADERS,
    watch: { usePolling: true, interval: 300, ignored: ['**/node_modules/**'] },
    // fs.allow: editor tree (here + repo root) PLUS the standalone `--game DIR`
    // when it lives OUTSIDE the editor tree (e.g. a sibling forgeax-engine
    // template). Without this the Play `@fs<gameDir>/main.ts` transform is
    // refused by vite's fs guard. GAME_DIR_ABS null (embedded studio) -> unchanged.
    fs: {
      allow: [here, resolve(here, '../../..'), ...(GAME_DIR_ABS ? [GAME_DIR_ABS] : [])],
      strict: false,
    },
    // HMR clientPort: when vite runs behind a reverse proxy the browser must
    // open the HMR websocket to the *gateway* port (usually 443), not the
    // internal vite port. FORGEAX_HMR_CLIENT_PORT overrides
    // FORGEAX_INTERFACE_PORT for exactly this case.
    hmr: {
      clientPort: Number(
        process.env.FORGEAX_HMR_CLIENT_PORT ??
          process.env.FORGEAX_INTERFACE_PORT ??
          assignedWorktreePorts?.standalone ??
          18920,
      ),
    },
    // Scene persistence (store.ts) reads/writes the game's scene.json through the
    // host-injected game root via /api/files. Iframed via the interface (:18920/editor)
    // it's same-origin already; this proxy makes a DIRECT :15280 visit work too.
    proxy: {
      '/api': { target: `http://127.0.0.1:${process.env.FORGEAX_SERVER_PORT ?? 18900}`, changeOrigin: true },
      // Studio-embedded ONLY: the active game's scoped pluginPack lives behind
      // the play engine's /preview namespace. Standalone (SELF_HOST_PACK)
      // registers its own exact-game pluginPack via the preset and serves the
      // scoped routes under /editor/* locally, so the :15173 proxy is skipped.
      ...(SELF_HOST_PACK ? {} : {
        '/preview': { target: `http://127.0.0.1:${process.env.FORGEAX_ENGINE_PORT ?? 15173}`, changeOrigin: true, ws: true },
      }),
    },
  },
  build: { outDir: resolve(here, 'dist'), target: enginePreset.build.target },
});
