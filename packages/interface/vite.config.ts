import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { vitePluginBrand } from './vite-plugin-brand';

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_ENV = resolve(PACKAGE_DIR, '../../.env');
if (existsSync(ROOT_ENV)) {
  for (const line of readFileSync(ROOT_ENV, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const SERVER = process.env.FORGEAX_SERVER_URL ?? 'http://127.0.0.1:18900';
const SERVER_WS = SERVER.replace(/^http/, 'ws');
const ENGINE = process.env.FORGEAX_ENGINE_URL ?? 'http://127.0.0.1:15173';
const ENGINE_WS = ENGINE.replace(/^http/, 'ws');
const EDITOR = process.env.FORGEAX_EDITOR_URL ?? 'http://127.0.0.1:15280';
const REEL = process.env.FORGEAX_REEL_URL ?? 'http://127.0.0.1:15175';

const HTTPS_ENABLED = process.env.FORGEAX_INTERFACE_HTTPS === '1';

// Prefer a hand-rolled cert at `<root>/.tls/{cert,key}.pem` (covers remote IPs
// in SAN); fall back to package-local then @vitejs/plugin-basic-ssl (localhost only).
const ROOT_TLS = resolve(PACKAGE_DIR, '../../.tls');
const tlsCertPath = existsSync(resolve(ROOT_TLS, 'cert.pem')) ? resolve(ROOT_TLS, 'cert.pem') : resolve(PACKAGE_DIR, '.tls/cert.pem');
const tlsKeyPath = existsSync(resolve(ROOT_TLS, 'key.pem')) ? resolve(ROOT_TLS, 'key.pem') : resolve(PACKAGE_DIR, '.tls/key.pem');
const useCustomCert = HTTPS_ENABLED && existsSync(tlsCertPath) && existsSync(tlsKeyPath);
const httpsServerOption = useCustomCert
  ? { cert: readFileSync(tlsCertPath), key: readFileSync(tlsKeyPath) }
  : undefined;

export default defineConfig({
  plugins: [
    vitePluginBrand({ packageDir: PACKAGE_DIR }),
    react(),
    ...(HTTPS_ENABLED && !useCustomCert ? [basicSsl()] : []),
  ],
  resolve: {
    // dockview declares react as a peer dep; under bun's isolated node_modules it
    // can resolve a SECOND react copy → "Invalid hook call / resolveDispatcher
    // null". Force a single react instance for all imports (incl. dockview).
    dedupe: ['react', 'react-dom'],
    alias: {
      // More specific subpaths first — Vite matches string aliases by prefix
      // and uses the first hit, so '@forgeax/design' must come last.
      '@/': `${resolve(PACKAGE_DIR, 'src')}/`,
      // @forgeax/design now lives inside the interface repo (packages/design)
      // so the interface submodule is self-contained when vendored by editor.
      '@forgeax/design/preset': resolve(PACKAGE_DIR, 'packages/design/preset.ts'),
      '@forgeax/design/theme': resolve(PACKAGE_DIR, 'packages/design/theme.ts'),
      '@forgeax/design/tokens.css': resolve(PACKAGE_DIR, 'packages/design/tokens.css'),
      '@forgeax/design': resolve(PACKAGE_DIR, 'packages/design/index.ts'),
      '@forgeax/types': resolve(PACKAGE_DIR, '../contracts/types/src/index.ts'),
      '@forgeax/host-sdk': resolve(PACKAGE_DIR, '../host-sdk/src/index.ts'),
    },
  },
  // @forgeax/engine-runtime is pure ESM with hundreds of named exports. Vite's
  // optimizeDeps re-bundle would only re-export the subset its top-level scan
  // sees, then lazy-loaded editor-core imports (Skin, SceneInstance, …) blow
  // up at runtime with "does not provide an export named X". Skip pre-bundle
  // and serve the dist's index.mjs directly.
  optimizeDeps: {
    exclude: ['@forgeax/engine-runtime'],
  },
  server: {
    port: Number(process.env.FORGEAX_INTERFACE_PORT ?? 18920),
    host: '0.0.0.0',
    strictPort: true,
    open: false,
    // Vite 5+ rejects requests whose Host header isn't localhost/127.0.0.1
    // by default. When the dev server is fronted by a platform-provided
    // domain (e.g. cloud dev-environment gateway), that Host header check
    // fails and the SPA gets "Blocked request. This host is not allowed."
    //
    // Set FORGEAX_INTERFACE_ALLOWED_HOSTS to a comma-separated host list,
    // or to the literal value "true" (case-insensitive) to allow every
    // Host. Unset — or a value that reduces to zero non-empty hosts —
    // keeps vite's safer default (localhost only).
    //
    // Vite matches each host entry as follows:
    //   - exact match          "api.example.com"    -> api.example.com
    //   - leading-dot wildcard ".example.com"       -> example.com AND
    //                                                  *.example.com
    ...(() => {
      const raw = process.env.FORGEAX_INTERFACE_ALLOWED_HOSTS;
      if (raw === undefined) return {};
      const trimmed = raw.trim();
      if (trimmed === '') return {};
      if (trimmed.toLowerCase() === 'true') return { allowedHosts: true as const };
      const hosts = trimmed
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean);
      // Empty after filter means the value was pure whitespace/commas — fall
      // back to vite's safe default (skip the key entirely) rather than
      // silently forbidding every non-loopback request.
      return hosts.length > 0 ? { allowedHosts: hosts } : {};
    })(),
    ...(httpsServerOption !== undefined ? { https: httpsServerOption } : {}),
    // Native FSEvents (usePolling:false) — ~0-cost when idle. This package
    // watches only its own src (no symlinked dirs), so native events are
    // reliable here, unlike the engine root which must poll its symlinked
    // .forgeax/games tree.
    watch: { usePolling: false, ignored: ['**/src-tauri/**', '**/node_modules/**', '**/dist/**', '**/.git/**'] },
    // Vite 5+ restricts file access to its project root by default.  Marketplace
    // plugin frontends live at ../../marketplace/plugins/*/src/panel.tsx and
    // are statically imported via Sidebar.tsx's LazyPluginPanels map; allow the
    // monorepo root so those imports resolve.  See:
    //   packages/marketplace/plugins/wb-character-forge/DESIGN.md (template).
    fs: { allow: ['..', '../..'] },
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/ws': { target: SERVER_WS, ws: true, changeOrigin: true },
      // Engine vite has `base: '/preview/'`, so ALL its asset/dep URLs are
      // already prefixed. One proxy catches everything (forgeax/engine/*,
      // games/*, node_modules/.vite/deps/*, @vite, @id, @fs) and the
      // interface's own /node_modules deps stay un-proxied — no collision.
      '/preview': { target: ENGINE, changeOrigin: true, ws: true },
      // createDevImportTransport (engine runtime) POSTs a root-absolute
      // `/__import/<guid>` on a loadByGuid miss to lazily cook a texture into
      // the RGBA .bin the runtime requires (e.g. the template's sky.hdr
      // cube-texture). It is NOT under /preview, so route it to the Play engine
      // explicitly. Only the Play preview iframe issues it; the editor runtime
      // wires no import transport.
      '/__import': { target: ENGINE, changeOrigin: true },
      // After /__import returns a row, the runtime fetches the pack body at
      // `/__forgeax-ddc/<glb-bytes-guid>.pack.json` (vite-plugin-pack DDC seam).
      // It is also outside /preview, so it must be proxied explicitly or the
      // SPA falls back to index.html and the runtime parses HTML as JSON.
      '/__forgeax-ddc': { target: ENGINE, changeOrigin: true },
      // Editor runtime vite has `base: '/editor/'`; one proxy catches all its
      // asset/dep URLs (forgeax/engine/*, node_modules/.vite/deps/*, @vite,
      // @id, @fs) just like /preview. Mirrors the preview-runtime wiring.
      '/editor': { target: EDITOR, changeOrigin: true, ws: true },
      // Plugin iframe assets — the studio server's serveStatic mounts each
      // plugin's vite build dist under /plugins/<plugin-id>/*. Without this
      // proxy the interface dev server SPA-falls back to its own index.html
      // and the iframe ends up loading a nested studio UI. See:
      //   packages/server/src/main.ts → serveStatic('/plugins/wb-character/*')
      //   packages/marketplace/plugins/wb-character-host/panel.tsx
      '/plugins': { target: SERVER, changeOrigin: true },
      // wb-character iframe legacy shim — the plugin submodule's 88 fetch
      // sites hit /__ce-api__/* expecting the old vite-dev plugin. Studio
      // host owns this surface now via server/src/api/ce-api-shim.ts; route
      // the iframe's calls through to the backend instead of SPA-falling
      // back to interface/index.html.
      '/__ce-api__': { target: SERVER, changeOrigin: true },
      // wb-reel API endpoints (scenarios, assets) and Play workspace Player iframe.
      // The wb-reel vite dev server hosts these routes as custom middleware.
      '/__reel__': { target: REEL, changeOrigin: true },
    },
  },
});
