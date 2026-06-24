// Vite config for the standalone editor chrome (`packages/editor/standalone/`).
// Serves :15290 with the React + DockShell + EditorPanelFrame self-rendered
// shell from standalone/main.tsx (plan §2 D-4 R3).
//
// Aliases mirror packages/interface/vite.config.ts so that DockShell's deep
// import chain (@forgeax/design/*, @forgeax/host-sdk, @/components/ui/*) all
// resolve identically here. Bun monorepo workspaces handle the workspace:*
// package imports (@forgeax/editor, @forgeax/editor-shared, dockview, react,
// react-dom, etc.) automatically.
//
// optimizeDeps.exclude='@forgeax/engine-runtime' — same reason as interface:
// pre-bundling drops some named exports the lazy editor-core code expects.
//
// server.proxy '/editor' -> :15280 so EditorPanelFrame's relative src
// `/editor/?panel=...` (rendered at :15290 origin) reaches edit-runtime.
//
// Anchors: AC-07, AC-08, AC-10, AC-11, plan §2 D-4 R3, §2 D-10b, §4 R-9 R3.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

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
const TYPES_SRC = resolve(STUDIO_ROOT, 'packages/types/src/index.ts');
const studioLayerAlias: Record<string, string> = {};
if (existsSync(HOST_SDK)) studioLayerAlias['@forgeax/host-sdk'] = HOST_SDK;
if (existsSync(TYPES_SRC)) studioLayerAlias['@forgeax/types'] = TYPES_SRC;

export default defineConfig({
  root: resolve(PACKAGE_DIR, 'standalone'),
  base: '/',
  plugins: [react()],
  resolve: {
    // dockview declares react as a peer dep; under bun's isolated node_modules
    // it can resolve a SECOND react copy and crash with "Invalid hook call /
    // resolveDispatcher null". Force a single instance.
    dedupe: ['react', 'react-dom'],
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
    // Same exclusion as interface vite — pre-bundle would drop named exports
    // that lazy editor-core code expects.
    exclude: ['@forgeax/engine-runtime'],
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
      // EditorPanelFrame writes `iframe.src = '/editor/?panel=<id>...'` —
      // a root-relative URL that, on :15290, would otherwise be served by the
      // standalone vite SPA fallback. Route the prefix to edit-runtime.
      '/editor': { target: 'http://127.0.0.1:15280', changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: resolve(PACKAGE_DIR, 'dist'),
    emptyOutDir: true,
  },
});
