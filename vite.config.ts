// Vite config for the standalone editor chrome (`packages/editor/standalone/`).
//
// Single-purpose: serve `standalone/index.html` on :15290 so the AC-08
// command (`bun -F editor dev` then `curl -sf http://127.0.0.1:15290/`)
// returns 0. The editor iframe target stays at :15280, started separately
// from `packages/editor/packages/edit-runtime/`; OOS-8 explicitly forbids
// new ports, so :15290 reuses the legacy standalone-editor-demo slot
// (PORTS.md updated in w16).
//
// Anchors:
//   requirements AC-07 / AC-08 (standalone entry + listen contract)
//   plan-strategy 2 D-1 (atomic: editor consumer subtree owns its config)
//   OOS-8 (port reuse, no new ports)

import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

// `root = standalone/` so vite resolves index.html and `./main.tsx`
// without extra rewrite plumbing. The standalone host page itself does
// NOT render React — it only calls mountStandalone (a plain DOM ops
// path) and lets the editor iframe carry the actual surface, so we
// skip @vitejs/plugin-react. AppKit's React shell stays available via
// @forgeax/interface for future hosts that DO want to render `<App />`
// directly (plan §2 D-4 keeps the door open without tying this entry to
// the heavier interface bundle).
export default defineConfig({
  root: resolve(PACKAGE_DIR, 'standalone'),
  base: '/',
  server: {
    port: 15290,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    outDir: resolve(PACKAGE_DIR, 'dist'),
    emptyOutDir: true,
  },
});
