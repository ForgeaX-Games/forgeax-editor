import { defineConfig } from 'vite';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, lstatSync, unlinkSync, symlinkSync, realpathSync, readFileSync } from 'node:fs';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
// Vite config bundling externalizes package subpaths, so Node would receive core's
// raw TypeScript export. Import the same core helper relatively to bundle it first.
import { resolveGameAssetRoots, type ResolvedRoot } from '../core/src/asset-roots';
import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { gltfImporter } from '@forgeax/engine-gltf';
import { fbxImporter } from '@forgeax/engine-fbx';
import { buildPerGameCatalog } from './pack-catalog.js';
import { PLAY_RUNTIME_STATIC_WATCH_IGNORES } from './src/watch-policy';

const here = dirname(fileURLToPath(import.meta.url));

interface PackageExports {
  readonly [subpath: string]: string | { readonly import?: string } | undefined;
}

// Game sources are mounted from a host-owned directory rather than living in a
// workspace package. Their normal node_modules walk-up therefore misses this
// runtime's isolated Bun workspace links. Resolve @forgeax imports from the
// Play Runtime's own public exports map, just as Edit Runtime does for ▶ Play.
// Keeping this in the preview host is essential: /preview/ has an independent
// Vite server and does not inherit Edit Runtime's plugin chain.
const HOST_GAMES_DIR = ['.', 'forgeax', 'games'].join('/').replace('./', '.');
// The in-root game mount is host-injected for parallel dev stacks. The default
// remains `host-games`; an isolated test or another host can choose a distinct
// prefix without competing for one shared symlink.
const HOST_GAMES_FARM = process.env.FORGEAX_GAMES_URL_PREFIX ?? 'host-games';
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const MULTI_GAME_PATH_RE = new RegExp(
  `/(?:${escapeRegex(HOST_GAMES_DIR)}|${escapeRegex(HOST_GAMES_FARM)}|packages\\/games|forgeax-games)/[^/]+/`,
);

function normalizeGameFilePath(raw: string, viteRoot: string): string {
  let path = raw.replace(/\\/g, '/');
  if (path.startsWith('/@fs/')) path = path.slice('/@fs/'.length);
  if (!path.startsWith('/')) path = resolve(viteRoot, path).replace(/\\/g, '/');
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

export function resolveGameEngineEntry(id: string): string | null {
  const rest = id.slice('@forgeax/'.length);
  const [packageName, ...subpath] = rest.split('/');
  if (!packageName) return null;
  const packageRoots = [resolve(here, 'node_modules')];
  if (HOST_PACKAGE_ROOT) {
    const hostRoot = resolve(HOST_PACKAGE_ROOT);
    packageRoots.push(hostRoot, resolve(hostRoot, 'node_modules'), resolve(hostRoot, 'packages'));
  }
  for (let cursor = dirname(here); cursor !== dirname(cursor); cursor = dirname(cursor)) {
    packageRoots.push(resolve(cursor, 'node_modules'), resolve(cursor, 'packages'));
  }
  for (const root of packageRoots) {
    for (const packageDir of [resolve(root, '@forgeax', packageName), resolve(root, packageName)]) {
      try {
        const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
          name?: string;
          exports?: PackageExports;
        };
        if (manifest.name !== id.split('/').slice(0, 2).join('/')) continue;
        const exportKey = subpath.length === 0 ? '.' : `./${subpath.join('/')}`;
        const entry = manifest.exports?.[exportKey];
        const importPath = typeof entry === 'string' ? entry : entry?.import;
        if (typeof importPath === 'string') return resolve(packageDir, importPath);
      } catch { /* try the next host-owned package root */ }
    }
  }
  return null;
}

function gameEngineResolve() {
  let viteRoot = process.cwd();
  const isGameImporter = (importer: string): boolean => {
    const normalized = normalizeGameFilePath(importer, viteRoot);
    return MULTI_GAME_PATH_RE.test(normalized)
      || (STATIC_GAME_DIR.length > 0 && normalized.startsWith(normalizeGameFilePath(STATIC_GAME_DIR, viteRoot)));
  };
  return {
    name: 'forgeax:game-engine-resolve',
    configResolved(config: { root: string }) {
      viteRoot = config.root;
    },
    resolveId(id: string, importer?: string) {
      if (!importer || !id.startsWith('@forgeax/')) return null;
      return isGameImporter(importer)
        ? resolveGameEngineEntry(id) ?? null
        : null;
    },
  };
}

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

