import { defineConfig } from 'vite';
import { resolve, dirname, join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, lstatSync, unlinkSync, symlinkSync, readFileSync } from 'node:fs';
import {
  engineVitePreset,
  ENGINE_EXECUTION_ISOLATION_HEADERS,
  discoverGameMaterialPackages,
  resolveGameEngineEntry as resolveSharedGameEngineEntry,
  type EngineVitePreset,
} from '../../scripts/vite/engine-vite-preset';
// Vite config bundling externalizes package subpaths, so Node would receive core's
// raw TypeScript export. Import the same core helper relatively to bundle it first.
import { resolveGameAssetRoots, resolveGameCatalogRoots, type ResolvedRoot } from '../core/src/asset-roots';
import { PLAY_RUNTIME_STATIC_WATCH_IGNORES } from './src/watch-policy';
import { createRuntimeScopeController, type RuntimeScopeCommand } from './src/runtime-scope-controller';
import { setupSingleGameRootFarm } from './src/active-game-mount';

const here = dirname(fileURLToPath(import.meta.url));
const PLAY_PACKAGE_ROOT = resolve(here, 'node_modules');

// Keep the public Play test seam while making the actual resolver shared. Play
// owns a small set of host-only packages (notably engine-npc), so it contributes
// its package graph as data rather than carrying a second resolver algorithm.
export function resolveGameEngineEntry(id: string): string | null {
  return resolveSharedGameEngineEntry(id, { packageRoots: [PLAY_PACKAGE_ROOT] });
}

// The active game mount is host-injected for parallel dev stacks. The default
// remains `host-games`; the mount contains only the exact active game, never a
// parent directory containing sibling games.
const HOST_GAMES_FARM = process.env.FORGEAX_GAMES_URL_PREFIX ?? 'host-games';

// The shared/external asset submodule (forgeax-editor-assets) resolved to its
// REAL path, two levels up from this package. `@shared/<sub>` roots declared in
// a game's package.json#forgeax.assets.roots resolve against this base (via
// resolveGameAssetRoots). See the farm comment below for why the real path is
// then rewritten to the in-viteRoot symlink before scanning.
const SHARED_BASE = resolve(here, '..', '..', 'forgeax-editor-assets');
const ENGINE_ASSETS_BASE = resolve(here, '..', 'engine', 'forgeax-engine-assets');

// The engine template's shipped UI is a canonical self-contained pack, not a
// game-local `.ui.html`/`.meta.json` authoring pair. Keep it in the engine
// assets submodule (the engine pin is its SSOT) and mount only that directory
// into this Vite root so the pack catalog can serve it without copying the
// payload into forgeax-editor-assets.
const ENGINE_TEMPLATE_UI_BASE = resolve(
  here,
  '..',
  'engine',
  'forgeax-engine-assets',
  'demo-assets',
  'template-game-default',
  'ui',
);

// Games stay a host concern: a standalone/desktop/studio host injects one
// exact physical game directory. No parent games directory is accepted as an
// asset producer input.
const INITIAL_GAME_DIR = process.env.FORGEAX_GAME_DIR
  ? resolve(process.env.FORGEAX_GAME_DIR)
  : '';
const INITIAL_GAME_ID = process.env.FORGEAX_GAME_ID
  ?? (INITIAL_GAME_DIR ? basename(INITIAL_GAME_DIR) : '');
const RUNTIME_SCOPE_SECRET = process.env.FORGEAX_RUNTIME_SCOPE_SECRET;
const INITIAL_SCOPE_ID = process.env.FORGEAX_RUNTIME_SCOPE_ID ?? INITIAL_GAME_ID;
const INITIAL_GENERATION = Number(process.env.FORGEAX_RUNTIME_GENERATION ?? 1);
const GAMES_URL_PREFIX = process.env.FORGEAX_GAMES_URL_PREFIX
  ?? (INITIAL_GAME_DIR ? HOST_GAMES_FARM : '');
const GAME_API_PORT = process.env.FORGEAX_GAME_API_PORT;
const STATIC_GAME_DIR = process.env.FORGEAX_STATIC_GAME_DIR
  ? resolve(process.env.FORGEAX_STATIC_GAME_DIR)
  : '';
