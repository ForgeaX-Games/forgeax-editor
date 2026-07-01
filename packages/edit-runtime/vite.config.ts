import { defineConfig } from 'vite';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, existsSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { gltfImporter } from '@forgeax/engine-gltf';

const here = dirname(fileURLToPath(import.meta.url));

// ── @forgeax packages to exclude from pre-bundle (SSOT-derived, no hand list) ──
// SSOT = THIS root's node_modules/@forgeax (engine-* + editor-*), i.e. exactly
// the @forgeax packages Vite resolves natively here. Excluding precisely that set:
//   - Avoids the OOM: under preserveSymlinks:true a pre-bundle crawls the nested
//     workspace symlink graph (packages/*/node_modules/@forgeax/* → ../../../*)
//     where one file via combinatorially-many symlink paths becomes a distinct
//     module → esbuild blows up; also keeps the editor singletons (editor-shared
//     EditorBus / active sceneId) a single instance.
//   - Stays resolvable: all are present here. We must NOT over-exclude with the
//     full engine/packages tree — transitive-only packages absent from
//     node_modules (engine-plugin / engine-debug-draw, imported by engine-app /
//     engine-runtime) must stay pre-bundlable or native import analysis throws
//     "Failed to resolve import". Hand-listing was the original drift bug.
function forgeaxWorkspacePackages(): string[] {
  const out = new Set<string>(['@forgeax/scene']);
  try {
    for (const name of readdirSync(resolve(here, 'node_modules/@forgeax'))) {
      out.add(`@forgeax/${name}`);
    }
  } catch { /* node_modules not materialised yet — fall through */ }
  return [...out];
}
const FORGEAX_WS_PKGS = forgeaxWorkspacePackages();

const PORT = Number(process.env.FORGEAX_EDITOR_PORT ?? 15280);
const HOST = process.env.FORGEAX_EDITOR_HOST ?? '0.0.0.0';
const BASE = '/editor/';

// ── standalone `--game DIR` game root (abs) ───────────────────────────────────
// The ▶ Play resolver (main.tsx resolveGameModuleForPlay) imports the game entry
// through edit vite's `/editor/@fs<abs>/…` so its @forgeax/engine-* imports bind to
// THIS runtime's single engine instance (see 50f82e5). It needs the game's abs dir.
//
// In standalone `--game DIR` the dir DIRECTLY contains forge.json (the host serves
// one arbitrary game dir), and there is NO studio server — so the old path
// of asking `/api/health` for `projectRootAbs` (a forgeax-server-only route that,
// even in studio, returns `projectRoot` NOT `projectRootAbs`) 404s and the whole
// Play crashes with `import-failed`. cli.mjs already exports FORGEAX_GAME_DIR to
// this process; inject it into the client bundle so the resolver skips the studio
// route entirely. null when embedded in studio → resolver keeps its legacy branch.
const GAME_DIR_ABS = process.env.FORGEAX_GAME_DIR
  ? resolve(process.env.FORGEAX_GAME_DIR)
  : null;

// ── standalone self-hosted pack catalog (Part C) ──────────────────────────────
// In standalone `--game`, Play's assets.loadByGuid needs the engine pack-index
// catalog. Studio-embedded proxies /preview/* to play-runtime (:15173) for it,
// but standalone has no :15173 — so edit-runtime registers its OWN pluginPack over
// the game's assets/ + scenes/ dirs (base '/editor/', reachable through the host
// proxy). This removes the play-runtime dependency for standalone Edit-preview AND
// Play. null GAME_DIR_ABS (studio-embedded) → keep the /preview proxy (below).
function gamePackRoots(): string[] {
  if (!GAME_DIR_ABS) return [];
  return ['assets', 'scenes'].map((d) => join(GAME_DIR_ABS, d)).filter((p) => existsSync(p));
}
const SELF_HOST_PACK = GAME_DIR_ABS !== null;