// Games stay a host concern: a standalone/desktop/studio host injects the
// physical directory.  When it does not supply a public URL prefix, mount it
// under this generated in-root name so Vite can serve it without an ambient
// sibling-repository convention.
const PREVIEW_GAMES_DIR = process.env.FORGEAX_PREVIEW_GAMES_DIR;
const GAMES_URL_PREFIX = process.env.FORGEAX_GAMES_URL_PREFIX
  ?? (PREVIEW_GAMES_DIR ? HOST_GAMES_FARM : '');
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

// Implicit `template-game-default` shared scope. The demo-seed default template's
// scene references the shared sky.hdr equirect GUID (81eec382) but its own assets/
// has no sky.hdr and its package.json declares only `["assets"]` — never
// `@shared/template-game-default` (that would leak the editor's `@shared/`
// convention into the engine submodule's template). play-runtime injects the
// scope for EVERY game so the template sky folds into the pack catalog, matching
// edit-runtime's runtime-vite-preset (they share this via editor-core's
// resolveGameAssetRoots.implicitSharedSubs — architecture-principles §1 SSOT).
// Without it, /__import/<sky-guid> 404s `meta-not-found` and the skylight falls
// back to a solid color. existsSync-filtered, so an absent submodule degrades to
// game-only.
const IMPLICIT_SHARED_SUBS = ['template-game-default'] as const;

// Cross-platform external-root farm (generalizes the former single hardcoded
// `sharedAssetRoots()` mount — architecture-principles §1 SSOT: one `roots`
// concept, not a per-game list PLUS a separate shared-roots appender).
//
// WHY A SYMLINK IS STILL REQUIRED (not just an abs path in roots):
//   play-runtime's process.cwd() == viteRoot == this package dir, and every
//   catalog entry's packageUrl = withBase('/preview', relative(cwd, assetAbs))
//   (pack-catalog.ts). withBase does posix.resolve('/', rel), which CLAMPS
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
// Pack v2 scenes fall back to POST /__import/<scene-guid> with a 404. The
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

// Self-contained vite root: the engine directory itself. Pre-2026-05-13 the
// root was the parent dir (packages/forgeax/), which forced an
// engine-host-specific index.html to live one level up. With root = here,
// engine-src/ (studio) and packages/forgeax/engine/ (release) are both
// self-contained vite roots — a single index.html serves /preview/, and the
// host-injected games dir (FORGEAX_PREVIEW_GAMES_DIR) is served under the vite
// root so its games resolve; run.sh symlinks it to the instance's actual dir.
const viteRoot = here;

// Vite only serves files below its root. The games directory is deliberately
// external and host-injected, so make a generated, stable in-root junction for
// the default URL namespace. An explicit FORGEAX_GAMES_URL_PREFIX remains an
// advanced host-owned mount contract; do not create arbitrary paths from it.
(function setupGamesRootFarm() {
  if (!PREVIEW_GAMES_DIR || GAMES_URL_PREFIX !== HOST_GAMES_FARM) return;
  const targetPath = resolve(PREVIEW_GAMES_DIR);
  if (!existsSync(targetPath)) {
    console.warn(`[forgeax] FORGEAX_PREVIEW_GAMES_DIR does not exist: ${targetPath}`);
    return;
  }
  const linkPath = resolve(here, HOST_GAMES_FARM);
  if (existsSync(linkPath)) {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink()) {
      console.warn(`[forgeax] refusing to replace non-symlink games mount: ${linkPath}`);
      return;
    }
    try {
      if (realpathSync(linkPath) === realpathSync(targetPath)) return;
    } catch { /* replace a stale/broken generated link below */ }
    try { unlinkSync(linkPath); } catch (e) {
      console.warn(`[forgeax] failed to replace games junction:`, e);
      return;
    }
  }
  // `existsSync` is false for a broken generated symlink after an earlier
  // short-lived host deleted its temp games directory. lstatSync still sees
  // that link, so remove it before creating the next isolated mount.
  try {
    const stale = lstatSync(linkPath);
    if (stale.isSymbolicLink()) unlinkSync(linkPath);
  } catch {
    // No existing mount.
  }
  try {
    symlinkSync(targetPath, linkPath, 'junction');
  } catch (e) {
    console.warn(`[forgeax] failed to create games junction:`, e);
  }
})();

