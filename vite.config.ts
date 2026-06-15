// Vite config for the standalone editor chrome (`packages/editor/standalone/`).
//
// Single-purpose: serve `standalone/index.html` on :15290 so the AC-08
// command (`bun -F editor dev` then `curl -sf http://127.0.0.1:15290/`)
// returns 0. The editor iframe target stays at :15280, started separately
// from `packages/editor/packages/edit-runtime/`; OOS-8 explicitly forbids
// new ports, so :15290 reuses the legacy standalone-editor-demo slot
// (PORTS.md updated in w16).
//
// Fix-up I-1 (option b): self-contained dockview container does NOT import
// @forgeax/interface — only needs @vitejs/plugin-react for JSX/TSX
// transpilation of standalone/main.tsx. No path aliases or cross-package
// optimizeDeps exclusions are needed because the dockview layout is
// built entirely within the editor package's own dependency graph
// (dockview + react + @forgeax/editor-core/manifest leaf module).
//
// Fix-up I-2: server.proxy '/editor' → http://127.0.0.1:15280 so that
// iframe src='/editor/?panel=...' in standalone/main.tsx resolves to the
// edit-runtime at :15280 instead of :15290.
//
// Anchors:
//   requirements AC-07 / AC-08 (standalone entry + listen contract)
//   plan-strategy 2 D-1 (atomic: editor consumer subtree owns its config)
//   OOS-8 (port reuse, no new ports)

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: resolve(PACKAGE_DIR, 'standalone'),
  base: '/',
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 15290,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      // Standalone shell's ep:* iframe src='/editor/?panel=...' must resolve
      // to the edit-runtime at :15280, not :15290. The proxy routes all
      // /editor/* requests to the edit-runtime vite dev server.
      // requirements §3 E-3 / fix-up I-2.
      '/editor': {
        target: 'http://127.0.0.1:15280',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: resolve(PACKAGE_DIR, 'dist'),
    emptyOutDir: true,
  },
});