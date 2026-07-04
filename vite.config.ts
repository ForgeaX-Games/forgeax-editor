// Vite config for the standalone editor chrome (`packages/editor/standalone/`).
// Serves :15290 with the React + DockShell shell from standalone/main.tsx, which
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
// Aliases mirror packages/interface/vite.config.ts so that DockShell's deep
// import chain (@forgeax/design/*, @forgeax/host-sdk, @/components/ui/*) all
// resolve identically here. Bun monorepo workspaces handle the workspace:*
// package imports (@forgeax/editor, @forgeax/editor-shared, dockview, react,
// react-dom, etc.) automatically.
//
// Anchors: AC-04, AC-05, AC-07, AC-08, plan-strategy S2 D4/D7, S3.1 host bundler
// layer, S4 R7, S5.6 selfcheck:b2 (9/9 held: --game /api proxy branch preserved).

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { engineVitePreset } from './packages/edit-runtime/src/engine/engine-vite-preset';

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

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
// this config (a §5 violation: "为启动自写一个独立后端"). Now `cli.mjs run --game`
// starts standalone/game-backend.ts — a tiny bun process mounting the REAL
// @forgeax/platform-io createFilesRouter (the exact 后L1 router cli/server use),
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
const GAME_API_PORT = Number(process.env.FORGEAX_GAME_API_PORT ?? 15281);

// D7: the shared engine-serve fragment. base '/' (this IS the host origin —
// shader/pack routes arrive un-prefixed, no base-strip needed); gameDirAbs =
// GAME_DIR so the in-process engine self-hosts the game's pack catalog
// (pack-index / __import / __forgeax-ddc) the SAME way edit-runtime did.
// preserveSymlinks:false — this host bundle pulls dockview + @radix-ui through
// packages/interface/node_modules; under preserveSymlinks vite resolves the
// symlinked interface to its realpath and then can't find those NESTED transitive
// deps, 500-ing the whole shell. The host relies on realpath dedupe instead
// (resolve.dedupe still collapses the @forgeax family to one instance). null
// (no --game) -> demo seed, shader plugin alone serves the manifest.
const enginePreset = engineVitePreset({ base: '/', gameDirAbs: GAME_DIR, preserveSymlinks: false });

// INTERFACE_DIR resolution — embedded vs standalone:
//   - Embedded in studio: the parent studio tree's packages/interface (../../
//     interface) is the canonical single copy; prefer it so editor shares the
//     same interface instance studio uses.
//   - Standalone clone: editor vendors interface as its own submodule at
//     packages/interface; use that.
const STUDIO_INTERFACE = resolve(PACKAGE_DIR, '../interface');
const VENDORED_INTERFACE = resolve(PACKAGE_DIR, 'packages/interface');
const INTERFACE_DIR = existsSync(resolve(STUDIO_INTERFACE, 'src/app-kit.ts'))
  ? STUDIO_INTERFACE
  : VENDORED_INTERFACE;
// @forgeax/design now lives inside the interface repo (packages/design), so it
// travels with whichever interface checkout we resolved above.
const DESIGN_DIR = resolve(INTERFACE_DIR, 'packages/design');
// host-sdk / types are studio-layer packages only exercised by the wb:* plugin
// path (studio-only; never rendered in the standalone editor shell). interface
// now imports host-sdk as TYPES ONLY (the runtime port factories are injected
// via PanelRenderers), so a standalone clone needs NO host-sdk runtime binding
// and NO stub — type-only imports are erased at build. We still alias to the
// real sources WHEN the studio tree is present (embedded mode) so types resolve.
const STUDIO_ROOT = resolve(PACKAGE_DIR, '../..');
const HOST_SDK = resolve(STUDIO_ROOT, 'packages/host-sdk/src/index.ts');
const TYPES_SRC = resolve(STUDIO_ROOT, 'packages/contracts/types/src/index.ts');
const studioLayerAlias: Record<string, string> = {};
if (existsSync(HOST_SDK)) studioLayerAlias['@forgeax/host-sdk'] = HOST_SDK;
if (existsSync(TYPES_SRC)) studioLayerAlias['@forgeax/types'] = TYPES_SRC;