// ── @forgeax packages to exclude from pre-bundle (SSOT-derived, no hand list) ──
// SSOT = THIS root's node_modules/@forgeax, i.e. exactly the @forgeax packages
// Vite can resolve natively here. Excluding precisely that set is correct on both
// sides:
//   - Pre-bundling any of them risks the OOM: under preserveSymlinks:true Vite's
//     esbuild pre-bundle crawls the nested workspace symlink graph
//     (packages/engine/packages/*/node_modules/@forgeax/* → ../../../*), where one
//     source file reached via combinatorially-many distinct symlink paths becomes
//     a distinct module → esbuild blew past 70 GB the moment a game imported the
//     un-excluded @forgeax/engine-physics (it also drags in the Rapier WASM).
//   - They are all present here, so excluding them (→ served as native ESM) still
//     resolves. We must NOT over-exclude: transitive-only packages absent from
//     node_modules (e.g. @forgeax/engine-plugin / engine-debug-draw, imported by
//     engine-app / engine-runtime) have to stay pre-bundlable, or native import
//     analysis fails with "Failed to resolve import". So derive ONLY from what's
//     actually here — never the full engine/packages source tree.
// Hand-listing was the original bug: it named ~10 packages and missed physics.
// @forgeax/scene shares the engine module subgraph; keep it excluded as before.
function forgeaxWorkspacePackages(): string[] {
  const out = new Set<string>(['@forgeax/scene']);
  try {
    for (const name of readdirSync(resolve(here, 'node_modules/@forgeax'))) {
      out.add(`@forgeax/${name}`);
    }
  } catch { /* node_modules not materialised yet — fall through */ }
  return [...out];
}
const FORGEAX_WS_PKGS = forgeaxWorkspacePackages();

// Studio-owned game SDK packages are resolved from an injected host package
// root. This keeps standalone editor install independent from unpublished SDKs
// while letting embedded Studio games import them through the same resolver.
const HOST_PACKAGE_ROOT = process.env.FORGEAX_HOST_PACKAGE_ROOT;

const PORT = Number(process.env.FORGEAX_ENGINE_PORT ?? 15173);
const HOST = process.env.FORGEAX_ENGINE_HOST ?? '0.0.0.0';