// forgeaxShader's configureServer middleware hardcodes `/shaders/manifest.json`,
// but this vite root uses `base: '/editor/'` so the proxied URL arrives as
// `/editor/shaders/manifest.json`. Strip the base prefix before forgeaxShader's
// (later-registered) middleware sees the request. Mirrors engine-src.
function shaderBaseStrip() {
  return {
    name: 'forgeax:editor-shader-base-strip',
    configureServer(server: { middlewares: { use(fn: (req: { url?: string }, res: unknown, next: () => void) => void): unknown } }) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/editor/shaders/manifest.json') req.url = '/shaders/manifest.json';
        next();
      });
    },
  };
}

// pluginPack's dev middleware matches its routes literally (no base awareness);
// under `base: '/editor/'` the proxied requests arrive prefixed with `/editor`.
// Strip that prefix before pluginPack's (later-registered) middleware sees them,
// for EVERY pluginPack route the self-hosted catalog serves (Part C):
//   /editor/pack-index.json            → /pack-index.json          (catalog)
//   /editor/__import/<guid>            → /__import/<guid>          (lazy cook)
//   /editor/__forgeax-ddc/<guid>.pack.json → /__forgeax-ddc/...    (meta pack body)
// Mirrors engine-src's forgeaxPackBaseStrip. Asset URLs pluginPack emits already
// carry the `/editor/` base (relativeUrl prefixed at build), so they resolve as-is.
const PACK_ROUTE_PREFIXES = ['/pack-index.json', '/__import/', '/__forgeax-ddc/'];
function packBaseStrip() {
  return {
    name: 'forgeax:editor-pack-base-strip',
    configureServer(server: { middlewares: { use(fn: (req: { url?: string }, res: unknown, next: () => void) => void): unknown } }) {
      server.middlewares.use((req, _res, next) => {
        const u = req.url;
        if (u) {
          for (const p of PACK_ROUTE_PREFIXES) {
            if (u === `/editor${p}` || u.startsWith(`/editor${p}`)) {
              req.url = u.slice('/editor'.length);
              break;
            }
          }
        }
        next();
      });
    },
  };
}

// Swallow forgeaxShader's emitFile() in serve mode (vite 6 logs a noisy warning
// per call). Build mode delegates unchanged. Mirrors engine-src.
function silenceShaderEmitInServe(plugin: Record<string, unknown>) {
  let isServe = false;
  const orig = plugin as {
    configResolved?: (this: unknown, c: { command: string }) => unknown;
    buildStart?: (this: unknown) => unknown;
    transform?: (this: unknown, code: string, id: string) => unknown;
  };
  return {
    ...orig,
    configResolved(this: unknown, config: { command: string }) {
      isServe = config.command === 'serve';
      return orig.configResolved?.call(this, config);
    },
    buildStart(this: unknown) {
      if (!isServe || typeof orig.buildStart !== 'function') return orig.buildStart?.call(this);
      const proxy = new Proxy(this as object, { get(t, p) { return p === 'emitFile' ? () => '' : (t as Record<string | symbol, unknown>)[p]; } });
      return orig.buildStart.call(proxy);
    },
    transform(this: unknown, code: string, id: string) {
      if (typeof orig.transform !== 'function') return undefined;
      if (!isServe) return orig.transform.call(this, code, id);
      const proxy = new Proxy(this as object, { get(t, p) { return p === 'emitFile' ? () => '' : (t as Record<string | symbol, unknown>)[p]; } });
      return orig.transform.call(proxy, code, id);
    },
  };
}

