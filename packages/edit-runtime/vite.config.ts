// edit-runtime vite config — the Edit-mode iframe/dev server (:15280, base
// '/editor/'). Independent dev + e2e webServer entry (`bun -F edit-runtime dev`).
//
// REPLAN D7 (SSOT regression): the engine-serve mechanism (forgeaxShader emit,
// pluginPack pack-index / __import middleware, base-strip, preserveSymlinks,
// optimizeDeps.exclude @forgeax family, build.target esnext) used to live inline
// HERE. M2 hoisted it into engine-vite-preset (src/viewport/engine-vite-preset.ts)
// so the :15290 host config can serve the engine in-process too. This config now
// CONSUMES that preset and keeps only its edit-runtime-specific parts: root,
// base '/editor/', hmr.clientPort, the --game /api + /preview proxies, and the
// fs.allow for the injected --game dir. See plan-strategy S2 D7 / S4 R7.

import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { engineVitePreset } from './src/viewport/engine-vite-preset';

const here = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.FORGEAX_EDITOR_PORT ?? 15280);
const HOST = process.env.FORGEAX_EDITOR_HOST ?? '0.0.0.0';
const BASE = '/editor/';

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
const SELF_HOST_PACK = GAME_DIR_ABS !== null;

// D7: the shared engine-serve fragment (shader/pack serve + optimizeDeps.exclude
// + preserveSymlinks + build.target esnext). base '/editor/' so its base-strip
// middleware is included; gameDirAbs threads the self-hosted pluginPack catalog.
const enginePreset = engineVitePreset({ base: BASE, gameDirAbs: GAME_DIR_ABS });

export default defineConfig({
  root: here,
  base: BASE,
  cacheDir: resolve(here, '.vite'),
  publicDir: resolve(here, 'public'),
  // Expose the standalone `--game DIR` abs path to the client so the Play
  // resolver builds its `@fs<abs>` game-entry URL without the studio-only
  // `/api/health` round-trip. null (embedded studio) -> resolver legacy branch.
  define: { __FORGEAX_GAME_DIR_ABS__: JSON.stringify(GAME_DIR_ABS) },
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
        process.env.FORGEAX_HMR_CLIENT_PORT ?? process.env.FORGEAX_INTERFACE_PORT ?? 18920,
      ),
    },
    // Scene persistence (store.ts) reads/writes the game's scene.json through the
    // host-injected game root via /api/files. Iframed via the interface (:18920/editor)
    // it's same-origin already; this proxy makes a DIRECT :15280 visit work too.
    proxy: {
      '/api': { target: `http://127.0.0.1:${process.env.FORGEAX_SERVER_PORT ?? 18900}`, changeOrigin: true },
      // Studio-embedded ONLY: skinned-mesh preview (witch.glb sub-assets) lives in
      // the play engine's per-game pluginPack catalog. /preview/* serves catalog +
      // DDC bodies; /__import + /__forgeax-ddc are the gltfImporter cook + read
      // endpoints. Standalone (SELF_HOST_PACK) registers its OWN pluginPack over the
      // injected game dir (via the preset) and serves these under /editor/* locally,
      // so the :15173 proxy is skipped — there is no play-runtime in standalone --game.
      ...(SELF_HOST_PACK ? {} : {
        '/preview': { target: `http://127.0.0.1:${process.env.FORGEAX_ENGINE_PORT ?? 15173}`, changeOrigin: true, ws: true },
        '/__import': { target: `http://127.0.0.1:${process.env.FORGEAX_ENGINE_PORT ?? 15173}`, changeOrigin: true },
        '/__forgeax-ddc': { target: `http://127.0.0.1:${process.env.FORGEAX_ENGINE_PORT ?? 15173}`, changeOrigin: true },
      }),
    },
  },
  build: { outDir: resolve(here, 'dist'), target: enginePreset.build.target },
});