// pluginPack's dev middleware matches the pack-index route literally as
// `/pack-index.json` (no base awareness), but this vite root uses
// `base: '/preview/'` so the proxied request arrives as
// `/preview/pack-index.json`. Mirror forgeaxShaderBaseStrip: strip the base
// prefix before pluginPack's middleware (registered after) sees the request.
// (Individual pack-file URLs do NOT need stripping — pluginPack serves them by
// matching the base-prefixed catalog `packageUrl`, which equals the proxied
// req.url verbatim.)
function forgeaxPackBaseStrip() {
  const PREFIX = '/preview/';
  const ROUTES = ['/pack-index.json', '/pack-index/', '/game-plugins/', '/__import/', '/__forgeax-ddc/', '/__pack/'];
  return {
    name: 'forgeax:pack-base-strip',
    configureServer(server: { middlewares: { use(fn: Function): unknown } }) {
      server.middlewares.use((req: { url?: string }, _res: unknown, next: () => void) => {
        if (req.url?.startsWith(PREFIX)) {
          const stripped = req.url.slice(PREFIX.length - 1);
          if (ROUTES.some((route) => stripped === route || stripped.startsWith(route))) {
            req.url = stripped;
          }
        }
        next();
      });
    },
  };
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

// Reject backup/snapshot dirs and hidden dot-dirs from being treated as games.
// Game optimize/migration tooling drops sibling backups like
// `<slug>.bak-1782212746` (a FULL copy, including `assets/`) under the games
// dir. Without this filter gameAssetRoots()/gameSlugs() count those
// as real games → the asset-root set differs from the boot snapshot →
// forgeaxGameRescan fires server.restart() (repeatedly, as more backups/tsconfig
// changes land) → the preview iframe gets ECONNREFUSED on :15173 during each
// restart window and sticks on "Loading game" forever.
const GAME_SLUG_REJECT_RE = /(^\.)|(\.bak(-|\.|$))/i;
function isRealGameSlug(slug: string): boolean {
  return !GAME_SLUG_REJECT_RE.test(slug);
}

// Games dir the pack scan walks. HOST-INJECTED via FORGEAX_PREVIEW_GAMES_DIR — the
// play-runtime holds ZERO on-disk layout convention; the host (studio run.ts /
// desktop build / editor standalone) points this at wherever it lays games out.
// Unset → empty (degraded: no roots scanned), never a baked layout literal.
function gamesDirRoot(): string {
  return PREVIEW_GAMES_DIR ? resolve(PREVIEW_GAMES_DIR) : '';
}

// URL-space games prefix the CLIENT (src/main.ts) prepends to build a game's
// served URL (`<base>/<prefix>/<id>/…`). Separate from gamesDirRoot() because the
// disk dir is symlinked UNDER the vite root, so the served URL reflects that mount
// point, not the abs disk path. Hosts may inject FORGEAX_GAMES_URL_PREFIX; with
// an injected games dir but no prefix, the generated host-games farm above is
// used. With neither, it is '' (game served directly under base).

// Scan every game's declared asset roots as pack roots. Uses the SSOT
// (package.json#forgeax.assets.roots via resolveGameAssetRoots, which also
// expands `@shared/<sub>` external roots) instead of hardcoding 'assets'.
// One-level glob over <gamesDir>/<slug>/<root> deliberately excludes nested
// dirs like shoot/backup/assets, whose .pack.json files reuse the same GUIDs
// and would trip the scanner's duplicate-guid guard (collapsing the catalog).
function gameAssetRoots(): string[] {
  const gamesDir = gamesDirRoot();
  if (!gamesDir) return [];
  if (!existsSync(gamesDir)) return [];
  // Deduplicate by absolute path. Every game gets the same implicit
  // `@shared/template-game-default` root; pushing it once per slug makes
  // scan() see sky.hdr.meta.json N times → pack-guid-collision → the
  // union catalog degrades → installCatalogProjection fails closed to []
  // → /__import 422 → defaultScene never instantiates (hellforge camp).
  const seen = new Set<string>();
  const roots: string[] = [];
  const push = (abs: string): void => {
    if (seen.has(abs)) return;
    seen.add(abs);
    roots.push(abs);
  };
  if (existsSync(engineTemplateUiFarmPath())) push(engineTemplateUiFarmPath());
  for (const root of templateAudioRoots()) push(root);
  for (const slug of readdirSync(gamesDir).filter(isRealGameSlug)) {
    const gameDir = join(gamesDir, slug);
    // resolveGameAssetRoots reads package.json#forgeax.assets.roots (SSOT),
    // resolves `@shared/<sub>` external roots against SHARED_BASE, and
    // existsSync-filters. farmGamePath redirects local and shared roots through
    // in-viteRoot mounts so their scanned paths and packageUrls stay serveable.
    for (const r of resolveGameAssetRoots(gameDir, { sharedBase: SHARED_BASE, implicitSharedSubs: IMPLICIT_SHARED_SUBS })) {
      push(farmGamePath(r, gameDir, slug));
    }
  }
  return roots;
}

// Per-game pack roots: the game's declared asset roots (local + `@shared/…`)
// from package.json#forgeax.assets.roots (SSOT), farm-rewritten so shared roots
// serve from under viteRoot. Scene packs live alongside other assets under the
// declared roots (A2/A3: scenes are ordinary assets).
function perGamePackRoots(slug: string): string[] {
  const gameDir = join(gamesDirRoot(), slug);
  const roots = resolveGameAssetRoots(gameDir, { sharedBase: SHARED_BASE, implicitSharedSubs: IMPLICIT_SHARED_SUBS })
    .map((root) => farmGamePath(root, gameDir, slug));
  return [
    ...(existsSync(engineTemplateUiFarmPath()) ? [engineTemplateUiFarmPath()] : []),
    ...templateAudioRoots(),
    ...roots,
  ];
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
function gamePluginModules(slug: string): Array<{ clientPath: string; url: string }> {
  const gameDir = join(gamesDirRoot(), slug);
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

// Return slugs for every game directory under the host-injected games dir that
// has at least one (existing) declared asset root. Mirrors gameAssetRoots().
function gameSlugs(): string[] {
  const gamesDir = gamesDirRoot();
  if (!gamesDir || !existsSync(gamesDir)) return [];
  return readdirSync(gamesDir)
    .filter(isRealGameSlug)
    .filter((slug) => resolveGameAssetRoots(join(gamesDir, slug), { sharedBase: SHARED_BASE }).length > 0);
}

export function forgeaxGamePluginIndex() {
  const ROUTE_RE = /^\/game-plugins\/([a-z0-9][a-z0-9-]{1,40})\.json$/;
  return {
    name: 'forgeax:game-plugin-index',
    configureServer(server: { middlewares: { use(fn: Function): unknown } }) {
      server.middlewares.use((req: { url?: string }, res: { statusCode: number; setHeader(k: string, v: string): void; end(data: string): void }, next: () => void) => {
        const match = req.url?.match(ROUTE_RE);
        if (!match || match[1] === undefined) { next(); return; }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ modules: gamePluginModules(match[1]) }));
      });
    },
  };
}

