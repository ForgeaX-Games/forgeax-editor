import { defineConfig } from 'vite';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, lstatSync, unlinkSync, symlinkSync } from 'node:fs';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { gltfImporter } from '@forgeax/engine-gltf';
import { buildPerGameCatalog } from './pack-catalog.js';

const here = dirname(fileURLToPath(import.meta.url));

// Cross-platform setup for shared-assets:
// Git on Windows without core.symlinks=true checks out symlinks as plain text files containing the target path.
// This breaks Vite dev server. We dynamically create a 'junction' on Windows if needed.
(function setupSharedAssets() {
  const linkPath = resolve(here, 'shared-assets');
  const targetPath = resolve(here, '..', '..', 'forgeax-editor-assets');
  if (existsSync(linkPath)) {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink() && stat.isFile()) {
      // It's the text file checked out by Git on Windows. Remove it.
      try { unlinkSync(linkPath); } catch {}
    } else {
      // Already a valid symlink or junction, leave it alone.
      return;
    }
  }
  // Create a proper symlink/junction
  try {
    symlinkSync(targetPath, linkPath, 'junction');
  } catch (e) {
    console.warn(`[forgeax] failed to create shared-assets junction:`, e);
  }
})();

// Self-contained vite root: the engine directory itself. Pre-2026-05-13 the
// root was the parent dir (packages/forgeax/), which forced an
// engine-host-specific index.html to live one level up. With root = here,
// engine-src/ (studio) and packages/forgeax/engine/ (release) are both
// self-contained vite roots — a single index.html serves /preview/, and
// /preview/.forgeax/games/<id>/... resolves to <root>/.forgeax/games/<id>/...
// which run.sh symlinks to the instance's actual .forgeax in both modes.
const viteRoot = here;

const PORT = Number(process.env.FORGEAX_ENGINE_PORT ?? 15173);
const HOST = process.env.FORGEAX_ENGINE_HOST ?? '0.0.0.0';

// forgeaxShader's configureServer middleware hardcodes `/shaders/manifest.json`
// as the request path, but this vite root uses `base: '/preview/'` so the
// incoming URL is `/preview/shaders/manifest.json`. This custom plugin sits
// before forgeaxShader in the plugin array, so its configureServer fires first.
// The middleware strips the base prefix before the forgeaxShader middleware
// (registered after) sees the request.
function forgeaxShaderBaseStrip() {
  return {
    name: 'forgeax:shader-base-strip',
    configureServer(server: { middlewares: { use(fn: Function): unknown } }) {
      server.middlewares.use((req: { url?: string }, _res: unknown, next: () => void) => {
        if (req.url === '/preview/shaders/manifest.json') {
          req.url = '/shaders/manifest.json';
        }
        next();
      });
    },
  };
}

// pluginPack's dev middleware matches the pack-index route literally as
// `/pack-index.json` (no base awareness), but this vite root uses
// `base: '/preview/'` so the proxied request arrives as
// `/preview/pack-index.json`. Mirror forgeaxShaderBaseStrip: strip the base
// prefix before pluginPack's middleware (registered after) sees the request.
// (Individual pack-file URLs do NOT need stripping — pluginPack serves them by
// matching the base-prefixed catalog `relativeUrl`, which equals the proxied
// req.url verbatim.)
function forgeaxPackBaseStrip() {
  return {
    name: 'forgeax:pack-base-strip',
    configureServer(server: { middlewares: { use(fn: Function): unknown } }) {
      server.middlewares.use((req: { url?: string }, _res: unknown, next: () => void) => {
        if (req.url === '/preview/pack-index.json') {
          req.url = '/pack-index.json';
        }
        next();
      });
    },
  };
}

// Scan every game's assets/ dir as a pack root. One-level glob over
// .forgeax/games/<slug>/assets deliberately excludes nested dirs like
// shoot/backup/assets, whose .pack.json files reuse the same GUIDs and would
// trip the scanner's duplicate-guid guard (collapsing the whole catalog).
function gameAssetRoots(): string[] {
  const gamesDir = resolve(here, '.forgeax/games');
  if (!existsSync(gamesDir)) return [];
  return readdirSync(gamesDir)
    .map((slug) => join(gamesDir, slug, 'assets'))
    .filter((p) => existsSync(p));
}

