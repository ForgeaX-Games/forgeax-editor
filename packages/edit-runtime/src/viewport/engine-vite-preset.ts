// engine-vite-preset — the SINGLE source of truth for "run the forgeax engine
// under vite" (plan-strategy REPLAN D7; AC-04 single-realm in-process boot).
//
// WHY THIS EXISTS
//   Before M2 the whole engine-serve mechanism (shader manifest emit, pack-index
//   / __import middleware, symlink-dedupe, top-level-await build target) lived
//   ONLY in edit-runtime/vite.config.ts. The :15290 host (root vite.config.ts)
//   had just react() + an /editor -> :15280 proxy, so it could never boot the
//   engine in-process; it borrowed edit-runtime's serve through an iframe. M2
//   collapses the editor to a single realm: the engine boots ONCE in the :15290
//   host window (standalone/main.tsx), so the HOST bundler must itself serve the
//   engine's shader manifest + pack catalog. Rather than copy edit-runtime's
//   serve config into the root config (two hand-maintained copies that would
//   drift — architecture-principles S1 SSOT / S2 Derive), this helper hoists the
//   serve mechanism into ONE function both configs consume.
//
// WHY IT LIVES IN edit-runtime (not repo root)
//   The engine vite plugins (@forgeax/engine-vite-plugin-{shader,pack},
//   @forgeax/engine-image, @forgeax/engine-gltf) resolve to the engine submodule
//   through edit-runtime's node_modules/@forgeax symlink graph. A helper physically
//   located here resolves them from its own directory, so the root config gets
//   working plugin instances just by importing this module. (Verified: bun +
//   Node ESM loader both resolve all four plugins from this directory.)
//
// WHAT IT RETURNS
//   A { plugins, optimizeDeps, resolve, build } fragment each config spreads into
//   its own defineConfig alongside its config-specific parts (react(), root,
//   base, hmr, --game /api proxy, etc.).
//
// Anchors: plan-strategy S2 D7 (shared engine-vite-preset helper), S3.1 (host
// bundler layer), S4 R7 (root config lacked engine serve -> in-process 404);
// AGENTS.md "No build step" (exports point at source; no compile step added).

import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, realpathSync } from 'node:fs';
import type { PluginOption } from 'vite';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';
// Vite's config bundle externalizes package subpaths, leaving Node to load core's
// source-only TypeScript export. Reach the same core helper relatively so Vite
// folds it into the config bundle before Node evaluates that bundle.
import { resolveGameAssetRoots } from '../../../core/src/asset-roots';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { gltfImporter } from '@forgeax/engine-gltf';
import { fbxImporter } from '@forgeax/engine-fbx';
import { fontImporter } from '@forgeax/engine-font/font-importer';

// This helper's own directory: packages/edit-runtime/src/viewport/. Used to locate
// edit-runtime's node_modules (../../node_modules) so the @forgeax workspace
// family is derived from ONE fixed location regardless of which config (root or
// edit-runtime) consumes the preset — both get the identical SSOT list.
const HELPER_DIR = dirname(fileURLToPath(import.meta.url));
const EDIT_RUNTIME_DIR = resolve(HELPER_DIR, '..', '..');

// ── @forgeax packages to exclude from pre-bundle (SSOT-derived, no hand list) ──
// SSOT = edit-runtime's node_modules/@forgeax (engine-* + editor-*), i.e. exactly
// the @forgeax packages vite resolves natively. Excluding precisely that set:
//   - Avoids the OOM: under preserveSymlinks:true a pre-bundle crawls the nested
//     workspace symlink graph (packages/*/node_modules/@forgeax/* -> ../../../*)
//     where one file via combinatorially-many symlink paths becomes a distinct
//     module -> esbuild blows up; also keeps the editor singletons (editor-shared
//     EditGateway / active sceneId) a single instance.
//   - Stays resolvable: all are present here. We must NOT over-exclude with the
//     full engine/packages tree — transitive-only packages absent from
//     node_modules (engine-plugin / engine-debug-draw, imported by engine-app /
//     engine-runtime) must stay pre-bundlable or native import analysis throws
//     "Failed to resolve import". Hand-listing was the original drift bug.
function forgeaxWorkspacePackages(): string[] {
  const out = new Set<string>(['@forgeax/scene']);
  try {
    for (const name of readdirSync(resolve(EDIT_RUNTIME_DIR, 'node_modules/@forgeax'))) {
      out.add(`@forgeax/${name}`);
    }
  } catch { /* node_modules not materialised yet — fall through */ }
  return [...out];
}