// Per-game base-strip: pluginPack's middleware matches per-game routes as
// /pack-index/<slug>.json. With base '/preview/' this becomes
// /preview/pack-index/<slug>.json. Strip the base prefix before pluginPack's
// middleware (or our own) sees the request. Placed after forgeaxPackBaseStrip
// so the literal /pack-index.json (no slug) is still handled by existing
// global route.
function forgeaxPerGamePackBaseStrip() {
  const PER_GAME_PREFIX = '/preview/pack-index/';
  return {
    name: 'forgeax:per-game-pack-base-strip',
    configureServer(server: { middlewares: { use(fn: Function): unknown } }) {
      server.middlewares.use((req: { url?: string }, _res: unknown, next: () => void) => {
        if (req.url?.startsWith(PER_GAME_PREFIX)) {
          req.url = '/pack-index/' + req.url.slice(PER_GAME_PREFIX.length);
        }
        next();
      });
    },
  };
}

// Decode percent-encoded request URLs before pluginPack's dev middleware runs
// its urlToAbs lookup. The map is keyed by catalog packageUrl values verbatim
// (literal spaces / non-ASCII, e.g. "GT_MC_Large Building.glb"), while the
// runtime's fetch arrives percent-encoded (%20). Without decoding, the lookup
// misses and the request falls through to Vite's SPA fallback — the runtime
// then receives text/html where it expected a zstd .bin, surfacing as
// `asset-parse-failed: zstd decompression` and a failed Add-to-Scene.
// Editor-side workaround for the engine bug tracked in
// forgeax-engine-harness/feedbacks/2026-07-22-vite-plugin-pack-unicode-url-mismatch.md
// (engine fix pending release); prescribed by
// Forgeax-editor-harness/feedbacks/2026-07-22-editor-url-decode-middleware-workaround.md.
// Dev-only and additive: URLs without '%' pass through untouched, and a
// malformed escape is left verbatim for downstream middleware to handle.
function forgeaxDecodeAssetUrl() {
  return {
    name: 'forgeax:decode-asset-url',
    configureServer(server: { middlewares: { use(fn: Function): unknown } }) {
      server.middlewares.use((req: { url?: string }, _res: unknown, next: () => void) => {
        if (req.url !== undefined && req.url.includes('%')) {
          try {
            req.url = decodeURIComponent(req.url);
          } catch {
            // Malformed escape — leave the URL untouched.
          }
        }
        next();
      });
    },
  };
}

// Per-game pack-index plugin: dev middleware serves /pack-index/<slug>.json
// by calling buildPerGameCatalog; prod generateBundle emits independent
// per-game pack-index files.
export function forgeaxPerGamePackIndex() {
  const PER_GAME_ROUTE_RE = /^\/pack-index\/([a-z0-9][a-z0-9-]{1,40})\.json$/;
  return {
    name: 'forgeax:per-game-pack-index',
    configureServer(server: { middlewares: { use(fn: Function): unknown } }) {
      server.middlewares.use(async (req: { url?: string }, res: { statusCode: number; setHeader(k: string, v: string): void; end(data: string): void }, next: () => void) => {
        const match = req.url?.match(PER_GAME_ROUTE_RE);
        if (!match) { next(); return; }
        const slug = match[1];
        if (slug === undefined) { next(); return; }
        const roots = perGamePackRoots(slug);
        if (roots.length === 0) { next(); return; }
        try {
          const catalog = await buildPerGameCatalog(roots[0]!, '/preview', [...roots.slice(1)]);
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 200;
          res.end(JSON.stringify(catalog));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'per-game catalog build failed', slug, detail: err instanceof Error ? err.message : String(err) }));
        }
      });
    },
    async generateBundle(this: { emitFile(opts: { type: string; fileName: string; source: string }): void }, _opts: unknown, _bundle: unknown) {
      // Prod: emit per-game pack-index files. The existing pluginPack
      // (registered before us) already emits the global /pack-index.json
      // and cooks textures. We add per-game sidecars.
      for (const slug of gameSlugs()) {
        const roots = perGamePackRoots(slug);
        if (roots.length === 0) continue;
        try {
          const catalog = await buildPerGameCatalog(roots[0]!, '/preview', [...roots.slice(1)]);
          const fileName = `pack-index/${slug}.json`;
          this.emitFile({
            type: 'asset',
            fileName,
            source: JSON.stringify(catalog),
          });
        } catch (err) {
          console.warn(`[forgeax:per-game-pack-index] failed to build catalog for ${slug}:`, err instanceof Error ? err.message : String(err));
        }
      }
    },
  };
}

