import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

const here = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.FORGEAX_EDITOR_PORT ?? 15280);
const HOST = process.env.FORGEAX_EDITOR_HOST ?? '0.0.0.0';
const BASE = '/editor/';

// forgeaxShader's configureServer middleware hardcodes `/shaders/manifest.json`,
// but this vite root uses `base: '/editor/'` so the proxied URL arrives as
// `/editor/shaders/manifest.json`. Strip the base prefix before forgeaxShader's
// (later-registered) middleware sees the request. Mirrors engine-src.
function shaderBaseStrip() {
  return {
    name: 'forgeax:editor-shader-base-strip',
    configureServer(server: { middlewares: { use(fn: (req: { url?: string }, res: unknown, next: () => void) => void): unknown } }) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/editor/shaders/manifest.json') req.url = '/shaders/manifest.json';
        next();
      });
    },
  };
}

// pluginPack's dev middleware matches `/pack-index.json` literally (no base
// awareness); the proxied request arrives as `/editor/pack-index.json`. Strip
// the base prefix so pluginPack serves the (empty for now) catalog. Mirrors
// engine-src's forgeaxPackBaseStrip.
function packBaseStrip() {
  return {
    name: 'forgeax:editor-pack-base-strip',
    configureServer(server: { middlewares: { use(fn: (req: { url?: string }, res: unknown, next: () => void) => void): unknown } }) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/editor/pack-index.json') req.url = '/pack-index.json';
        next();
      });
    },
  };
}

// Swallow forgeaxShader's emitFile() in serve mode (vite 6 logs a noisy warning
// per call). Build mode delegates unchanged. Mirrors engine-src.
function silenceShaderEmitInServe(plugin: Record<string, unknown>) {
  let isServe = false;
  const orig = plugin as {
    configResolved?: (this: unknown, c: { command: string }) => unknown;
    buildStart?: (this: unknown) => unknown;
    transform?: (this: unknown, code: string, id: string) => unknown;
  };
  return {
    ...orig,
    configResolved(this: unknown, config: { command: string }) {
      isServe = config.command === 'serve';
      return orig.configResolved?.call(this, config);
    },
    buildStart(this: unknown) {
      if (!isServe || typeof orig.buildStart !== 'function') return orig.buildStart?.call(this);
      const proxy = new Proxy(this as object, { get(t, p) { return p === 'emitFile' ? () => '' : (t as Record<string | symbol, unknown>)[p]; } });
      return orig.buildStart.call(proxy);
    },
    transform(this: unknown, code: string, id: string) {
      if (typeof orig.transform !== 'function') return undefined;
      if (!isServe) return orig.transform.call(this, code, id);
      const proxy = new Proxy(this as object, { get(t, p) { return p === 'emitFile' ? () => '' : (t as Record<string | symbol, unknown>)[p]; } });
      return orig.transform.call(proxy, code, id);
    },
  };
}

export default defineConfig({
  root: here,
  base: BASE,
  cacheDir: resolve(here, '.vite'),
  publicDir: resolve(here, 'public'),
  plugins: [
    react(),
    shaderBaseStrip() as never,
    packBaseStrip() as never,
    // pluginPack is intentionally NOT registered here: edit-runtime proxies
    // /preview/pack-index/*, /__import, and /__forgeax-ddc directly to the
    // play engine's pluginPack (which holds the per-game gltfImporter +
    // catalog). A local pluginPack with empty roots would intercept those
    // routes first and 404 with `meta-not-found`, blocking the skinned-mesh
    // preview load.
    silenceShaderEmitInServe(forgeaxShader() as never) as never,
  ],
  optimizeDeps: {
    exclude: [
      '@forgeax/engine-app',
      '@forgeax/engine-runtime',
      '@forgeax/engine-ecs',
      '@forgeax/engine-types',
      '@forgeax/engine-shader',
      '@forgeax/engine-gltf',
      // shares the engine subgraph's module identity (see engine-src vite.config).
      '@forgeax/scene',
      // The editor-internal packages hold MUTABLE SINGLETON state (the
      // EditorBus + the active sceneId in editor-shared/store.ts). With
      // `preserveSymlinks: true`, vite's optimizeDeps walked through each
      // package's nested-symlink view of its workspace deps and bundled a
      // SECOND copy of editor-shared inside the editor-panels chunk — so
      // main.tsx's `setSceneId(cow-survivor)` + loaded doc lived on the
      // top-level instance, while HierarchyPanel read an empty bus.doc from
      // the nested instance and rendered no rows. Excluding them keeps each
      // served as a single ESM source module, shared by all importers.
      '@forgeax/editor-shared',
      '@forgeax/editor-core',
      '@forgeax/editor-panels',
    ],
  },
  resolve: {
    dedupe: [
      'react',
      'react-dom',
      '@forgeax/engine-runtime',
      '@forgeax/engine-ecs',
      '@forgeax/engine-types',
      '@forgeax/engine-rhi',
      '@forgeax/engine-math',
      '@forgeax/engine-gltf',
      '@forgeax/scene',
      // Belt-and-braces with optimizeDeps.exclude above: `dedupe` collapses
      // any dual symlink-paths to the same realpath at resolve time, so even
      // if a transitive importer reaches editor-shared via the nested
      // symlink it lands on the same module instance.
      '@forgeax/editor-shared',
      '@forgeax/editor-core',
      '@forgeax/editor-panels',
    ],
    preserveSymlinks: true,
  },
  server: {
    port: PORT,
    host: HOST,
    strictPort: true,
    open: false,
    watch: { usePolling: true, interval: 300, ignored: ['**/node_modules/**'] },
    fs: { allow: [here, resolve(here, '../../..')], strict: false },
    hmr: { clientPort: Number(process.env.FORGEAX_INTERFACE_PORT ?? 18920) },
    // Scene persistence (store.ts) reads/writes .forgeax/games/<slug>/scene.json
    // through the server's /api/files. Iframed via the interface (:18920/editor)
    // it's same-origin already; this proxy makes a DIRECT :15280 visit work too.
    proxy: {
      '/api': { target: `http://127.0.0.1:${process.env.FORGEAX_SERVER_PORT ?? 18900}`, changeOrigin: true },
      // Skinned-mesh preview (witch.glb sub-assets) lives in the play engine's
      // per-game pluginPack catalog. /preview/* serves catalog + DDC bodies;
      // /__import + /__forgeax-ddc are the gltfImporter cook + read endpoints
      // (registered bare-prefix by pluginPack — no base awareness). Without
      // these the edit-runtime preview hook fails with `asset-not-imported`.
      '/preview': { target: `http://127.0.0.1:${process.env.FORGEAX_ENGINE_PORT ?? 15173}`, changeOrigin: true, ws: true },
      '/__import': { target: `http://127.0.0.1:${process.env.FORGEAX_ENGINE_PORT ?? 15173}`, changeOrigin: true },
      '/__forgeax-ddc': { target: `http://127.0.0.1:${process.env.FORGEAX_ENGINE_PORT ?? 15173}`, changeOrigin: true },
    },
  },
  build: { outDir: resolve(here, 'dist') },
});