// ── game-source bare-import resolution (▶ Play, --game self-host) ─────────────
// Game sources (<gameDirAbs>/main.ts + script assets) live OUTSIDE every
// workspace package: their node_modules walk-up only reaches the repo-root
// node_modules, which under bun's isolated linker hoists just the host's
// DIRECT deps — NOT the engine family (root @forgeax/ has editor-core /
// interface / the vite plugins, no engine-runtime). The shell's own engine
// imports resolve fine because their importers sit inside packages/* whose
// node_modules carry the family — so this hole is invisible until ▶ Play
// loads a game file and its `import ... from '@forgeax/engine-runtime'` 500s
// with "Failed to resolve import" (it only surfaces on WebGPU-capable
// runners: GPU-less headless falls back to edit BEFORE the game entry loads,
// which is why CI stayed green until chromium's software WebGPU landed).
// Fix at the SSOT: re-resolve game-file @forgeax imports anchored at THIS
// package (edit-runtime), the same node_modules the dedupe/exclude lists
// derive from. Non-game importers and non-@forgeax ids fall through (null).
//
// Importer matching must normalize Vite's /@fs/<abs> URLs, repo-relative paths
// (e.g. ../forgeax-games/hellforge/main.ts), and Windows drive-letter casing —
// a naive startsWith(gameDirAbs) misses all three and Play 500s on the first
// `import '@forgeax/engine-runtime'` in the game entry.
const HOST_GAMES_DIR = ['.', 'forgeax', 'games'].join('/');
const MULTI_GAME_PATH_RE = new RegExp(
  `/\\/(?:${HOST_GAMES_DIR.replace(/\./g, '\\.').replace(/\//g, '\\/')}|forgeax-games)\\/[^/]+\\/`,
);