// gameAssetRoots() is evaluated once at config load, so a game scaffolded /
// given assets AFTER server start is absent from pluginPack's catalog and its
// textures/meshes 404 in the preview. This dev-only plugin watches the games
// tree and, when the set of asset roots changes (a new game gains an assets/
// dir or a *.pack.json lands), restarts vite — which re-runs the config and
// re-seeds pluginPack with the new roots. Debounced + change-gated so ordinary
// edits inside existing games (already HMR'd) never trigger a restart, and so
// the burst of writes during scaffolding collapses into a single restart.
function forgeaxGameRescan() {
  return {
    name: 'forgeax:game-rescan',
    configureServer(server: any) {
      const gamesDir = gamesDirRoot();
      if (!gamesDir) return; // host injected no games dir → nothing to watch
      const gamesDirNorm = gamesDir.split('\\').join('/');
      // Gate the restart on the set of GAME SLUG directories, NOT on asset-root
      // materialization. Importing an asset into the game the user is actively
      // editing can create / first-populate that game's declared `assets/` root;
      // the old `gameAssetRoots()` comparison then saw the root set grow and fired
      // server.restart(), which drops :15173 /preview mid-edit → the Studio host
      // page reloads and every unsaved scene edit / undo history / panel state is
      // lost (this is the second, independent reload path besides pluginPack's
      // full-reload). A restart is only truly needed when a brand-new game APPEARS
      // (or is removed) so pluginPack can seed its roots at config time; assets
      // added inside an already-known game are picked up by pluginPack's own
      // watcher and served fresh by the per-game pack-index middleware, so they
      // need no restart. Comparing slug sets restarts on game create/delete only.
      const gameSlugSet = (): Set<string> =>
        new Set(existsSync(gamesDir) ? readdirSync(gamesDir).filter(isRealGameSlug) : []);
      let known = gameSlugSet();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const maybeRestart = (p: string) => {
        if (!p.split('\\').join('/').startsWith(gamesDirNorm)) return;
        const next = gameSlugSet();
        const changed = next.size !== known.size || [...next].some((s) => !known.has(s));
        if (!changed) return;
        known = next;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          // Vite 6 bug: concurrent server.restart() calls race and deadlock the server
          // (https://github.com/vitejs/vite/issues/21636). Use a global lock on the
          // process to guarantee we never trigger a restart while one is already in flight.
          if ((process as any).__forgeax_restarting) return;
          console.log('[forgeax:game-rescan] asset roots changed → restarting vite');
          (process as any).__forgeax_restarting = true;
          server.restart().finally(() => {
            // Add a small debounce after restart completes before allowing another
            setTimeout(() => {
              (process as any).__forgeax_restarting = false;
            }, 1000);
          });
        }, 400);
      };
      server.watcher.on('addDir', (p: string) => maybeRestart(p));
      server.watcher.on('add', (p: string) => { if (p.endsWith('.pack.json')) maybeRestart(p); });
      server.watcher.on('unlinkDir', (p: string) => maybeRestart(p));
      try { server.watcher.add(gamesDir); } catch { /* games dir may not exist yet */ }
    },
  };
}

