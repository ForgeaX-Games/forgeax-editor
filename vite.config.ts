// Vite config for the standalone editor chrome (`packages/editor/standalone/`).
//
// Single-purpose: serve `standalone/index.html` on :15290 so the AC-08
// command (`bun -F editor dev` then `curl -sf http://127.0.0.1:15290/`)
// returns 0. The editor iframe target stays at :15280, started separately
// from `packages/editor/packages/edit-runtime/`; OOS-8 explicitly forbids
// new ports, so :15290 reuses the legacy standalone-editor-demo slot
// (PORTS.md updated in w16).
//
// Anchor updates (fix-up I-1, I-2):
//   plan-strategy 2 D-10 — DockShell reuse from @forgeax/interface requires
//     @vitejs/plugin-react (JSX/TSX transpilation), path aliases matching
//     interface's own vite.config.ts (so @/components/ui/*, @forgeax/design/*,
//     @forgeax/host-sdk etc. resolve), and optimizeDeps.exclude for
//     @forgeax/engine-runtime (pure-ESM re-export collision).
//   requirements §3 E-3 — standalone shell ep:* iframe URLs must resolve to
//     :15280, not :15290. The server.proxy config routes '/editor' to
//     http://127.0.0.1:15280 so that DockShell's EditorPanelFrame iframe src
//     ('/editor/?panel=...') resolves correctly in the standalone origin.
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

// Absolute paths to interface's packages so that aliases resolve even when
// the standalone vite root is `standalone/` rather than the monorepo root.
const INTERFACE_SRC = resolve(PACKAGE_DIR, '../interface/src');
const INTERFACE_DESIGN = resolve(PACKAGE_DIR, '../interface/../design');
const INTERFACE_TYPES = resolve(PACKAGE_DIR, '../interface/../types/src/index.ts');
const INTERFACE_HOST_SDK = resolve(PACKAGE_DIR, '../interface/../host-sdk/src/index.ts');

export default defineConfig({
  plugins: [react()],
  root: resolve(PACKAGE_DIR, 'standalone'),
  base: '/',
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@forgeax/design/preset': resolve(INTERFACE_DESIGN, 'preset.ts'),
      '@forgeax/design/theme': resolve(INTERFACE_DESIGN, 'theme.ts'),
      '@forgeax/design/tokens.css': resolve(INTERFACE_DESIGN, 'tokens.css'),
      '@forgeax/design': resolve(INTERFACE_DESIGN, 'index.ts'),
      '@forgeax/types': INTERFACE_TYPES,
      '@forgeax/host-sdk': INTERFACE_HOST_SDK,
      '@': INTERFACE_SRC,
    },
  },
  // @forgeax/engine-runtime is pure ESM with hundreds of named exports. Vite's
  // optimizeDeps re-bundle would only re-export the subset its top-level scan
  // sees, then lazy-loaded import chains blow up at runtime. Skip pre-bundle.
  optimizeDeps: {
    exclude: ['@forgeax/engine-runtime', '@forgeax/engine-gltf'],
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