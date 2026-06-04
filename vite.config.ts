import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';

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
    shaderBaseStrip() as never,
    packBaseStrip() as never,
    pluginPack({ roots: [], base: BASE }) as never,
    silenceShaderEmitInServe(forgeaxShader() as never) as never,
  ],
  optimizeDeps: {
    exclude: [
      '@forgeax/engine-app',
      '@forgeax/engine-runtime',
      '@forgeax/engine-ecs',
      '@forgeax/engine-types',
      '@forgeax/engine-shader',
    ],
  },
  resolve: {
    dedupe: [
      '@forgeax/engine-runtime',
      '@forgeax/engine-ecs',
      '@forgeax/engine-types',
      '@forgeax/engine-rhi',
      '@forgeax/engine-math',
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
  },
  build: { outDir: resolve(here, 'dist') },
});