const STATIC_GAME_ID = process.env.FORGEAX_STATIC_GAME_ID ?? '';
const STATIC_GAME_ENTRY = STATIC_GAME_DIR
  ? resolve(STATIC_GAME_DIR, process.env.FORGEAX_STATIC_GAME_ENTRY ?? 'main.ts')
  : '';
const STATIC_BUILD = STATIC_GAME_DIR.length > 0;
const STATIC_GAME_VIRTUAL_ID = 'virtual:forgeax-static-game-entry';
const STATIC_GAME_RESOLVED_ID = `\0${STATIC_GAME_VIRTUAL_ID}`;
const STATIC_PLUGINS_VIRTUAL_ID = 'virtual:forgeax-static-game-plugins';
const STATIC_PLUGINS_RESOLVED_ID = `\0${STATIC_PLUGINS_VIRTUAL_ID}`;

// Explicit non-game `template-game-default` roots for the active game realm. The demo-seed default template's
// scene references the shared sky.hdr equirect GUID (81eec382) but its own assets/
// has no sky.hdr and its package.json declares only `["assets"]` — never
// `@shared/template-game-default` (that would leak the editor's `@shared/`
// convention into the engine submodule's template). play-runtime injects the
// active realm so the template sky folds into that realm's pack catalog, matching
// editor-level engine-vite-preset (they share this via editor-core's
// resolveGameAssetRoots.implicitSharedSubs — architecture-principles §1 SSOT).
// Without it, the scoped import route for the sky GUID returns `meta-not-found` and the skylight falls
// back to a solid color. existsSync-filtered, so an absent submodule degrades to
// game-only.
const IMPLICIT_SHARED_SUBS = ['template-game-default'] as const;

// Cross-platform external-root farm (generalizes the former single hardcoded
// `sharedAssetRoots()` mount — architecture-principles §1 SSOT: one `roots`
// concept, not a per-game list PLUS a separate shared-roots appender).
//
// WHY A SYMLINK IS STILL REQUIRED (not just an abs path in roots):
//   play-runtime's process.cwd() == viteRoot == this package dir, and every
//   catalog entry's packageUrl = withBase('/preview', relative(cwd, assetAbs)).
//   withBase does posix.resolve('/', rel), which CLAMPS
//   leading `../` — so an external abs path (forgeax-editor-assets lives ABOVE
//   viteRoot) yields a mangled `/preview/forgeax-editor-assets/...` URL that
//   resolves under viteRoot and 404s. The symlink makes the whole submodule
//   appear UNDER viteRoot as `shared-assets/`, so relative(cwd, .../shared-assets/x)
//   is a clean in-root subpath vite can serve. The scanner does NOT realpath-deref,
//   so the `shared-assets/` prefix is preserved. Every `@shared/<sub>` root lives
//   under this ONE submodule, so ONE whole-dir symlink covers all scopes — no
//   per-scope farm needed. `farmPath()` (below) rewrites resolved shared roots
//   to their `shared-assets/<sub>` path before they reach the scanner.
//
// Git on Windows without core.symlinks=true checks out symlinks as plain text
// files containing the target path, which breaks the Vite dev server — so we
// (re)create a real symlink/junction on demand.
function setupExternalRootFarm(linkName: string, targetPath: string): void {
  const linkPath = resolve(here, linkName);
  if (existsSync(linkPath)) {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink() && stat.isFile()) {
      // It's the text file checked out by Git on Windows. Remove it.
      try { unlinkSync(linkPath); } catch {}
    } else {
      // Already a valid symlink or junction, leave it alone.
      return;
    }
  }
  // Create a proper symlink/junction
  try {
    symlinkSync(targetPath, linkPath, 'junction');
  } catch (e) {
    console.warn(`[forgeax] failed to create ${linkName} junction:`, e);
  }
}

setupExternalRootFarm('shared-assets', SHARED_BASE);
setupExternalRootFarm('engine-assets', ENGINE_ASSETS_BASE);

// Rewrite resolved roots to paths the scanner can publish under the Vite root:
// local game roots use host-games/<slug>, while shared roots use the single
// shared-assets mount. `resolveGameAssetRoots` has already existsSync-filtered
// against the REAL paths; the mounts point at the same directories.
// Local game roots also need to be scanned through the in-root host-games farm.
// Keeping their real absolute path here produces catalog packageUrls such as
// `/preview/forgeax-gta/...`, which Vite cannot serve and which makes authored
// Pack v2 scenes fall back to an incorrectly addressed import request. The
// browser-visible URL must use the same host-games mount as the game entry.
function farmGamePath(root: ResolvedRoot, gameDir: string, slug: string): string {
  if (root.shared && root.sub !== undefined) return resolve(here, 'shared-assets', root.sub);
  const rel = relative(gameDir, root.abs);
  return resolve(here, HOST_GAMES_FARM, slug, rel);
}

