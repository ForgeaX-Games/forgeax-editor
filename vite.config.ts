// Vite config for the standalone editor chrome (`apps/standalone/`).
// Serves :15290 with the React + DockShell shell from apps/standalone/main.tsx, which
// (post-M2) boots the forgeax engine IN-PROCESS in this host window and renders
// the viewport + ep:* panels as in-process components — no edit-runtime iframe.
//
// REPLAN D7 (in-process engine serve): this host bundler now serves the engine
// itself (shader manifest, pack-index / __import catalog, symlink-dedupe, TLA
// esnext) by consuming engineVitePreset — the SAME shared serve fragment
// edit-runtime/vite.config.ts uses. Before M2 this config had only react() + an
// `/editor` -> :15280 proxy and borrowed edit-runtime's serve through an iframe;
// M2 deletes that proxy because the engine is served here directly (S4 R7:
// without engine serve the in-process boot's fetch('/shaders/manifest.json')
// 404s and createApp fails).
//
// Interface resolves through its published package exports. Editor
// and engine source workspaces retain the host-owned identity aliases below.
//
// Anchors: AC-04, AC-05, AC-07, AC-08, plan-strategy S2 D4/D7, S3.1 host bundler
// layer, S4 R7, S5.6 selfcheck:b2 (9/9 held: --game /api proxy branch preserved).

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, resolve, basename, join } from 'node:path';
import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { ENGINE_EXECUTION_ISOLATION_HEADERS, engineVitePreset, resolveGameEngineEntry } from './scripts/vite/engine-vite-preset';
import { resolveViteFsAllowRoots } from './scripts/vite/vite-fs-allow';
import { runtimeScopePath, type RuntimeAssetBinding } from '@forgeax/engine-types';
import { resolveWorktreePorts } from './scripts/lib/worktree-ports.ts';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const WORKTREE_PORTS = resolveWorktreePorts(PACKAGE_DIR);

// ── standalone game backend — REUSE platform-io (R3, ideal-clean-architecture §5) ─
// The standalone stack has NO studio server (forgeax-server :18900 is studio-only).
// editor-core reaches its backend through the injected ApiClient (R2 seam); its
// DEFAULT client is relative `/api` (base=''), and the standalone editor iframe's
// document origin IS this :15290 host (its src `/editor/…` is proxied here), so a
// bare fetch('/api/files…') resolves to this :15290 origin. Raw media
// (`<img src="/api/files/raw?…">`) are plain relative DOM URLs that bypass the
// ApiClient entirely, so the backend MUST be reachable same-origin from :15290.
//
// Before R3 this shipped a SECOND, hand-written READ-ONLY file backend inline in
// this config (a §5 violation: "为启动自写一个独立后端"). Now `bun fx start --game`
// starts apps/standalone/game-backend.ts — a tiny bun process mounting the REAL
// @forgeax/platform-io createFilesRouter (the shared file router used by cli/server),
// confined to one game via singleGameFileBackend — and this config simply PROXIES
// /api → that process. (It can't be a vite middleware: vite 8 loads its config
// through Node's ESM loader, which can't resolve platform-io's extensionless `.ts`
// barrel re-exports; bun can, which is why the separate bun process works.) One
// wire contract, read+write (B2), zero duplicated IO logic.
//
// The slug (basename) is the opaque client-space key threaded through iframe URLs.
// No --game → GAME_DIR null → no /api proxy → the demo-seed path is unchanged.
const GAME_DIR = process.env.FORGEAX_GAME_DIR
  ? resolve(process.env.FORGEAX_GAME_DIR)
  : null;
const GAME_SLUG = GAME_DIR ? basename(GAME_DIR) : null;
const STANDALONE_SCOPE_ID = process.env.FORGEAX_RUNTIME_SCOPE_ID
  ?? (GAME_SLUG === null ? '' : `standalone-${GAME_SLUG}`);