// Shared template assets live under the engine vite root (here/shared-assets)
// and are folded into EVERY game's per-game catalog. The default game template
// loads its environment skylight from a single shared sky.hdr cube-texture
// sidecar here rather than duplicating the 1.3MB HDR into each game's assets/.
// Lives under the vite root so it ships with the frozen .app copy too (Tauri),
// and its relativeUrl (relative to cwd=here, +base) is one vite serves.
// Returns [] when absent (older deploys) so catalogs degrade to game-only.
function sharedAssetRoots(): string[] {
  const dir = resolve(here, 'shared-assets');
  return existsSync(dir) ? [dir] : [];
}

// Per-game pack roots: a game's own `assets/` AND `scenes/`. Levels live in
// scenes/<id>.pack.json (the editor's level discovery scans there — see
// editor-core store.initSceneList; the game's main.ts loads them by GUID from
// THIS per-game catalog). Monsters/materials live in assets/. Both dirs are
// optional; filter to those that exist. Without scenes/ here, asset-first Play
// can't loadByGuid a level pack that lives in scenes/ (the editor still shows
// it, but Play 404s the GUID) — keep this in sync with the editor convention.
function perGamePackRoots(slug: string): string[] {
  const base = resolve(here, '.forgeax', 'games', slug);
  return ['assets', 'scenes'].map((d) => join(base, d)).filter((p) => existsSync(p));
}

// Return slugs for every game directory under .forgeax/games/ that has an
// assets/ subdirectory. Symlink game directories are included because
// existsSync follows symlinks. This mirrors gameAssetRoots() and is the
// per-game complement.
function gameSlugs(): string[] {
  const gamesDir = resolve(here, '.forgeax/games');
  if (!existsSync(gamesDir)) return [];
  return readdirSync(gamesDir)
    .filter((slug) => existsSync(join(gamesDir, slug, 'assets')));
}

// Per-game base-strip: pluginPack's middleware matches per-game routes as
// /pack-index/<slug>.json. With base '/preview/' this becomes
// /preview/pack-index/<slug>.json. Strip the base prefix before pluginPack's
// middleware (or our own) sees the request. Placed after forgeaxPackBaseStrip
// so the literal /pack-index.json (no slug) is still handled by existing
// global route.
function forgeaxPerGamePackBaseStrip() {
  const PER_GAME_PREFIX = '/preview/pack-index/';
  return {
    name: 'forgeax:per-game-pack-base-strip',
    configureServer(server: { middlewares: { use(fn: Function): unknown } }) {
      server.middlewares.use((req: { url?: string }, _res: unknown, next: () => void) => {
        if (req.url?.startsWith(PER_GAME_PREFIX)) {
          req.url = '/pack-index/' + req.url.slice(PER_GAME_PREFIX.length);
        }
        next();
      });
    },
  };
}

// Per-game pack-index plugin: dev middleware serves /pack-index/<slug>.json
// by calling buildPerGameCatalog; prod generateBundle emits independent
// per-game pack-index files.
export function forgeaxPerGamePackIndex() {
  const PER_GAME_ROUTE_RE = /^\/pack-index\/([a-z0-9][a-z0-9-]{1,40})\.json$/;
  return {
    name: 'forgeax:per-game-pack-index',
    configureServer(server: { middlewares: { use(fn: Function): unknown } }) {
      server.middlewares.use(async (req: { url?: string }, res: { statusCode: number; setHeader(k: string, v: string): void; end(data: string): void }, next: () => void) => {
        const match = req.url?.match(PER_GAME_ROUTE_RE);
        if (!match) { next(); return; }
        const slug = match[1];
        if (slug === undefined) { next(); return; }
        const roots = perGamePackRoots(slug);
        if (roots.length === 0) { next(); return; }
        try {
          const catalog = await buildPerGameCatalog(roots[0], '/preview', [...roots.slice(1), ...sharedAssetRoots()]);
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 200;
          res.end(JSON.stringify(catalog));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'per-game catalog build failed', slug, detail: err instanceof Error ? err.message : String(err) }));
        }
      });
    },
    async generateBundle(this: { emitFile(opts: { type: string; fileName: string; source: string }): void }, _opts: unknown, _bundle: unknown) {
      // Prod: emit per-game pack-index files. The existing pluginPack
      // (registered before us) already emits the global /pack-index.json
      // and cooks textures. We add per-game sidecars.
      for (const slug of gameSlugs()) {
        const roots = perGamePackRoots(slug);
        if (roots.length === 0) continue;
        try {
          const catalog = await buildPerGameCatalog(roots[0], '/preview', [...roots.slice(1), ...sharedAssetRoots()]);
          const fileName = `pack-index/${slug}.json`;
          this.emitFile({
            type: 'asset',
            fileName,
            source: JSON.stringify(catalog),
          });
        } catch (err) {
          console.warn(`[forgeax:per-game-pack-index] failed to build catalog for ${slug}:`, err instanceof Error ? err.message : String(err));
        }
      }
    },
  };
}

