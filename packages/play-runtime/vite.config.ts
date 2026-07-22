import { defineConfig } from 'vite';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, lstatSync, unlinkSync, symlinkSync, realpathSync } from 'node:fs';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
// Vite config bundling externalizes package subpaths, so Node would receive core's
// raw TypeScript export. Import the same core helper relatively to bundle it first.
import { resolveGameAssetRoots, type ResolvedRoot } from '../core/src/asset-roots';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { gltfImporter } from '@forgeax/engine-gltf';
import { fbxImporter } from '@forgeax/engine-fbx';
import { buildPerGameCatalog } from './pack-catalog.js';

const here = dirname(fileURLToPath(import.meta.url));

// The shared/external asset submodule (forgeax-editor-assets) resolved to its
// REAL path, two levels up from this package. `@shared/<sub>` roots declared in
// a game's package.json#forgeax.assets.roots resolve against this base (via
// resolveGameAssetRoots). See the farm comment below for why the real path is
// then rewritten to the in-viteRoot symlink before scanning.
const SHARED_BASE = resolve(here, '..', '..', 'forgeax-editor-assets');

// Games stay a host concern: a standalone/desktop/studio host injects the
// physical directory.  When it does not supply a public URL prefix, mount it
// under this generated in-root name so Vite can serve it without an ambient
// sibling-repository convention.
const PREVIEW_GAMES_DIR = process.env.FORGEAX_PREVIEW_GAMES_DIR;
const HOST_GAMES_FARM = 'host-games';
const GAMES_URL_PREFIX = process.env.FORGEAX_GAMES_URL_PREFIX
  ?? (PREVIEW_GAMES_DIR ? HOST_GAMES_FARM : '');

// Implicit `template-game-default` shared scope. The demo-seed default template's
// scene references the shared sky.hdr equirect GUID (81eec382) but its own assets/
// has no sky.hdr and its package.json declares only `["assets"]` — never
// `@shared/template-game-default` (that would leak the editor's `@shared/`
// convention into the engine submodule's template). play-runtime injects the
// scope for EVERY game so the template sky folds into the pack catalog, matching
// edit-runtime's runtime-vite-preset (they share this via editor-core's
// resolveGameAssetRoots.implicitSharedSubs — architecture-principles §1 SSOT).
// Without it, /__import/<sky-guid> 404s `meta-not-found` and the skylight falls
// back to a solid color. existsSync-filtered, so an absent submodule degrades to
// game-only.
const IMPLICIT_SHARED_SUBS = ['template-game-default'] as const;