// Wrap forgeaxShader() to silence vite's "emitFile() is not supported in serve
// mode" warnings: the upstream plugin calls this.emitFile() in buildStart and
// transform to feed rollup's bundle phase (production build). In serve mode
// the manifest is served via configureServer middleware instead, so emitFile
// is functionally a no-op — vite 6+ logs a noisy warning per call (27+ during
// startup). This wrapper proxies the plugin context to swallow emitFile when
// command === 'serve'. Build mode delegates unchanged.
function silenceShaderEmitInServe(plugin: any) {
  let isServe = false;
  const orig = plugin;
  return {
    ...orig,
    configResolved(config: { command: string }) {
      isServe = config.command === 'serve';
      if (typeof orig.configResolved === 'function') return orig.configResolved.call(this, config);
    },
    buildStart(this: any) {
      if (!isServe || typeof orig.buildStart !== 'function') {
        return orig.buildStart?.call(this);
      }
      const proxy = new Proxy(this, {
        get(target, prop) {
          if (prop === 'emitFile') return () => '';
          return (target as any)[prop];
        },
      });
      return orig.buildStart.call(proxy);
    },
    transform(this: any, code: string, id: string) {
      if (typeof orig.transform !== 'function') return undefined;
      if (!isServe) return orig.transform.call(this, code, id);
      const proxy = new Proxy(this, {
        get(target, prop) {
          if (prop === 'emitFile') return () => '';
          return (target as any)[prop];
        },
      });
      return orig.transform.call(proxy, code, id);
    },
  };
}

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
    gameEngineResolve() as never,
    forgeaxStaticGame() as never,
    forgeaxRuntimeIdentity() as never,
    forgeaxPackBaseStrip() as never,
    forgeaxPerGamePackBaseStrip() as never,
    // URL-decode MUST precede pluginPack: its urlToAbs keys are verbatim
    // catalog packageUrls (literal spaces), requests arrive percent-encoded.
    forgeaxDecodeAssetUrl() as never,
    forgeaxGamePluginIndex() as never,
    // SINGLE pluginPack instance over every game's roots — LOCAL and `@shared/…`
    // alike (gameAssetRoots() now farm-rewrites shared roots into this one list;
    // there is no longer a separate sharedAssetRoots() appender — §1 SSOT).
    // It was once TWO instances (game roots, then shared) — but both register a
    // vite plugin named 'forgeax:pack', each mounting its OWN `/__import/:guid`
    // dev middleware. Middlewares run in registration order, and the handler
    // 404s (`meta-not-found`) + RETURNS on a GUID absent from its own catalog
    // instead of `next()`-ing. So the first (game-roots) instance swallowed
    // every request for a shared-asset GUID (the template sky.hdr equirect) →
    // the shared instance never saw it → `/__import/<sky>` 404 → solid-color
    // skylight fallback. ONE instance with the UNION of roots puts every GUID in
    // a single catalog + single middleware, so the cold-import cook path resolves
    // shared + per-game GUIDs alike. imageImporter is needed for the .hdr equirect
    // sidecar (else the bare .hdr is mislabeled rgba8unorm and
    // uploadCubemapFromEquirect rejects with `invalid-source-format`);
    // gltfImporter for per-game .glb cooks. gameAssetRoots() de-dupes shared
    // roots so the union scan stays authoritative; a true cross-root GUID
    // collision still fails closed so duplicate authored GUIDs remain visible.
    pluginPack({
      roots: gameAssetRoots(),
      base: '/preview/',
      importers: [audioImporter, imageImporter, gltfImporter, fbxImporter],
      // No-op host refresh: importing an asset in the editor MUST NOT full-reload
      // the page. In Studio single-realm the editor + engine boot IN the :18920
      // window, and this play engine (:15173) is proxied in via /preview (ws:true),
      // so pluginPack's default watcher answer — server.ws.send({type:'full-reload'})
      // on a watched source/sidecar change — reaches the host window and reloads it,
      // wiping unsaved scene edits, undo history, selection and panel state. (The
      // reload fires on the source-only debounce batch: an import writes bytes +
      // .meta.json, and a source-only batch hits the `!catalogChanged &&
      // !hasCatalogSidecar` full-reload branch.) The imported asset still appears
      // without a reload: the Content Browser refreshes via import-pipeline's
      // broadcastAssetsChanged + the server /ws disk-watch channel, and pluginPack
      // still emits its incremental catalog-delta / forgeax:asset-changed events.
      refresh: () => {},
    }) as never,
    forgeaxPerGamePackIndex() as never,
    forgeaxGameRescan() as never,
    silenceShaderEmitInServe(forgeaxShader()) as never,
  ],
  optimizeDeps: {
    // Exclude the ENTIRE @forgeax workspace family from Vite pre-bundling so each
    // is loaded as native ESM .mjs (engine outputs ESM .mjs; pre-bundling would
    // break source maps + module identity for the engine subgraph). Deriving the
    // full list (see forgeaxWorkspacePackages) is load-bearing: a game's
    // dynamically-imported main.ts (loadGame, not in the startup scan) may pull
    // ANY engine package or subpath (@forgeax/engine-physics,
    // @forgeax/engine-pack/guid, …); a missing entry lets Vite lazily pre-bundle
    // it and OOM esbuild on the preserveSymlinks symlink-diamond, besides the
    // new-game re-optimize flicker.
    exclude: FORGEAX_WS_PKGS,
    // Don't hold module requests until the static-import crawl finishes. With
    // preserveSymlinks:true over the @forgeax symlink-diamond, that crawl can run
    // very long / wedge — most visibly after an in-process server.restart()
    // (forgeaxGameRescan fires one whenever the active-workspace symlink flips or
    // a game is scaffolded). With holdUntilCrawlEnd:true (the default) Vite then
    // holds ALL requests behind the never-finishing crawl → the engine vite binds
    // :15173 but answers nothing (0% CPU) → the preview iframe never boots → Play
    // sticks on "Loading game" / black screen. We exclude the whole @forgeax
    // family anyway (nothing left to discover), so releasing after the scanner is
    // strictly better here and removes the wedge.
    holdUntilCrawlEnd: false,
  },
  resolve: {
    alias: {
      '@forgeax/game-types': resolve(here, 'src/types.ts'),
    },
    // Dedupe the whole @forgeax family (same SSOT-derived list as optimizeDeps):
    // every engine package must resolve to a single instance so ECS handles /
    // component identities match across the game subgraph. A hand-listed subset
    // had the same drift hazard as the old exclude list.
    dedupe: FORGEAX_WS_PKGS,
    // User game files live under the host-injected games dir, one dir per slug
    // (entry is a root-level main.ts, extra modules under src/), reachable via
    // run.sh's symlink of that dir under the vite root.
    // With default preserveSymlinks: false, vite resolves the symlink first and
    // walks up from <studio-root>, where node_modules/@forgeax/ doesn't exist
    // (workspace symlinks live at engine-src/node_modules/@forgeax/*).
    // preserveSymlinks: true keeps resolution rooted at engine-src so imports
    // like '@forgeax/engine-runtime' from user game code find the workspace
    // symlinks. fs.allow.strict=false still permits loading the actual file
    // through the symlink.
    preserveSymlinks: true,
  },
  server: {
    port: PORT,
    host: HOST,
    strictPort: true,
    open: false,
    // Perf "A": the studio shell (:18920) now fetches game assets straight from
    // this play-engine origin (:15173) instead of via its same-origin /preview
    // proxy, so asset traffic gets its OWN browser connection pool and can't
    // starve the shell API. That makes the requests cross-origin, and Vite 8
    // defaults `server.cors` to false — without this the browser blocks the
    // responses (no Access-Control-Allow-Origin). Reflect only the studio dev
    // origins (loopback, http+https); override via FORGEAX_ASSET_CORS_ORIGINS
    // (comma-separated) for non-default interface ports / remote gateways.
    cors: {
      origin: (process.env.FORGEAX_ASSET_CORS_ORIGINS
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean)) ?? [
        'http://127.0.0.1:18920',
        'http://localhost:18920',
        'https://127.0.0.1:18920',
        'https://localhost:18920',
      ],
    },
    watch: {
      usePolling: true,
      interval: 300,
      ignored: [
        ...PLAY_RUNTIME_STATIC_WATCH_IGNORES,
        // Game backup snapshots (`<slug>.bak-<ts>` / `<slug>.bak`) are NOT games;
        // ignore them so vite's tsconfig watcher won't force-reload on their
        // tsconfig.json and forgeaxGameRescan won't restart-loop (preview black
        // screen / stuck "Loading game"). Mirrors isRealGameSlug(). Derived from
        // the host-injected games dir — no baked layout literal.
        ...(gamesDirRoot() ? [
          `${gamesDirRoot()}/*.bak-*/**`,
          `${gamesDirRoot()}/*.bak/**`,
          // Prevent Vite's internal watcher from triggering concurrent restarts
          // when the workspace symlink flips and package.json/tsconfig.json change.
          `${gamesDirRoot()}/**/package.json`,
          `${gamesDirRoot()}/**/tsconfig.json`,
        ] : []),
      ],
    },
    fs: { allow: [viteRoot], strict: false },
    // HMR clientPort: when vite runs behind a reverse proxy the browser must
    // open the HMR websocket to the *gateway* port (usually 443), not the
    // internal vite port. FORGEAX_HMR_CLIENT_PORT overrides
    // FORGEAX_INTERFACE_PORT for exactly this case.
    hmr: {
      clientPort: Number(
        process.env.FORGEAX_HMR_CLIENT_PORT ?? process.env.FORGEAX_INTERFACE_PORT ?? 18920,
      ),
    },
  },
  // esnext: keep parity with edit-runtime — the engine host entry may use
  // top-level await; vite's default build target (es2020/chrome87/safari14)
  // forbids TLA. This runtime only runs in WKWebView/Chrome (TLA-capable) and
  // dev serve already runs it untranspiled, so esnext is safe.
  build: { outDir: process.env.FORGEAX_BUILD_OUT_DIR ? resolve(process.env.FORGEAX_BUILD_OUT_DIR) : resolve(here, 'dist'), target: 'esnext' },
});