const STANDALONE_GENERATION = Number(process.env.FORGEAX_RUNTIME_GENERATION ?? 1);
const STANDALONE_RUNTIME_BINDING: RuntimeAssetBinding | undefined = (
  GAME_DIR !== null
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
  catalogUrl: runtimeScopePath({ scopeId: STANDALONE_SCOPE_ID, generation: STANDALONE_GENERATION }, 'catalog.json'),
  importUrlBase: runtimeScopePath({ scopeId: STANDALONE_SCOPE_ID, generation: STANDALONE_GENERATION }, 'import'),
  packageUrlBase: runtimeScopePath({ scopeId: STANDALONE_SCOPE_ID, generation: STANDALONE_GENERATION }, 'asset'),
} : undefined;
const GAME_API_PORT = Number(process.env.FORGEAX_GAME_API_PORT ?? WORKTREE_PORTS.gameApi);
const EDIT_RUNTIME_PORT = Number(process.env.FORGEAX_EDIT_RUNTIME_PORT ?? WORKTREE_PORTS.editRuntime);
// The standalone host owns the editor chrome, while the pure engine preview is
// served by the separate play-runtime. Keep the proxy target on the same port
// SSOT used by `bun fx start --play`.
const PLAY_RUNTIME_PORT = Number(process.env.FORGEAX_ENGINE_PORT ?? WORKTREE_PORTS.playRuntime);
// The normal editor host remains :15290.  B2 self-boot deliberately supplies a
// private free port, though: its self-hosted runner is persistent and can retain
// a prior dev-server process, so probing the fixed human-development port can
// otherwise block on an unrelated listener before this Vite instance has bound.
const STANDALONE_PORT = Number(process.env.FORGEAX_STANDALONE_PORT ?? WORKTREE_PORTS.standalone);

// D7: the shared engine-serve fragment. base '/' (this IS the host origin —
// shader/pack routes arrive un-prefixed, no base-strip needed); gameDirAbs =
// GAME_DIR so the in-process engine self-hosts the game's pack catalog
// (pack-index / __import / __forgeax-ddc) the SAME way edit-runtime did.
// preserveSymlinks:false — published packages and their nested dependencies
// resolve through their real paths. The host relies on realpath dedupe
// (resolve.dedupe still collapses the @forgeax family to one instance). null
// (no --game) -> demo seed, shader plugin alone serves the manifest.
const enginePreset = engineVitePreset({
  base: '/',
  gameDirAbs: GAME_DIR,
  preserveSymlinks: false,
  ...(STANDALONE_RUNTIME_BINDING === undefined ? {} : { runtimeBinding: STANDALONE_RUNTIME_BINDING }),
});
const CLIENT_RUNTIME_BINDING = STANDALONE_RUNTIME_BINDING === undefined
  ? undefined
  : { ...STANDALONE_RUNTIME_BINDING, catalogRoots: enginePreset.catalogRoots };

// Keep the standalone host on one engine checkout. The host root lives above
// the workspace packages and does not have a direct node_modules link for every
// engine package. Vite can therefore walk into the parent checkout's Bun
// install for packages such as engine-app and engine-render-graph, while the
// game-entry resolver correctly anchors its imports to this worktree. That
// split creates two ECS/component-token realms: a SceneInstance written by one
// World is invisible to the other. Use the game-entry resolver's producer roots
// so both hoisted and isolated installs stay on this checkout.
const editRuntimeRequire = createRequire(resolve(PACKAGE_DIR, 'packages/edit-runtime/package.json'));
// The standalone host executes engine-ui's CSS authoring path in the browser.
// Anchor its third-party parser to the exact dependency owned by engine-ui so
// Vite does not pick a second copy from Bun's root store.
const engineUiRequire = createRequire(editRuntimeRequire.resolve('@forgeax/engine-ui/package.json'));
const CSS_TREE_DIR = dirname(realpathSync(engineUiRequire.resolve('css-tree/package.json')));
const SOURCE_MAP_JS_DIR = dirname(realpathSync(createRequire(join(CSS_TREE_DIR, 'package.json')).resolve('source-map-js/package.json')));
// The standalone host is rooted at apps/standalone, so Node/Vite cannot walk
// into the Engine package that owns @noble/hashes. The shared Engine preset
// still pre-bundles Noble subpaths for the animation/pack importers; anchor the
// host-side resolver to that producer-owned copy so the optimizer never serves
// a 504 for an unresolved deep import on a cold Bun checkout.
const engineAnimationRequire = createRequire(editRuntimeRequire.resolve('@forgeax/engine-animation/package.json'));
const NOBLE_HASHES_DIR = dirname(realpathSync(engineAnimationRequire.resolve('@noble/hashes')));
const engineWorktreeResolve = {
  name: 'forgeax:standalone-engine-worktree-resolve',
  enforce: 'pre' as const,
  resolveId(id: string): string | null {
    if (id === '@forgeax/engine-plugin') {
      return resolve(PACKAGE_DIR, 'scripts/vite/engine-plugin-browser.ts');
    }
    if (!id.startsWith('@forgeax/engine-')) return null;
    // The dedupe roster contains only direct host dependencies in an isolated
    // install. Resolve transitive imports through the same browser export map
    // used by game sources, then collapse workspace links to one Engine identity.
    const entry = resolveGameEngineEntry(id);
    return entry === null ? null : realpathSync(entry);
  },
};