function engineTemplateUiFarmPath(): string {
  return resolve(here, 'engine-template-ui');
}

// The default game template references these engine-authored audio clips by
// GUID. They are not game-local assets, so mount the two small template scopes
// into the same pack/import pipeline as the implicit template sky. Keeping the
// roots explicit avoids scanning every binary asset in forgeax-engine-assets
// for every game while ensuring new default games have working audio.
function templateAudioRoots(): string[] {
  return [
    resolve(here, 'engine-assets', 'sfx'),
    resolve(here, 'engine-assets', 'collectathon-audio'),
  ].filter(existsSync);
}

// game-default's optional asset demonstrations are part of the template's
// normal bootstrap, so the standalone Preview host must expose the same
// engine-assets sources as the engine's own apps/preview host.
function templateGameDefaultRuntimeRoots(gameDir: string): string[] {
  try {
    const packageJson = JSON.parse(readFileSync(join(gameDir, 'package.json'), 'utf8')) as { name?: unknown };
    if (packageJson.name !== '@forgeax/template-game-default') return [];
  } catch {
    return [];
  }
  return [
    resolve(here, 'engine-assets', 'vendor', 'fbx-test'),
    resolve(here, 'engine-assets', 'khronos-gltf-samples', 'BoxTextured'),
    resolve(here, 'engine-assets', 'demo-assets', 'hello-sprite', 'wood-container.jpg.meta.json'),
    resolve(here, 'engine-assets', 'dejavu-fonts', 'DejaVuSansMono.ttf.meta.json'),
    resolve(here, 'engine-assets', 'dejavu-fonts', 'DejaVuSansMono.atlas.png.meta.json'),
    resolve(here, 'engine-assets', 'dejavu-fonts', 'DejaVuSansMono.font.pack.json'),
    resolve(here, 'engine-assets', 'demo-assets', 'hello-sprite-atlas'),
  ].filter(existsSync);
}

// Self-contained vite root: the engine directory itself. Only one exact game
// is mounted below it at a time; the sidecar never receives a parent games dir.
const viteRoot = here;

let mountedGameLink: string | undefined;
if (INITIAL_GAME_DIR && /^[a-z0-9][a-z0-9-]{0,40}$/.test(INITIAL_GAME_ID)) {
  mountedGameLink = setupSingleGameRootFarm({
    farmRoot: resolve(here, HOST_GAMES_FARM),
    gameDir: INITIAL_GAME_DIR,
    gameId: INITIAL_GAME_ID,
  });
}

const PORT = Number(process.env.FORGEAX_ENGINE_PORT ?? 15173);
const HOST = process.env.FORGEAX_ENGINE_HOST ?? '0.0.0.0';

export function assetCorsOrigins(env: Readonly<NodeJS.ProcessEnv> = process.env): string[] {
  const configured = env.FORGEAX_ASSET_CORS_ORIGINS
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (configured && configured.length > 0) return configured;

  const interfacePort = Number(env.FORGEAX_INTERFACE_PORT ?? 18920);
  return [
    `http://127.0.0.1:${interfacePort}`,
    `http://localhost:${interfacePort}`,
    `https://127.0.0.1:${interfacePort}`,
    `https://localhost:${interfacePort}`,
  ];
}

export function hmrClientPort(env: Readonly<NodeJS.ProcessEnv> = process.env): number {
  return Number(env.FORGEAX_HMR_CLIENT_PORT ?? env.FORGEAX_INTERFACE_PORT ?? 18920);
}

/** Project-bound identity used by local orchestration clients before opening preview. */
function forgeaxRuntimeIdentity() {
  const instanceRootAbs = process.env.FORGEAX_PROJECT_ROOT
    ? resolve(process.env.FORGEAX_PROJECT_ROOT)
    : undefined;
  return {
    name: 'forgeax:runtime-identity',
    configureServer(server: { middlewares: { use(fn: Function): unknown } }) {
      server.middlewares.use((
        req: { url?: string },
        res: {
          statusCode: number;
          setHeader(name: string, value: string): void;
          end(body: string): void;
        },
        next: () => void,
      ) => {
        if (req.url?.split('?')[0] !== '/preview/__forgeax_health') {
          next();
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          status: 'ok',
          name: '@forgeax/play-runtime',
          instanceRootAbs,
        }));
      });
    },
  };
}