function normalizeGameFilePath(raw: string, viteRoot: string): string {
  let p = raw.replace(/\\/g, '/');
  if (p.startsWith('/@fs/')) p = p.slice('/@fs/'.length);
  else if (p.startsWith('/@fs')) p = p.slice('/@fs'.length);
  if (!/^[A-Za-z]:\//.test(p) && !p.startsWith('/')) {
    p = resolve(viteRoot, p).replace(/\\/g, '/');
  }
  try { p = realpathSync.native(p).replace(/\\/g, '/'); } catch { /* keep */ }
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function gameEngineResolve(gameDirAbs: string | null): PluginOption {
  let gameDirNorm: string | null = null;
  if (gameDirAbs) {
    try { gameDirNorm = normalizeGameFilePath(realpathSync.native(gameDirAbs), gameDirAbs); }
    catch { gameDirNorm = normalizeGameFilePath(gameDirAbs, gameDirAbs); }
  }
  let viteRoot = process.cwd();
  const anchor = resolve(EDIT_RUNTIME_DIR, 'package.json');
  return {
    name: 'forgeax:game-engine-resolve',
    configResolved(config) {
      viteRoot = config.root;
    },
    async resolveId(id, importer) {
      if (!importer || !id.startsWith('@forgeax/')) return null;
      const imp = normalizeGameFilePath(importer, viteRoot);
      const isGameFile = gameDirNorm
        ? imp.startsWith(gameDirNorm)
        : MULTI_GAME_PATH_RE.test(imp);
      if (!isGameFile) return null;
      const r = await this.resolve(id, anchor, { skipSelf: true });
      return r ?? null;
    },
  };
}

// The shared/external asset submodule (forgeax-editor-assets) that a game's
// `@shared/<sub>` roots resolve against. Two levels up from EDIT_RUNTIME_DIR
// (packages/edit-runtime) = repo root.
const SHARED_BASE = resolve(EDIT_RUNTIME_DIR, '../../forgeax-editor-assets');

/**
 * A resolved root plus its stable catalog-space prefix. The engine pack catalog
 * reports source paths relative to `process.cwd()`, so the browser must classify
 * a catalog row by that same coordinate system — never by a second knowledge of
 * the `@shared/` disk layout.
 *
 * `root` is the literal package.json declaration (the Content Browser's folder
 * identity); `catalogPrefix` is its canonical sourcePath prefix. This turns the
 * host-resolved roots from {@link resolveGameAssetRoots} into an explicit runtime
 * contract shared by Vite's pack scanner and the browser bundle.
 */
export interface CatalogAssetRoot {
  readonly root: string;
  readonly catalogPrefix: string;
}

function catalogPrefix(abs: string): string {
  return relative(process.cwd(), abs).replace(/\\/g, '/').replace(/^\.\//, '');
}

// A game's pack roots — LOCAL and `@shared/<sub>` external roots alike — are
// resolved from package.json#forgeax.assets.roots via the editor-core SSOT
// helper. The declaration-to-catalog projection travels alongside the pack
// roots, so Content Browser code need not duplicate the @shared disk mapping.
//
// Implicit `template-game-default`: the demo-seed default template's scene
// references the shared sky.hdr equirect GUID (81eec382) but its own assets/
// has no sky.hdr. Rather than edit the ENGINE submodule's template package.json
// to declare `@shared/template-game-default` (which would leak the editor's
// convention into the engine), inject it only for the runtime catalog. It is
// deliberately absent from the user-facing roots payload because it is not a
// game-declared Content Browser scope.
function gameCatalogRoots(gameDirAbs: string): CatalogAssetRoot[] {
  const declared = resolveGameAssetRoots(gameDirAbs, { sharedBase: SHARED_BASE });
  return declared.map((resolved) => ({
    root: resolved.shared ? `@shared/${resolved.sub}` : relative(gameDirAbs, resolved.abs).replace(/\\/g, '/'),
    catalogPrefix: catalogPrefix(resolved.abs),
  }));
}

function gamePackRoots(gameDirAbs: string): string[] {
  return resolveGameAssetRoots(gameDirAbs, {
    sharedBase: SHARED_BASE,
    implicitSharedSubs: ['template-game-default'],
  }).map((r) => r.abs);
}

// forgeaxShader's configureServer middleware hardcodes `/shaders/manifest.json`;
// under a non-root base (edit-runtime's `/editor/`) the proxied URL arrives as
// `/editor/shaders/manifest.json`. Strip the base prefix before forgeaxShader's
// (later-registered) middleware sees it. Only needed when base !== '/'.
function shaderBaseStrip(base: string): PluginOption {
  const prefix = base.replace(/\/$/, ''); // '/editor'
  return {
    name: 'forgeax:engine-preset-shader-base-strip',
    configureServer(server: { middlewares: { use(fn: (req: { url?: string }, res: unknown, next: () => void) => void): unknown } }) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === `${prefix}/shaders/manifest.json`) req.url = '/shaders/manifest.json';
        next();
      });
    },
  } as PluginOption;
}