// Types are supplied by Studio when embedded and vendored for standalone use.
const STUDIO_ROOT = resolve(PACKAGE_DIR, '../..');
const STUDIO_MANIFEST = resolve(STUDIO_ROOT, 'package.json');
const TYPES_SRC = resolve(STUDIO_ROOT, 'packages/contracts/types/src/index.ts');
const VENDORED_TYPES_SRC = resolve(PACKAGE_DIR, 'packages/contracts/types/src/index.ts');
// An editor worktree lives at `<editor>/.worktrees/<name>`, so `../..` points
// at the primary editor checkout. The contracts submodule exists there too
// and therefore cannot distinguish Studio embedding from standalone worktree
// use. The root manifest is the stable Studio boundary discriminator.
const HAS_STUDIO_LAYER = existsSync(STUDIO_MANIFEST);
const studioLayerAlias: Record<string, string> = {};
if (HAS_STUDIO_LAYER && existsSync(TYPES_SRC)) {
  studioLayerAlias['@forgeax/types'] = TYPES_SRC;
} else if (existsSync(VENDORED_TYPES_SRC)) {
  // Standalone editor clones vendor contracts as a submodule instead of
  // sharing the studio checkout's packages/contracts path.
  studioLayerAlias['@forgeax/types'] = VENDORED_TYPES_SRC;
}

// Keep the standalone host's optimizer boundary limited to direct published
// dependencies and the host's existing parser inputs. Pre-bundle the public
// Interface entrypoints so their transitive imports are discovered up front.
const STANDALONE_OPTIMIZE_DEPS = [
  'react',
  'react-dom',
  'react-dom/client',
  '@forgeax/interface/ApplicationShell',
  '@forgeax/interface/application',
  // engine-ui is served as native workspace ESM, but css-tree's browser ESM
  // imports source-map-js through a CommonJS file. Pre-bundle the parser at
  // the host boundary so the browser never receives raw CommonJS code.
  'css-tree',
  'source-map-js/lib/source-map-generator.js',
] as const;