// Cross-platform external-root farm (generalizes the former single hardcoded
// `sharedAssetRoots()` mount — architecture-principles §1 SSOT: one `roots`
// concept, not a per-game list PLUS a separate shared-roots appender).
//
// WHY A SYMLINK IS STILL REQUIRED (not just an abs path in roots):
//   play-runtime's process.cwd() == viteRoot == this package dir, and every
//   catalog entry's relativeUrl = withBase('/preview', relative(cwd, assetAbs))
//   (pack-catalog.ts). withBase does posix.resolve('/', rel), which CLAMPS
//   leading `../` — so an external abs path (forgeax-editor-assets lives ABOVE
//   viteRoot) yields a mangled `/preview/forgeax-editor-assets/...` URL that
//   resolves under viteRoot and 404s. The symlink makes the whole submodule
//   appear UNDER viteRoot as `shared-assets/`, so relative(cwd, .../shared-assets/x)
//   is a clean in-root subpath vite can serve. The scanner does NOT realpath-deref,
//   so the `shared-assets/` prefix is preserved. Every `@shared/<sub>` root lives
//   under this ONE submodule, so ONE whole-dir symlink covers all scopes — no
//   per-scope farm needed. `farmPath()` (below) rewrites resolved shared roots
//   to their `shared-assets/<sub>` path before they reach the scanner.
//
// Git on Windows without core.symlinks=true checks out symlinks as plain text
// files containing the target path, which breaks the Vite dev server — so we
// (re)create a real symlink/junction on demand.
(function setupExternalRootFarm() {
  const linkPath = resolve(here, 'shared-assets');
  const targetPath = SHARED_BASE;
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

// Rewrite a resolved root to the path the scanner should see. Local roots pass
// through as their abs path; shared (`@shared/<sub>`) roots are redirected to the
// in-viteRoot symlink `shared-assets/<sub>` so relative(cwd,…) stays a clean,
// serveable subpath (see the farm comment above). `resolveGameAssetRoots` has
// already existsSync-filtered against the REAL path; the symlink points at the
// same dir so the redirected path exists too.
function farmPath(r: ResolvedRoot): string {
  return r.shared && r.sub !== undefined ? resolve(here, 'shared-assets', r.sub) : r.abs;
}

// Self-contained vite root: the engine directory itself. Pre-2026-05-13 the
// root was the parent dir (packages/forgeax/), which forced an
// engine-host-specific index.html to live one level up. With root = here,
// engine-src/ (studio) and packages/forgeax/engine/ (release) are both
// self-contained vite roots — a single index.html serves /preview/, and the
// host-injected games dir (FORGEAX_PREVIEW_GAMES_DIR) is served under the vite
// root so its games resolve; run.sh symlinks it to the instance's actual dir.
const viteRoot = here;

// Vite only serves files below its root. The games directory is deliberately
// external and host-injected, so make a generated, stable in-root junction for
// the default URL namespace. An explicit FORGEAX_GAMES_URL_PREFIX remains an
// advanced host-owned mount contract; do not create arbitrary paths from it.
(function setupGamesRootFarm() {
  if (!PREVIEW_GAMES_DIR || GAMES_URL_PREFIX !== HOST_GAMES_FARM) return;
  const targetPath = resolve(PREVIEW_GAMES_DIR);
  if (!existsSync(targetPath)) {
    console.warn(`[forgeax] FORGEAX_PREVIEW_GAMES_DIR does not exist: ${targetPath}`);
    return;
  }
  const linkPath = resolve(here, HOST_GAMES_FARM);
  if (existsSync(linkPath)) {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink()) {
      console.warn(`[forgeax] refusing to replace non-symlink games mount: ${linkPath}`);
      return;
    }
    try {
      if (realpathSync(linkPath) === realpathSync(targetPath)) return;
    } catch { /* replace a stale/broken generated link below */ }
    try { unlinkSync(linkPath); } catch (e) {
      console.warn(`[forgeax] failed to replace games junction:`, e);
      return;
    }
  }
  try {
    symlinkSync(targetPath, linkPath, 'junction');
  } catch (e) {
    console.warn(`[forgeax] failed to create games junction:`, e);
  }
})();

// ── @forgeax packages to exclude from pre-bundle (SSOT-derived, no hand list) ──
// SSOT = THIS root's node_modules/@forgeax, i.e. exactly the @forgeax packages
// Vite can resolve natively here. Excluding precisely that set is correct on both
// sides:
//   - Pre-bundling any of them risks the OOM: under preserveSymlinks:true Vite's
//     esbuild pre-bundle crawls the nested workspace symlink graph
//     (packages/engine/packages/*/node_modules/@forgeax/* → ../../../*), where one
//     source file reached via combinatorially-many distinct symlink paths becomes
//     a distinct module → esbuild blew past 70 GB the moment a game imported the
//     un-excluded @forgeax/engine-physics (it also drags in the Rapier WASM).
//   - They are all present here, so excluding them (→ served as native ESM) still
//     resolves. We must NOT over-exclude: transitive-only packages absent from
//     node_modules (e.g. @forgeax/engine-plugin / engine-debug-draw, imported by
//     engine-app / engine-runtime) have to stay pre-bundlable, or native import
//     analysis fails with "Failed to resolve import". So derive ONLY from what's
//     actually here — never the full engine/packages source tree.
// Hand-listing was the original bug: it named ~10 packages and missed physics.
// @forgeax/scene shares the engine module subgraph; keep it excluded as before.
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

const PORT = Number(process.env.FORGEAX_ENGINE_PORT ?? 15173);
const HOST = process.env.FORGEAX_ENGINE_HOST ?? '0.0.0.0';

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

// Reject backup/snapshot dirs and hidden dot-dirs from being treated as games.
// Game optimize/migration tooling drops sibling backups like
// `<slug>.bak-1782212746` (a FULL copy, including `assets/`) under the games
// dir. Without this filter gameAssetRoots()/gameSlugs() count those
// as real games → the asset-root set differs from the boot snapshot →
// forgeaxGameRescan fires server.restart() (repeatedly, as more backups/tsconfig
// changes land) → the preview iframe gets ECONNREFUSED on :15173 during each
// restart window and sticks on "Loading game" forever.
const GAME_SLUG_REJECT_RE = /(^\.)|(\.bak(-|\.|$))/i;
function isRealGameSlug(slug: string): boolean {
  return !GAME_SLUG_REJECT_RE.test(slug);
}

// Games dir the pack scan walks. HOST-INJECTED via FORGEAX_PREVIEW_GAMES_DIR — the
// play-runtime holds ZERO on-disk layout convention; the host (studio run.ts /
// desktop build / editor standalone) points this at wherever it lays games out.
// Unset → empty (degraded: no roots scanned), never a baked layout literal.
function gamesDirRoot(): string {
  return PREVIEW_GAMES_DIR ? resolve(PREVIEW_GAMES_DIR) : '';
}

// URL-space games prefix the CLIENT (src/main.ts) prepends to build a game's
// served URL (`<base>/<prefix>/<id>/…`). Separate from gamesDirRoot() because the
// disk dir is symlinked UNDER the vite root, so the served URL reflects that mount
// point, not the abs disk path. Hosts may inject FORGEAX_GAMES_URL_PREFIX; with
// an injected games dir but no prefix, the generated host-games farm above is
// used. With neither, it is '' (game served directly under base).

// Scan every game's declared asset roots as pack roots. Uses the SSOT
// (package.json#forgeax.assets.roots via resolveGameAssetRoots, which also
// expands `@shared/<sub>` external roots) instead of hardcoding 'assets'.
// One-level glob over <gamesDir>/<slug>/<root> deliberately excludes nested
// dirs like shoot/backup/assets, whose .pack.json files reuse the same GUIDs
// and would trip the scanner's duplicate-guid guard (collapsing the catalog).
function gameAssetRoots(): string[] {
  const gamesDir = gamesDirRoot();
  if (!gamesDir) return [];
  if (!existsSync(gamesDir)) return [];
  const roots: string[] = [];
  for (const slug of readdirSync(gamesDir).filter(isRealGameSlug)) {
    const gameDir = join(gamesDir, slug);
    // resolveGameAssetRoots reads package.json#forgeax.assets.roots (SSOT),
    // resolves `@shared/<sub>` external roots against SHARED_BASE, and
    // existsSync-filters. farmPath redirects shared roots through the in-viteRoot
    // symlink so their scanned path (and thus relativeUrl) stays serveable.
    for (const r of resolveGameAssetRoots(gameDir, { sharedBase: SHARED_BASE, implicitSharedSubs: IMPLICIT_SHARED_SUBS })) {
      roots.push(farmPath(r));
    }
  }
  return roots;
}

// Per-game pack roots: the game's declared asset roots (local + `@shared/…`)
// from package.json#forgeax.assets.roots (SSOT), farm-rewritten so shared roots
// serve from under viteRoot. Scene packs live alongside other assets under the
// declared roots (A2/A3: scenes are ordinary assets).
function perGamePackRoots(slug: string): string[] {
  const gameDir = join(gamesDirRoot(), slug);
  return resolveGameAssetRoots(gameDir, { sharedBase: SHARED_BASE, implicitSharedSubs: IMPLICIT_SHARED_SUBS }).map(farmPath);
}

// Return slugs for every game directory under the host-injected games dir that
// has at least one (existing) declared asset root. Mirrors gameAssetRoots().
function gameSlugs(): string[] {
  const gamesDir = gamesDirRoot();
  if (!gamesDir || !existsSync(gamesDir)) return [];
  return readdirSync(gamesDir)
    .filter(isRealGameSlug)
    .filter((slug) => resolveGameAssetRoots(join(gamesDir, slug), { sharedBase: SHARED_BASE }).length > 0);
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
          const catalog = await buildPerGameCatalog(roots[0]!, '/preview', [...roots.slice(1)]);
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
          const catalog = await buildPerGameCatalog(roots[0]!, '/preview', [...roots.slice(1)]);
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
      const gamesDir = gamesDirRoot();
      if (!gamesDir) return; // host injected no games dir → nothing to watch
      const gamesDirNorm = gamesDir.split('\\').join('/');
      let known = new Set(gameAssetRoots());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const maybeRestart = (p: string) => {
        if (!p.split('\\').join('/').startsWith(gamesDirNorm)) return;
        const next = new Set(gameAssetRoots());
        const changed = next.size !== known.size || [...next].some((r) => !known.has(r));
        if (!changed) return;
        known = next;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          // Vite 6 bug: concurrent server.restart() calls race and deadlock the server
          // (https://github.com/vitejs/vite/issues/21636). Use a global lock on the
          // process to guarantee we never trigger a restart while one is already in flight.
          if ((process as any).__forgeax_restarting) return;
          console.log('[forgeax:game-rescan] asset roots changed → restarting vite');
          (process as any).__forgeax_restarting = true;
          server.restart().finally(() => {
            // Add a small debounce after restart completes before allowing another
            setTimeout(() => {
              (process as any).__forgeax_restarting = false;
            }, 1000);
          });
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
  // Inject the host-owned URL-space games prefix so the client builds game URLs
  // without a baked layout literal. '' → game served directly under base.
  define: { __FORGEAX_GAMES_URL_PREFIX__: JSON.stringify(GAMES_URL_PREFIX) },
  plugins: [
    forgeaxPackBaseStrip() as never,
    forgeaxPerGamePackBaseStrip() as never,
    // SINGLE pluginPack instance over every game's roots — LOCAL and `@shared/…`
    // alike (gameAssetRoots() now farm-rewrites shared roots into this one list;
    // there is no longer a separate sharedAssetRoots() appender — §1 SSOT).
    // It was once TWO instances (game roots, then shared) — but both register a
    // vite plugin named 'forgeax:pack', each mounting its OWN `/__import/:guid`
    // dev middleware. Middlewares run in registration order, and the handler
    // 404s (`meta-not-found`) + RETURNS on a GUID absent from its own catalog
    // instead of `next()`-ing. So the first (game-roots) instance swallowed
    // every request for a shared-asset GUID (the template sky.hdr equirect) →
    // the shared instance never saw it → `/__import/<sky>` 404 → solid-color
    // skylight fallback. ONE instance with the UNION of roots puts every GUID in
    // a single catalog + single middleware, so the cold-import cook path resolves
    // shared + per-game GUIDs alike. imageImporter is needed for the .hdr equirect
    // sidecar (else the bare .hdr is mislabeled rgba8unorm and
    // uploadCubemapFromEquirect rejects with `invalid-source-format`);
    // gltfImporter for per-game .glb cooks. A cross-root duplicate GUID no longer
    // collapses the catalog to []: buildCatalog (build-catalog.ts) degrades to a
    // per-root scan + first-wins de-dup, dropping only the offending root.
    pluginPack({
      roots: gameAssetRoots(),
      base: '/preview/',
      importers: [imageImporter, gltfImporter, fbxImporter],
    }) as never,
    forgeaxPerGamePackIndex() as never,
    forgeaxGameRescan() as never,
    silenceShaderEmitInServe(forgeaxShader()) as never,
  ],
  optimizeDeps: {
    // Exclude the ENTIRE @forgeax workspace family from Vite pre-bundling so each
    // is loaded as native ESM .mjs (engine outputs ESM .mjs; pre-bundling would
    // break source maps + module identity for the engine subgraph). Deriving the
    // full list (see forgeaxWorkspacePackages) is load-bearing: a game's
    // dynamically-imported main.ts (loadGame, not in the startup scan) may pull
    // ANY engine package or subpath (@forgeax/engine-physics,
    // @forgeax/engine-pack/guid, …); a missing entry lets Vite lazily pre-bundle
    // it and OOM esbuild on the preserveSymlinks symlink-diamond, besides the
    // new-game re-optimize flicker.
    exclude: FORGEAX_WS_PKGS,
    // Don't hold module requests until the static-import crawl finishes. With
    // preserveSymlinks:true over the @forgeax symlink-diamond, that crawl can run
    // very long / wedge — most visibly after an in-process server.restart()
    // (forgeaxGameRescan fires one whenever the active-workspace symlink flips or
    // a game is scaffolded). With holdUntilCrawlEnd:true (the default) Vite then
    // holds ALL requests behind the never-finishing crawl → the engine vite binds
    // :15173 but answers nothing (0% CPU) → the preview iframe never boots → Play
    // sticks on "Loading game" / black screen. We exclude the whole @forgeax
    // family anyway (nothing left to discover), so releasing after the scanner is
    // strictly better here and removes the wedge.
    holdUntilCrawlEnd: false,
  },
  resolve: {
    alias: {
      '@forgeax/game-types': resolve(here, 'src/types.ts'),
    },
    // Dedupe the whole @forgeax family (same SSOT-derived list as optimizeDeps):
    // every engine package must resolve to a single instance so ECS handles /
    // component identities match across the game subgraph. A hand-listed subset
    // had the same drift hazard as the old exclude list.
    dedupe: FORGEAX_WS_PKGS,
    // User game files live under the host-injected games dir, one dir per slug
    // (entry is a root-level main.ts, extra modules under src/), reachable via
    // run.sh's symlink of that dir under the vite root.
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
    // Perf "A": the studio shell (:18920) now fetches game assets straight from
    // this play-engine origin (:15173) instead of via its same-origin /preview
    // proxy, so asset traffic gets its OWN browser connection pool and can't
    // starve the shell API. That makes the requests cross-origin, and Vite 8
    // defaults `server.cors` to false — without this the browser blocks the
    // responses (no Access-Control-Allow-Origin). Reflect only the studio dev
    // origins (loopback, http+https); override via FORGEAX_ASSET_CORS_ORIGINS
    // (comma-separated) for non-default interface ports / remote gateways.
    cors: {
      origin: (process.env.FORGEAX_ASSET_CORS_ORIGINS
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean)) ?? [
        'http://127.0.0.1:18920',
        'http://localhost:18920',
        'https://127.0.0.1:18920',
        'https://localhost:18920',
      ],
    },
    watch: {
      usePolling: true,
      interval: 300,
      ignored: [
        '**/.forgeax/agenteam-state/**',
        '**/.forgeax/cache/**',
        '**/.forgeax/packs/**',
        '**/node_modules/**',
        // Game backup snapshots (`<slug>.bak-<ts>` / `<slug>.bak`) are NOT games;
        // ignore them so vite's tsconfig watcher won't force-reload on their
        // tsconfig.json and forgeaxGameRescan won't restart-loop (preview black
        // screen / stuck "Loading game"). Mirrors isRealGameSlug(). Derived from
        // the host-injected games dir — no baked layout literal.
        ...(gamesDirRoot() ? [
          `${gamesDirRoot()}/*.bak-*/**`,
          `${gamesDirRoot()}/*.bak/**`,
          // Prevent Vite's internal watcher from triggering concurrent restarts
          // when the workspace symlink flips and package.json/tsconfig.json change.
          `${gamesDirRoot()}/**/package.json`,
          `${gamesDirRoot()}/**/tsconfig.json`,
        ] : []),
      ],
    },
    fs: { allow: [viteRoot], strict: false },
    // HMR clientPort: when vite runs behind a reverse proxy the browser must
    // open the HMR websocket to the *gateway* port (usually 443), not the
    // internal vite port. FORGEAX_HMR_CLIENT_PORT overrides
    // FORGEAX_INTERFACE_PORT for exactly this case.
    hmr: {
      clientPort: Number(
        process.env.FORGEAX_HMR_CLIENT_PORT ?? process.env.FORGEAX_INTERFACE_PORT ?? 18920,
      ),
    },
  },
  // esnext: keep parity with edit-runtime — the engine host entry may use
  // top-level await; vite's default build target (es2020/chrome87/safari14)
  // forbids TLA. This runtime only runs in WKWebView/Chrome (TLA-capable) and
  // dev serve already runs it untranspiled, so esnext is safe.
  build: { outDir: resolve(here, 'dist'), target: 'esnext' },
});