// pluginPack's dev middleware matches its routes literally (no base awareness);
// under a non-root base the proxied requests arrive prefixed with the base.
// Strip that prefix for EVERY pluginPack route the self-hosted catalog serves:
//   <base>/pack-index.json            -> /pack-index.json          (catalog)
//   <base>/__import/<guid>            -> /__import/<guid>          (lazy cook)
//   <base>/__forgeax-ddc/<guid>...    -> /__forgeax-ddc/...        (meta pack body)
// Asset URLs pluginPack emits already carry the base (relativeUrl prefixed at
// build), so they resolve as-is. Only needed when base !== '/'.
const PACK_ROUTE_PREFIXES = ['/pack-index.json', '/__import/', '/__forgeax-ddc/', '/__pack/'];
function packBaseStrip(base: string): PluginOption {
  const prefix = base.replace(/\/$/, ''); // '/editor'
  return {
    name: 'forgeax:engine-preset-pack-base-strip',
    configureServer(server: { middlewares: { use(fn: (req: { url?: string }, res: unknown, next: () => void) => void): unknown } }) {
      server.middlewares.use((req, _res, next) => {
        const u = req.url;
        if (u) {
          for (const p of PACK_ROUTE_PREFIXES) {
            if (u === `${prefix}${p}` || u.startsWith(`${prefix}${p}`)) {
              req.url = u.slice(prefix.length);
              break;
            }
          }
        }
        next();
      });
    },
  } as PluginOption;
}

// Swallow forgeaxShader's emitFile() in serve mode (vite logs a noisy warning
// per call). Build mode delegates unchanged. Mirrors engine-src.
function silenceShaderEmitInServe(plugin: Record<string, unknown>): PluginOption {
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
  } as unknown as PluginOption;
}

export interface EngineVitePresetOptions {
  /**
   * The vite `base` the consuming config uses. '/' for the :15290 host
   * (standalone) — shader/pack routes arrive un-prefixed, no base-strip needed.
   * '/editor/' for edit-runtime — its proxied routes arrive base-prefixed, so
   * the base-strip middleware is included.
   */
  base: string;
  /**
   * Whether to set resolve.preserveSymlinks. edit-runtime needs it (its nested
   * workspace symlink graph would otherwise pre-bundle one file via many symlink
   * paths -> esbuild OOM). The :15290 host must NOT enable it: the host bundle
   * pulls dockview + @radix-ui through packages/interface/node_modules, and under
   * preserveSymlinks vite resolves the symlinked interface to its realpath and
   * then fails to find those NESTED transitive deps (dockview-core / react-context)
   * that live under the symlink target. The host relies on realpath dedupe
   * (resolve.dedupe) instead — which already collapses the @forgeax family to one
   * instance. Defaults to true (edit-runtime's need); the host passes false.
   */
  preserveSymlinks?: boolean;
  /**
   * Absolute game dir (from `--game DIR`), or null. When set, register a
   * pluginPack self-hosting the game's asset roots (from package.json
   * forgeax.assets.roots) + shared template roots so Play's loadByGuid + Edit
   * sub-asset previews resolve WITHOUT proxying to play-runtime (:15173).
   * null (no --game / empty scene) -> no pluginPack; the shader plugin alone
   * still serves /shaders/manifest.json for the empty scene.
   */
  gameDirAbs: string | null;
}

export interface EngineVitePreset {
  plugins: PluginOption[];
  optimizeDeps: { exclude: string[] };
  resolve: { dedupe: string[]; preserveSymlinks: boolean };
  build: { target: 'esnext' };
  /** Declared game roots projected into the pack catalog's sourcePath space. */
  catalogRoots: CatalogAssetRoot[];
}

/**
 * Build the shared engine-serve config fragment (plan-strategy D7). Each vite
 * config spreads the returned fields into its own defineConfig alongside its
 * config-specific parts (react(), root, base, --game /api proxy, hmr, ...).
 *
 * Returns:
 *   - plugins:      engine serve plugins (base-strip when non-root base +
 *                   optional self-hosted pluginPack + silenced forgeaxShader).
 *                   Does NOT include react() — each config adds its own.
 *   - optimizeDeps: exclude the whole @forgeax family (native ESM, single
 *                   instance; SSOT-derived, cannot drift like a hand list).
 *   - resolve:      dedupe react + the @forgeax family; preserveSymlinks.
 *   - build:        target 'esnext' — the entry uses top-level await (initSceneList
 *                   / boot) which pre-esnext targets forbid.
 */