let activeGameDir = INITIAL_GAME_DIR;
let activeGameId = INITIAL_GAME_ID;

// The Pack producer receives one exact game root plus explicit product roots.
// Shared roots are host-owned inputs in this realm; sibling game directories
// are never discovered here.
function singleGamePackRoots(gameDir: string, gameId: string): string[] {
  const seen = new Set<string>();
  const roots: string[] = [];
  const push = (root: string): void => {
    if (!seen.has(root)) {
      seen.add(root);
      roots.push(root);
    }
  };
  if (existsSync(engineTemplateUiFarmPath())) push(engineTemplateUiFarmPath());
  for (const root of templateAudioRoots()) push(root);
  for (const root of templateGameDefaultRuntimeRoots(gameDir)) push(root);
  if (!gameDir) return roots;
  for (const root of resolveGameAssetRoots(gameDir, {
    sharedBase: SHARED_BASE,
    implicitSharedSubs: IMPLICIT_SHARED_SUBS,
  })) {
    push(farmGamePath(root, gameDir, gameId));
  }
  return roots;
}

function collectPluginFiles(root: string, out: string[]): void {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = readdirSync(root, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(root, entry.name);
    if (entry.isDirectory()) {
      collectPluginFiles(abs, out);
    } else if (entry.isFile() && entry.name.endsWith('.plugin.ts')) {
      out.push(abs);
    }
  }
}

// Plugin modules are project-runtime inputs, not authored asset rows. The
// preview host publishes a tiny URL manifest from the same local game roots
// used by its pack catalog. The browser imports these URLs in the play-runtime
// realm before defaultScene instantiation.
function gamePluginModules(gameDir: string, slug: string): Array<{ clientPath: string; url: string }> {
  const files: string[] = [];
  for (const root of resolveGameAssetRoots(gameDir, { sharedBase: SHARED_BASE, implicitSharedSubs: IMPLICIT_SHARED_SUBS })) {
    if (!root.shared) collectPluginFiles(root.abs, files);
  }
  const urlPrefix = GAMES_URL_PREFIX ? `${GAMES_URL_PREFIX}/${slug}` : slug;
  return files
    .sort()
    .map((file) => {
      const rel = relative(gameDir, file).split('\\').join('/');
      return { clientPath: rel, url: `/preview/${urlPrefix}/${rel}` };
    });
}

function collectStaticGameFiles(root: string, current = root, out: string[] = []): string[] {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = readdirSync(current, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.forgeax' || entry.name === 'dist') continue;
    const abs = join(current, entry.name);
    if (entry.isDirectory()) collectStaticGameFiles(root, abs, out);
    else if (entry.isFile() && (
      entry.name === 'forge.json'
      || entry.name === 'package.json'
      || entry.name.endsWith('.pack.json')
      || entry.name.endsWith('.meta.json')
    )) out.push(abs);
  }
  return out;
}

/**
 * Static single-game build seam.
 *
 * The dev runtime intentionally imports a game entry through Vite's server so
 * the host can replace a game without rebuilding. A shipping artifact has no
 * such server, so this plugin turns the selected entry into a normal Rollup
 * dependency and stages the authored project facts under one stable URL space.
 */