export default defineConfig({
  root: resolve(PACKAGE_DIR, 'standalone'),
  base: '/',
  // react() + the D7 engine-serve plugins (shader manifest emit + optional
  // self-hosted pluginPack catalog). This is what lets the engine boot
  // in-process in this host window (no /editor proxy).
  plugins: [react(), ...enginePreset.plugins],
  // Expose the game slug + abs dir to the standalone client bundle. The slug
  // pins the game (setPinnedSlug) and threads ?scene=/?gameRoot=; the abs dir
  // (__FORGEAX_GAME_DIR_ABS__) is read by the in-process engine boot (host-boot
  // / ViewportComponent) exactly as edit-runtime's config injected it — it
  // selects the self-hosted pack routes + the Play @fs game-entry base. null =
  // no --game (demo seed).
  define: {
    __FORGEAX_GAME_SLUG__: JSON.stringify(GAME_SLUG),
    __FORGEAX_GAME_DIR_ABS__: JSON.stringify(GAME_DIR),
  },
  resolve: {
    // dockview declares react as a peer dep; under bun's isolated node_modules
    // it can resolve a SECOND react copy and crash with "Invalid hook call /
    // resolveDispatcher null". Force a single instance. D7: also dedupe the whole
    // @forgeax family (preset.resolve.dedupe) so the in-process engine + editor
    // packages resolve to one realpath. preserveSymlinks stays false here (the
    // preset default is overridden to false for this host — see the preset call)
    // because dockview/@radix nested deps live under the interface symlink target.
    dedupe: enginePreset.resolve.dedupe,
    preserveSymlinks: enginePreset.resolve.preserveSymlinks,
    alias: {
      // Order matters — vite picks first matching prefix. Most-specific first.
      '@/': `${resolve(INTERFACE_DIR, 'src')}/`,
      // @forgeax/interface package.json's exports map covers `./*: ./src/*.ts`
      // and `./styles/*.css`, but does NOT cover the `.tsx` files we deep-
      // import (DockShell.tsx etc.). Alias the package root to the source
      // directory so vite resolves any subpath, .ts/.tsx/.css alike.
      '@forgeax/interface/styles/global.css': resolve(INTERFACE_DIR, 'src/styles/global.css'),
      '@forgeax/interface/components': resolve(INTERFACE_DIR, 'src/components'),
      '@forgeax/design/preset': resolve(DESIGN_DIR, 'preset.ts'),
      '@forgeax/design/theme': resolve(DESIGN_DIR, 'theme.ts'),
      '@forgeax/design/tokens.css': resolve(DESIGN_DIR, 'tokens.css'),
      '@forgeax/design': resolve(DESIGN_DIR, 'index.ts'),
      // host-sdk / types only when the studio tree is present (embedded mode).
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
    // Pre-bundle react so the single-instance dedupe holds. dockview /
    // @forgeax/interface are NOT listed: optimizeDeps.include resolves from the
    // vite ROOT (standalone/), but those packages live in the vendored
    // interface's own node_modules (resolvable from DockShell.tsx's location,
    // not from the root). Vite auto-discovers and optimizes them on first
    // crawl from the actual import sites, so listing them here only produced a
    // spurious "Failed to resolve dependency" warning.
    include: ['react', 'react-dom', 'react-dom/client'],
  },
  server: {
    port: 15290,
    strictPort: true,
    host: '127.0.0.1',
    fs: {
      // DockShell/EditorPanelFrame + design live under INTERFACE_DIR (the
      // vendored submodule when standalone, or the studio sibling when
      // embedded). Allow the editor root (covers packages/interface) and, when
      // embedded, the studio root so the shared interface copy is served too.
      allow: existsSync(resolve(STUDIO_ROOT, 'package.json'))
        ? [PACKAGE_DIR, STUDIO_ROOT]
        : [PACKAGE_DIR],
    },
    proxy: {
      // D7: the `/editor` -> :15280 proxy is DELETED. The engine now boots
      // in-process in this host window (single realm, AC-04), so there is no
      // edit-runtime iframe to proxy to. The shader manifest + pack catalog are
      // served locally by enginePreset.plugins.
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
});