export default defineConfig({
  root: here,
  base: BASE,
  cacheDir: resolve(here, '.vite'),
  publicDir: resolve(here, 'public'),
  // Expose the standalone `--game DIR` abs path to the client so the ▶ Play
  // resolver builds its `@fs<abs>` game-entry URL without the studio-only
  // `/api/health` round-trip. null (embedded studio) → resolver legacy branch.
  define: { __FORGEAX_GAME_DIR_ABS__: JSON.stringify(GAME_DIR_ABS) },
  plugins: [
    react(),
    shaderBaseStrip() as never,
    packBaseStrip() as never,
    // Standalone (Part C): self-host the pack catalog over the injected game dir,
    // so Play's loadByGuid + Edit sub-asset previews resolve WITHOUT proxying to
    // play-runtime (:15173). base '/editor/' so its emitted asset URLs + routes
    // sit under the host-proxied prefix; packBaseStrip strips it for the middleware.
    // Studio-embedded (GAME_DIR_ABS null): NOT registered — the /preview proxy
    // (below) reaches play-runtime's pluginPack, which owns the multi-game catalog.
    ...(SELF_HOST_PACK
      ? [pluginPack({ roots: gamePackRoots(), base: BASE, importers: [imageImporter, gltfImporter] }) as never]
      : []),
    silenceShaderEmitInServe(forgeaxShader() as never) as never,
  ],
  optimizeDeps: {
    // Exclude the ENTIRE @forgeax workspace family (engine-* + editor-*) from
    // Vite pre-bundling — served as native ESM. SSOT-derived (see
    // forgeaxWorkspacePackages) so it can't drift the way the old hand list did;
    // also keeps the editor singletons (EditorBus / active sceneId in
    // editor-shared) a single shared instance.
    exclude: FORGEAX_WS_PKGS,
  },
  resolve: {
    // react/react-dom must dedupe (single React instance); the @forgeax family
    // dedupes off the same SSOT-derived list as optimizeDeps so every engine /
    // editor package resolves to one realpath even when reached via a nested
    // symlink path.
    dedupe: ['react', 'react-dom', ...FORGEAX_WS_PKGS],
    preserveSymlinks: true,
  },
  server: {
    port: PORT,
    host: HOST,
    strictPort: true,
    open: false,
    watch: { usePolling: true, interval: 300, ignored: ['**/node_modules/**'] },
    // fs.allow: editor tree (here + repo root) PLUS the standalone `--game DIR`
    // when it lives OUTSIDE the editor tree (e.g. a sibling forgeax-engine
    // template). Without this the ▶ Play `@fs<gameDir>/main.ts` transform is
    // refused by vite's fs guard. GAME_DIR_ABS null (embedded studio) → unchanged.
    fs: {
      allow: [here, resolve(here, '../../..'), ...(GAME_DIR_ABS ? [GAME_DIR_ABS] : [])],
      strict: false,
    },
    hmr: { clientPort: Number(process.env.FORGEAX_INTERFACE_PORT ?? 18920) },
    // Scene persistence (store.ts) reads/writes the game's scene.json through the
    // host-injected game root via /api/files. Iframed via the interface (:18920/editor)
    // it's same-origin already; this proxy makes a DIRECT :15280 visit work too.
    proxy: {
      '/api': { target: `http://127.0.0.1:${process.env.FORGEAX_SERVER_PORT ?? 18900}`, changeOrigin: true },
      // Studio-embedded ONLY: skinned-mesh preview (witch.glb sub-assets) lives in
      // the play engine's per-game pluginPack catalog. /preview/* serves catalog +
      // DDC bodies; /__import + /__forgeax-ddc are the gltfImporter cook + read
      // endpoints. Standalone (SELF_HOST_PACK) registers its OWN pluginPack over the
      // injected game dir (above) and serves these under /editor/* locally, so the
      // :15173 proxy is skipped — there is no play-runtime in standalone `--game`.
      ...(SELF_HOST_PACK ? {} : {
        '/preview': { target: `http://127.0.0.1:${process.env.FORGEAX_ENGINE_PORT ?? 15173}`, changeOrigin: true, ws: true },
        '/__import': { target: `http://127.0.0.1:${process.env.FORGEAX_ENGINE_PORT ?? 15173}`, changeOrigin: true },
        '/__forgeax-ddc': { target: `http://127.0.0.1:${process.env.FORGEAX_ENGINE_PORT ?? 15173}`, changeOrigin: true },
      }),
    },
  },
  // esnext: the entry (main.tsx) uses top-level await (initSceneList/bootEditor);
  // vite's default build target (es2020/chrome87/safari14) forbids TLA and the
  // desktop build fails. This runtime only runs in WKWebView/Chrome (which
  // support TLA) — dev serve already runs it untranspiled — so esnext is safe.
  build: { outDir: resolve(here, 'dist'), target: 'esnext' },
});