function forgeaxStaticGame() {
  const staticPluginFiles: string[] = [];
  if (STATIC_BUILD) collectPluginFiles(STATIC_GAME_DIR, staticPluginFiles);
  staticPluginFiles.sort();
  return {
    name: 'forgeax:static-game',
    resolveId(id: string) {
      if (id === STATIC_GAME_VIRTUAL_ID) return STATIC_GAME_RESOLVED_ID;
      if (id === STATIC_PLUGINS_VIRTUAL_ID) return STATIC_PLUGINS_RESOLVED_ID;
      return null;
    },
    load(id: string) {
      if (id === STATIC_PLUGINS_RESOLVED_ID) {
        const modules = staticPluginFiles.map((file, index) => ({
          clientPath: relative(STATIC_GAME_DIR, file).split('\\').join('/'),
          url: `virtual:forgeax-static-plugin-${index}`,
        }));
        const imports = staticPluginFiles.map((file, index) => (
          `    if (url === ${JSON.stringify(`virtual:forgeax-static-plugin-${index}`)}) return import(${JSON.stringify(file)});`
        ));
        return [
          `export const modules = ${JSON.stringify(modules)};`,
          'export async function importModule(url) {',
          ...imports,
          "    throw new Error(`unknown static plugin: ${url}`);",
          '}',
        ].join('\n');
      }
      if (id === STATIC_GAME_RESOLVED_ID) {
        if (!STATIC_BUILD || !existsSync(STATIC_GAME_ENTRY)) return 'export const bootstrap = null;';
        return `export { bootstrap } from ${JSON.stringify(STATIC_GAME_ENTRY)};`;
      }
      return null;
    },
    generateBundle(this: { emitFile(opts: { type: 'asset'; fileName: string; source: string | Uint8Array }): void }) {
      if (!STATIC_BUILD) return;
      if (!existsSync(STATIC_GAME_ENTRY)) return;
      for (const file of collectStaticGameFiles(STATIC_GAME_DIR)) {
        const rel = relative(STATIC_GAME_DIR, file).split('\\').join('/');
        this.emitFile({
          type: 'asset',
          fileName: `${GAMES_URL_PREFIX || 'host-games'}/${STATIC_GAME_ID}/${rel}`,
          source: readFileSync(file),
        });
      }
    },
  };
}

export function forgeaxGamePluginIndex(pack: NonNullable<EngineVitePreset['pack']>) {
  const ROUTE_RE = /^\/game-plugins\/([a-z0-9][a-z0-9-]{1,40})\.json$/;
  return {
    name: 'forgeax:game-plugin-index',
    configureServer(server: { middlewares: { use(fn: Function): unknown } }) {
      server.middlewares.use((req: { url?: string }, res: { statusCode: number; setHeader(k: string, v: string): void; end(data: string): void }, next: () => void) => {
        const match = req.url?.match(ROUTE_RE);
        if (!match || match[1] === undefined) { next(); return; }
        const binding = pack.runtimeBinding();
        if (binding === undefined || binding.gameId !== match[1] || activeGameId !== match[1]) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'runtime-scope-not-found' }));
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ modules: gamePluginModules(activeGameDir, match[1]) }));
      });
    },
  };
}

const initialScopeCommand: RuntimeScopeCommand | undefined = (
  INITIAL_GAME_DIR
  && /^[a-z0-9][a-z0-9-]{0,40}$/.test(INITIAL_GAME_ID)
  && /^[a-zA-Z0-9._:-]{1,256}$/.test(INITIAL_SCOPE_ID)
  && Number.isSafeInteger(INITIAL_GENERATION)
  && INITIAL_GENERATION > 0
) ? {
  gameId: INITIAL_GAME_ID,
  scopeId: INITIAL_SCOPE_ID,
  generation: INITIAL_GENERATION,
  gameDir: INITIAL_GAME_DIR,
} : undefined;

// Play owns one active game realm. The engine plumbing itself is shared with
// Edit/Standalone; this host contributes only the exact roots and the dynamic
// scope controller.
// The Pack producer starts with shared/template roots and is rebound to the
// selected game's roots later. Native VFX cooking uses this same current-root
// resolver, so a late game bind cannot leave the cooker on the empty startup
// snapshot.
const resolveActivePackRoots = (): string[] =>
  singleGamePackRoots(activeGameDir, activeGameId);
const resolveActiveCatalogRoots = (gameDir: string, gameId: string) => resolveGameCatalogRoots(gameDir, {
  sharedBase: SHARED_BASE,
  catalogPrefixFor: (root) => relative(here, farmGamePath(root, gameDir, gameId)).replace(/\\/g, '/'),
});
const enginePreset = engineVitePreset({
  base: '/preview/',
  gameDirAbs: INITIAL_GAME_DIR || null,
  gameSource: {
    gameDirProvider: () => activeGameDir || null,
    staticGameDir: STATIC_GAME_DIR,
    packageRoots: [PLAY_PACKAGE_ROOT],
  },
  pack: {
    roots: resolveActivePackRoots(),
    rootsProvider: resolveActivePackRoots,
    cleanOrphanMetas: false,
  },
  materialPackagesProvider: () =>
    activeGameDir ? discoverGameMaterialPackages(activeGameDir) : [],
});
const playPackPlugin = enginePreset.pack;
if (!playPackPlugin) throw new Error('Play Runtime must own a Pack producer');