// gameAssetRoots() is evaluated once at config load, so a game scaffolded /
// given assets AFTER server start is absent from pluginPack's catalog and its
// textures/meshes 404 in the preview. This dev-only plugin watches the games
// tree and, when the set of asset roots changes (a new game gains an assets/
// dir or a *.pack.json lands), restarts vite — which re-runs the config and
// re-seeds pluginPack with the new roots. Debounced + change-gated so ordinary
// edits inside existing games (already HMR'd) never trigger a restart, and so
// the burst of writes during scaffolding collapses into a single restart.
function forgeaxGameRescan() {
  return {
    name: 'forgeax:game-rescan',
    configureServer(server: any) {
      const gamesDir = resolve(here, '.forgeax/games');
      let known = new Set(gameAssetRoots());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const maybeRestart = (p: string) => {
        if (!p.split('\\').join('/').includes('/.forgeax/games/')) return;
        const next = new Set(gameAssetRoots());
        const changed = next.size !== known.size || [...next].some((r) => !known.has(r));
        if (!changed) return;
        known = next;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          console.log('[forgeax:game-rescan] asset roots changed → restarting vite');
          void server.restart();
        }, 400);
      };
      server.watcher.on('addDir', (p: string) => maybeRestart(p));
      server.watcher.on('add', (p: string) => { if (p.endsWith('.pack.json')) maybeRestart(p); });
      server.watcher.on('unlinkDir', (p: string) => maybeRestart(p));
      try { server.watcher.add(gamesDir); } catch { /* games dir may not exist yet */ }
    },
  };
}

// Wrap forgeaxShader() to silence vite's "emitFile() is not supported in serve
// mode" warnings: the upstream plugin calls this.emitFile() in buildStart and
// transform to feed rollup's bundle phase (production build). In serve mode
// the manifest is served via configureServer middleware instead, so emitFile
// is functionally a no-op — vite 6+ logs a noisy warning per call (27+ during
// startup). This wrapper proxies the plugin context to swallow emitFile when
// command === 'serve'. Build mode delegates unchanged.
function silenceShaderEmitInServe(plugin: any) {
  let isServe = false;
  const orig = plugin;
  return {
    ...orig,
    configResolved(config: { command: string }) {
      isServe = config.command === 'serve';
      if (typeof orig.configResolved === 'function') return orig.configResolved.call(this, config);
    },
    buildStart(this: any) {
      if (!isServe || typeof orig.buildStart !== 'function') {
        return orig.buildStart?.call(this);
      }
      const proxy = new Proxy(this, {
        get(target, prop) {
          if (prop === 'emitFile') return () => '';
          return (target as any)[prop];
        },
      });
      return orig.buildStart.call(proxy);
    },
    transform(this: any, code: string, id: string) {
      if (typeof orig.transform !== 'function') return undefined;
      if (!isServe) return orig.transform.call(this, code, id);
      const proxy = new Proxy(this, {
        get(target, prop) {
          if (prop === 'emitFile') return () => '';
          return (target as any)[prop];
        },
      });
      return orig.transform.call(proxy, code, id);
    },
  };
}

