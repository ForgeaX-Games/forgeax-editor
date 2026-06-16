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

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const STUDIO_ROOT = resolve(PACKAGE_DIR, '../..');
const INTERFACE_DIR = resolve(STUDIO_ROOT, 'packages/interface');

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
      '@forgeax/design/preset': resolve(STUDIO_ROOT, 'packages/design/preset.ts'),
      '@forgeax/design/theme': resolve(STUDIO_ROOT, 'packages/design/theme.ts'),
      '@forgeax/design/tokens.css': resolve(STUDIO_ROOT, 'packages/design/tokens.css'),
      '@forgeax/design': resolve(STUDIO_ROOT, 'packages/design/index.ts'),
      '@forgeax/types': resolve(STUDIO_ROOT, 'packages/types/src/index.ts'),
      '@forgeax/host-sdk': resolve(STUDIO_ROOT, 'packages/host-sdk/src/index.ts'),
    },
  },
  optimizeDeps: {
    // Same exclusion as interface vite — pre-bundle would drop named exports
    // that lazy editor-core code expects.
    exclude: ['@forgeax/engine-runtime'],
    // Pre-bundle DockShell's heavy ESM dep tree so the dev server's first
    // request doesn't stall on dozens of tiny module fetches.
    include: ['react', 'react-dom', 'react-dom/client', 'dockview', '@forgeax/interface'],
  },
  server: {
    port: 15290,
    strictPort: true,
    host: '127.0.0.1',
    fs: {
      // DockShell/EditorPanelFrame live in ../../interface/src; allow the
      // monorepo root so vite serves them.
      allow: [STUDIO_ROOT],
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