const runtimeScopeController = createRuntimeScopeController({
  pack: playPackPlugin,
  base: '/preview',
  secret: RUNTIME_SCOPE_SECRET,
  initial: initialScopeCommand,
  prepareGameMount: (gameDir, gameId) => {
    mountedGameLink = setupSingleGameRootFarm({
      farmRoot: resolve(here, HOST_GAMES_FARM),
      gameDir,
      gameId,
      previousMount: mountedGameLink,
    });
    activeGameDir = resolve(gameDir);
    activeGameId = gameId;
  },
  resolveRoots: (gameDir, gameId) => singleGamePackRoots(gameDir, gameId),
  resolveCatalogRoots: resolveActiveCatalogRoots,
});
export default defineConfig({
  root: viteRoot,
  // base: '/preview/' namespaces every URL Vite emits (deps, /@vite, /@id, etc).
  // The interface studio is at :18920 and proxies /preview → :15173/preview, so
  // engine's deps don't collide with interface's own /node_modules deps.
  base: '/preview/',
  cacheDir: resolve(here, '.vite'),
  publicDir: resolve(here, 'public'),
  // Inject the host-owned URL-space games prefix so the client builds game URLs
  // without a baked layout literal. '' → game served directly under base.
  define: {
    __FORGEAX_GAMES_URL_PREFIX__: JSON.stringify(GAMES_URL_PREFIX),
    __FORGEAX_STATIC_BUILD__: JSON.stringify(STATIC_BUILD),
    __FORGEAX_STATIC_GAME_ID__: JSON.stringify(STATIC_GAME_ID),
  },
  plugins: [
    forgeaxStaticGame() as never,
    forgeaxRuntimeIdentity() as never,
    ...enginePreset.plugins,
    forgeaxGamePluginIndex(playPackPlugin) as never,
    runtimeScopeController as never,
  ],
  optimizeDeps: enginePreset.optimizeDeps,
  resolve: {
    alias: {
      '@forgeax/game-types': resolve(here, 'src/types.ts'),
    },
    ...enginePreset.resolve,
  },
  server: {
    headers: ENGINE_EXECUTION_ISOLATION_HEADERS,
    port: PORT,
    host: HOST,
    strictPort: true,
    open: false,
    ...(GAME_API_PORT ? {
      proxy: {
        '/api': { target: `http://127.0.0.1:${GAME_API_PORT}`, changeOrigin: true },
      },
    } : {}),
    // Perf "A": the studio shell (:18920) now fetches game assets straight from
    // this play-engine origin (:15173) instead of via its same-origin /preview
    // proxy, so asset traffic gets its OWN browser connection pool and can't
    // starve the shell API. That makes the requests cross-origin, and Vite 8
    // defaults `server.cors` to false — without this the browser blocks the
    // responses (no Access-Control-Allow-Origin). Reflect only the studio dev
    // origins (loopback, http+https); override via FORGEAX_ASSET_CORS_ORIGINS
    // (comma-separated) for non-default interface ports / remote gateways.
    cors: {
      origin: assetCorsOrigins(),
    },
    watch: {
      usePolling: true,
      interval: 300,
      ignored: [
        ...PLAY_RUNTIME_STATIC_WATCH_IGNORES,
        // The exact active game is watched by pluginPack after scope bind;
        // sibling game directories are intentionally not mounted or watched.
        ...(activeGameDir ? [
          `${activeGameDir}/**/package.json`,
          `${activeGameDir}/**/tsconfig.json`,
        ] : []),
      ],
    },
    fs: { allow: [viteRoot], strict: false },
    // HMR clientPort: when vite runs behind a reverse proxy the browser must
    // open the HMR websocket to the *gateway* port (usually 443), not the
    // internal vite port. FORGEAX_HMR_CLIENT_PORT overrides
    // FORGEAX_INTERFACE_PORT for exactly this case.
    hmr: {
      clientPort: hmrClientPort(),
    },
  },
  build: {
    ...enginePreset.build,
    outDir: process.env.FORGEAX_BUILD_OUT_DIR ? resolve(process.env.FORGEAX_BUILD_OUT_DIR) : resolve(here, 'dist'),
  },
});