export default defineConfig({
  root: viteRoot,
  // base: '/preview/' namespaces every URL Vite emits (deps, /@vite, /@id, etc).
  // The interface studio is at :18920 and proxies /preview → :15173/preview, so
  // engine's deps don't collide with interface's own /node_modules deps.
  base: '/preview/',
  cacheDir: resolve(here, '.vite'),
  publicDir: resolve(here, 'public'),
  plugins: [
    forgeaxShaderBaseStrip() as never,
    forgeaxPackBaseStrip() as never,
    forgeaxPerGamePackBaseStrip() as never,
    pluginPack({ roots: gameAssetRoots(), base: '/preview/', importers: [imageImporter, gltfImporter] }) as never,
    // Second pluginPack instance scoped to shared template assets — needs
    // imageImporter wired so the .hdr cube-texture sidecar produces a valid
    // PackEntry (without it, /preview/__import on cold loadByGuid would
    // mislabel the bare .hdr as rgba8unorm and uploadCubemapFromEquirect
    // rejects with `invalid-source-format`). Co-existing with the per-game
    // pluginPack is fine: GUIDs are disjoint by construction.
    pluginPack({
      roots: sharedAssetRoots(),
      base: '/preview/',
      importers: [imageImporter],
    }) as never,
    forgeaxPerGamePackIndex() as never,
    forgeaxGameRescan() as never,
    silenceShaderEmitInServe(forgeaxShader()) as never,
  ],
  optimizeDeps: {
    // Exclude engine workspace packages from Vite pre-bundling so they are
    // loaded as native ESM .mjs (research F2: engine outputs ESM .mjs, vite
    // 6 can serve them directly; pre-bundling would break source maps and
    // module identity for the engine subgraph).
    exclude: [
      '@forgeax/engine-app',
      '@forgeax/engine-runtime',
      '@forgeax/engine-render-graph',
      '@forgeax/engine-ecs',
      '@forgeax/engine-types',
      '@forgeax/engine-shader',
      // engine-gltf is imported by user games' scene-runtime/gltf-runtime.ts
      // (e.g. @forgeax/game-fps). Pre-bundling it would split it from the
      // engine subgraph (parseGlb / gltfDocToSceneAsset reach into engine-pack
      // / engine-image internals). Mirror editor-edit-runtime/vite.config.ts.
      '@forgeax/engine-gltf',
      // @forgeax/scene re-exports engine-runtime components (Transform/HANDLE_CUBE
      // etc.) to instantiate scene docs; it MUST share the engine subgraph's module
      // identity, so exclude it from pre-bundling too (else a games' import would
      // get a second engine-runtime instance and ECS handles wouldn't match).
      '@forgeax/scene',
      // game main.ts is dynamically imported (loadGame), so its imports are NOT
      // in vite's startup entry scan. The native template pulls subpaths
      // `@forgeax/engine-pack/guid` (AssetGuid) + `@forgeax/engine-image/hdr-decoder`
      // (decodeHdr); left in the pre-bundle, vite discovers them lazily on a NEW
      // game's first load → "optimized dependencies changed, reloading" → the
      // preview reloads a few times (the "new game flicker" after project creation). Exclude
      // them (native ESM, same as the rest of the engine subgraph) so there is no
      // runtime re-optimize and no reload.
      '@forgeax/engine-pack',
      '@forgeax/engine-image',
    ],
  },
  resolve: {
    alias: {
      '@forgeax/game-types': resolve(here, 'src/types.ts'),
    },
    dedupe: [
      '@forgeax/engine-runtime',
      '@forgeax/engine-render-graph',
      '@forgeax/engine-ecs',
      '@forgeax/engine-types',
      '@forgeax/engine-rhi',
      '@forgeax/engine-math',
      '@forgeax/engine-pack',
      '@forgeax/engine-image',
      '@forgeax/engine-gltf',
      '@forgeax/scene',
    ],
    // User game files live at <studio-root>/.forgeax/games/<slug>/ (entry is a
    // root-level main.ts, extra modules under src/), reachable via run.sh's
    // symlink engine-src/.forgeax → <studio-root>/.forgeax.
    // With default preserveSymlinks: false, vite resolves the symlink first and
    // walks up from <studio-root>, where node_modules/@forgeax/ doesn't exist
    // (workspace symlinks live at engine-src/node_modules/@forgeax/*).
    // preserveSymlinks: true keeps resolution rooted at engine-src so imports
    // like '@forgeax/engine-runtime' from user game code find the workspace
    // symlinks. fs.allow.strict=false still permits loading the actual file
    // through the symlink.
    preserveSymlinks: true,
  },
  server: {
    port: PORT,
    host: HOST,
    strictPort: true,
    open: false,
    watch: {
      usePolling: true,
      interval: 300,
      ignored: [
        '**/.forgeax/agenteam-state/**',
        '**/.forgeax/cache/**',
        '**/.forgeax/packs/**',
        '**/node_modules/**',
      ],
    },
    fs: { allow: [viteRoot], strict: false },
    hmr: {
      clientPort: Number(process.env.FORGEAX_INTERFACE_PORT ?? 18920),
    },
  },
  // esnext: keep parity with edit-runtime — the engine host entry may use
  // top-level await; vite's default build target (es2020/chrome87/safari14)
  // forbids TLA. This runtime only runs in WKWebView/Chrome (TLA-capable) and
  // dev serve already runs it untranspiled, so esnext is safe.
  build: { outDir: resolve(here, 'dist'), target: 'esnext' },
});