export function engineVitePreset(opts: EngineVitePresetOptions): EngineVitePreset {
  const { base, gameDirAbs, preserveSymlinks = true } = opts;
  const wsPkgs = forgeaxWorkspacePackages();
  const nonRootBase = base !== '/' && base !== '';
  const selfHostPack = gameDirAbs !== null;
  const catalogRoots = gameDirAbs ? gameCatalogRoots(gameDirAbs) : [];

  const plugins: PluginOption[] = [];
  if (nonRootBase) {
    plugins.push(shaderBaseStrip(base));
    plugins.push(packBaseStrip(base));
  }
  // Always register: studio multi-game (gameDirAbs:null) still ▶ Play-loads
  // /@fs/<project>/<host-games-dir>/<slug>/main.ts; --game self-host passes
  // an abs dir. Both need bare @forgeax/* re-anchored at edit-runtime.
  plugins.push(gameEngineResolve(gameDirAbs));
  if (selfHostPack) {
    plugins.push(
      pluginPack({
        roots: gamePackRoots(gameDirAbs),
        base,
        importers: [imageImporter, gltfImporter, fbxImporter, fontImporter],
      }) as unknown as PluginOption,
    );
  }
  plugins.push(silenceShaderEmitInServe(forgeaxShader() as unknown as Record<string, unknown>));

  // ── opt-in RHI-debug capture (FORGEAX_ENGINE_RHI_DEBUG=1) ────────────────────
  // The vite-plugin-rhi-debug config() hook UNCONDITIONALLY injects
  //   define: { 'import.meta.env.FORGEAX_ENGINE_RHI_DEBUG': '1' }
  // and mounts the dev-server /__forgeax-debug/{tape,trigger} write endpoints, so
  // "register the plugin?" IS the switch — registering it flips the createApp guard
  // (engine-app create-app.ts) that mounts window.__forgeax.captureFrame. Gate it
  // on the env flag so the default (unset) run stays byte-identical to before:
  // no define -> the guard folds to dead code -> @forgeax/engine-rhi-debug is
  // tree-shaken, window.__forgeax stays undefined (README tree-shake invariant).
  // `bun fx start --rhi-debug` (scripts/fx.ts) sets the env for the spawned
  // vite processes; both the :15290 host and :15280 edit-runtime configs share
  // this preset, so the host (where the engine actually boots + POSTs captured
  // tapes) gets the endpoints too.
  if (process.env.FORGEAX_ENGINE_RHI_DEBUG === '1') {
    plugins.push(vitePluginRhiDebug() as unknown as PluginOption);
  }

  return {
    plugins,
    optimizeDeps: {
      // Exclude the ENTIRE @forgeax workspace family (engine-* + editor-*) from
      // vite pre-bundling — served as native ESM. SSOT-derived so it can't drift
      // the way the old hand list did; also keeps the editor singletons
      // (EditGateway / active sceneId in editor-shared) a single shared instance.
      exclude: wsPkgs,
    },
    resolve: {
      // react/react-dom dedupe (single React instance); the @forgeax family
      // dedupes off the same SSOT-derived list so every engine / editor package
      // resolves to one realpath even when reached via a nested symlink path.
      dedupe: ['react', 'react-dom', ...wsPkgs],
      preserveSymlinks,
    },
    // esnext: the entry uses top-level await (initSceneList / boot); vite's
    // default build target forbids TLA. This runtime only runs in
    // WKWebView/Chrome (which support TLA) so esnext is safe.
    build: { target: 'esnext' },
    catalogRoots,
  };
}