export default defineConfig({
  root: resolve(PACKAGE_DIR, 'apps/standalone'),
  base: '/',
  // The standalone host shares this repository with other Vite entry points
  // (notably play-runtime). Keep its optimizer output separate so an update in
  // one entry point cannot invalidate dependency URLs while the other is serving
  // a page. The directory is covered by the repository-wide `.vite/` ignore.
  cacheDir: process.env.FORGEAX_VITE_CACHE_ROOT
    ? resolve(process.env.FORGEAX_VITE_CACHE_ROOT, 'standalone-host')
    : resolve(PACKAGE_DIR, '.vite/standalone-host'),
  // react() + the D7 engine-serve plugins (shader manifest emit + optional
  // self-hosted pluginPack catalog). This is what lets the engine boot
  // in-process in this host window (no /editor proxy).
  plugins: [react(), engineWorktreeResolve, ...enginePreset.plugins],
  // Expose the game slug + abs dir to the standalone client bundle. The slug
  // pins the game (setPinnedSlug) and threads ?scene=/?gameRoot=; the abs dir
  // (__FORGEAX_GAME_DIR_ABS__) is read by the in-process engine boot (host-boot
  // / ViewportComponent) exactly as edit-runtime's config injected it — it
  // selects the self-hosted pack routes + the Play @fs game-entry base. null =
  // no --game (demo seed).
  define: {
    __FORGEAX_GAME_SLUG__: JSON.stringify(GAME_SLUG),
    __FORGEAX_GAME_DIR_ABS__: JSON.stringify(GAME_DIR),
    __FORGEAX_RUNTIME_BINDING__: JSON.stringify(CLIENT_RUNTIME_BINDING ?? null),
    // The Vite preset derives this from the same package.json roots it passes to
    // pluginPack. Content Browser uses the projection to classify catalog
    // sourcePath values without knowing where @shared roots live on disk.
    __FORGEAX_CATALOG_ASSET_ROOTS__: JSON.stringify(enginePreset.catalogRoots),
    // TEMPORARY: smoke tests set FORGEAX_STANDALONE_FORCE_IFRAME=1 to keep the
    // iframe carrier path while GPU device-lost during page reloads is unresolved.
    // Remove once single-realm mode handles graceful GPU disposal on navigation.
    __FORGEAX_STANDALONE_FORCE_IFRAME__: JSON.stringify(process.env.FORGEAX_STANDALONE_FORCE_IFRAME === '1'),
  },
  resolve: {
    // dockview declares react as a peer dep; under bun's isolated node_modules
    // it can resolve a SECOND react copy and crash with "Invalid hook call /
    // resolveDispatcher null". Force a single instance. D7: also dedupe the whole
    // @forgeax family (preset.resolve.dedupe) so the in-process engine + editor
    // packages resolve to one realpath. preserveSymlinks stays false here (the
    // preset default is overridden to false for this host — see the preset call)
    // so published packages and their nested dependencies resolve by real path.
    dedupe: enginePreset.resolve.dedupe,
    preserveSymlinks: enginePreset.resolve.preserveSymlinks,
    alias: {
      // Order matters — vite picks first matching prefix. Most-specific first.
      // Engine specifiers are handled by the exact-match resolver above. Do not
      // add them here: Vite's prefix aliasing would turn
      // `engine-render/internal/construct-renderer` into
      // `dist/internal.mjs/construct-renderer`.
      'css-tree': CSS_TREE_DIR,
      'source-map-js': SOURCE_MAP_JS_DIR,
      '@noble/hashes': NOBLE_HASHES_DIR,
      // The editor-family root aliases below intentionally bypass package
      // exports to keep one Vite module identity. Keep this concrete runtime
      // subpath ahead of the root alias so the diagnostics projection remains
      // resolvable in the standalone host as well as in Bun's package loader.
      '@forgeax/editor-core/diagnostics': resolve(PACKAGE_DIR, 'packages/core/src/io/diagnostics.ts'),
      // Keep every editor package on the same source URL in the standalone
      // host. Workspace symlinks are realpath-deduped, but a package self-import
      // can still resolve through a second Vite module key; that splits the
      // Gateway/selection singleton and makes AI selection invisible to panels.
      // Alias the editor family at the host boundary so panels, runtime, and
      // the eval channel all import one module graph.
      '@forgeax/editor-core': resolve(PACKAGE_DIR, 'packages/core/src'),
      '@forgeax/editor-content-browser': resolve(PACKAGE_DIR, 'packages/content-browser/src'),
      '@forgeax/editor-panels': resolve(PACKAGE_DIR, 'packages/panels/src'),
      '@forgeax/editor-product': resolve(PACKAGE_DIR, 'packages/product/src'),
      // Shared contracts only when the Studio tree is present (embedded mode).
      ...studioLayerAlias,
    },
  },
  optimizeDeps: {
    // D7: exclude the ENTIRE @forgeax workspace family (engine-* + editor-*)
    // from pre-bundle — served as native ESM, single instance (SSOT-derived by
    // the preset, cannot drift). This supersedes the old single
    // '@forgeax/engine-runtime' exclusion: the in-process engine boot pulls the
    // whole family, and pre-bundling any of it under preserveSymlinks OOMs on
    // the nested symlink graph (see preset comment).
    exclude: enginePreset.optimizeDeps.exclude,
    // Published Interface entrypoints and React are direct root dependencies;
    // their optimizer identities stay stable alongside the engine parser inputs.
    include: [...enginePreset.optimizeDeps.include, ...STANDALONE_OPTIMIZE_DEPS],
    // Never mutate the optimizer manifest in response to a late lazy import.
    // The include list above is the host's dependency boundary; native ESM
    // modules outside it stay on Vite's normal transform path.
    noDiscovery: true,
  },
  server: {
    port: STANDALONE_PORT,
    strictPort: true,
    host: '127.0.0.1',
    headers: ENGINE_EXECUTION_ISOLATION_HEADERS,
    fs: {
      allow: resolveViteFsAllowRoots({
        packageDir: PACKAGE_DIR,
        gameDir: GAME_DIR,
        extra: HAS_STUDIO_LAYER ? [STUDIO_ROOT] : [],
      }),
      strict: false,
    },
    proxy: {
      // The persistent shell owns chrome/panels; the replaceable Viewport Runtime
      // is served behind this same-origin carrier path. Worktree port assignment
      // remains the only port policy.
      '/editor': { target: `http://127.0.0.1:${EDIT_RUNTIME_PORT}`, changeOrigin: true, ws: true },
      //
      // The standalone preview is the opposite boundary: `/preview/` must stay
      // a pure play-runtime page, never the editor SPA fallback. Proxy its
      // engine-owned transport paths to the dedicated play-runtime server.
      '/preview': { target: `http://127.0.0.1:${PLAY_RUNTIME_PORT}`, changeOrigin: true, ws: true },
      //
      // --game: proxy /api → the standalone game-backend bun process (R3), which
      // mounts the real @forgeax/platform-io createFilesRouter confined to the
      // game. Same-origin from :15290 so editor-core's relative fetch('/api/…')
      // and raw-media <img src="/api/files/raw…"> both reach it. No --game → no
      // entry → /api 404s through the SPA fallback (demo-seed path, unchanged).
      // selfcheck:b2 (9/9) exercises exactly this branch — do NOT remove it.
      ...(GAME_DIR
        ? { '/api': { target: `http://127.0.0.1:${GAME_API_PORT}`, changeOrigin: true } }
        : {}),
    },
  },
  build: {
    outDir: resolve(PACKAGE_DIR, 'dist'),
    emptyOutDir: true,
    // esnext: the in-process engine boot entry uses top-level await (D7 preset).
    target: enginePreset.build.target,
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss({
          config: {
            darkMode: ['selector', '[data-theme="dark"]'],
            theme: {
              extend: {
                colors: {
                  border: 'var(--fx-border, #404040)',
                  input: 'var(--fx-border, #404040)',
                  ring: 'var(--fx-accent, #D4FF48)',
                  background: 'var(--fx-bg, #0D0D0D)',
                  foreground: 'var(--fx-fg, #FFFFFF)',
                  muted: { DEFAULT: 'var(--fx-bg-elev2, #191919)', foreground: 'var(--fx-fg-muted, rgba(255,255,255,0.6))' },
                  card: { DEFAULT: 'var(--fx-bg-elev1, #242424)', foreground: 'var(--fx-fg, #FFFFFF)' },
                  popover: { DEFAULT: 'var(--fx-bg-elev1, #242424)', foreground: 'var(--fx-fg, #FFFFFF)' },
                  accent: { DEFAULT: 'var(--fx-accent, #D4FF48)', foreground: 'var(--fx-bg, #0D0D0D)' },
                  primary: { DEFAULT: 'var(--fx-accent, #D4FF48)', foreground: 'var(--fx-bg, #0D0D0D)' },
                  secondary: { DEFAULT: 'var(--fx-bg-elev2, #191919)', foreground: 'var(--fx-fg, #FFFFFF)' },
                  destructive: { DEFAULT: 'var(--fx-danger, #BE3636)', foreground: 'var(--fx-fg, #FFFFFF)' },
                  success: { DEFAULT: 'var(--fx-success, #1B9D4B)' },
                  danger: { DEFAULT: 'var(--fx-danger, #BE3636)' },
                  info: { DEFAULT: 'var(--fx-info, #639CF8)' },
                },
                borderRadius: { lg: 'var(--radius-lg, 12px)', md: 'var(--radius-md, 8px)', sm: 'var(--radius-sm, 4px)' },
              },
            },
            content: [
              resolve(PACKAGE_DIR, 'apps/standalone/**/*.{ts,tsx}'),
              resolve(PACKAGE_DIR, 'packages/ui/src/**/*.{ts,tsx}'),
              resolve(PACKAGE_DIR, 'packages/content-browser/src/**/*.{ts,tsx}'),
            ],
            corePlugins: { preflight: false },
          },
        }),
        autoprefixer(),
      ],
    },
  },
});
