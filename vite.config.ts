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
import { dirname, resolve, basename, sep } from 'node:path';
import { existsSync, createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

// ── standalone game source (see plan: cli.sh run --game <path>) ──────────────
// The standalone stack has NO backend (forgeax-server :18900 is studio-only).
// editor-core reads game files via fetch('/api/files*'); with no server those
// fetch HTML (SPA fallback) and the editor falls back to the demo seed. When
// `cli.sh run --game <dir>` is used it exports FORGEAX_GAME_DIR; we then serve
// a MINIMAL READ-ONLY /api/files{,/raw,/tree} from that dir via a vite
// middleware (gameApiMiddleware below) — no extra process, no studio server.
// The slug (basename) is the opaque key threaded through iframe URLs; the
// absolute path lives only here, server-side. No --game → GAME_DIR null →
// middleware is a pure pass-through and the demo-seed path is unchanged.
const GAME_DIR = process.env.FORGEAX_GAME_DIR
  ? resolve(process.env.FORGEAX_GAME_DIR)
  : null;
const GAME_SLUG = GAME_DIR ? basename(GAME_DIR) : null;

// Map a client-space path (`<slug>/<rel>` — what resolveGamePath produced and
// sent as ?path=/?root=) back to an absolute disk path under GAME_DIR, with a
// path-traversal guard. Returns null on escape (caller → 403).
function toDiskPath(clientPath: string | null): string | null {
  if (GAME_DIR === null || GAME_SLUG === null || clientPath === null) return null;
  let rel = clientPath;
  if (rel === GAME_SLUG) rel = '';
  else if (rel.startsWith(`${GAME_SLUG}/`)) rel = rel.slice(GAME_SLUG.length + 1);
  const abs = resolve(GAME_DIR, rel);
  const rootWithSep = GAME_DIR.endsWith(sep) ? GAME_DIR : GAME_DIR + sep;
  if (abs !== GAME_DIR && !abs.startsWith(rootWithSep)) return null; // escape
  return abs;
}

const RAW_CONTENT_TYPE: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.hdr': 'image/vnd.radiance',
  '.webp': 'image/webp',
  '.ktx2': 'image/ktx2',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

interface TreeNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  children?: TreeNode[];
}

// Recursive directory walk. `clientPath` is kept in CLIENT space (rooted at the
// verbatim ?root= the caller sent) because callers strip resolveGamePath('')
// (=<slug>) as the prefix and re-fetch n.path via /api/files. node_modules/.git
// are skipped server-side to bound large game trees.
async function walkTree(diskPath: string, clientPath: string, name: string): Promise<TreeNode> {
  const st = await stat(diskPath);
  if (!st.isDirectory()) return { name, path: clientPath, type: 'file' };
  const node: TreeNode = { name, path: clientPath, type: 'dir', children: [] };
  let entries: string[] = [];
  try {
    entries = await readdir(diskPath);
  } catch {
    return node;
  }
  for (const entry of entries.sort()) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const childDisk = resolve(diskPath, entry);
    const childClient = clientPath ? `${clientPath}/${entry}` : entry;
    try {
      node.children!.push(await walkTree(childDisk, childClient, entry));
    } catch {
      /* unreadable entry — skip */
    }
  }
  return node;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

// Minimal read-only file backend for the standalone stack. Only active when
// --game set a GAME_DIR; otherwise every request passes through to vite.
function gameApiMiddleware() {
  return {
    name: 'forgeax:game-api',
    configureServer(server: {
      middlewares: {
        use(fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void): unknown;
      };
    }) {
      server.middlewares.use((req, res, next) => {
        if (GAME_DIR === null || !req.url || req.method !== 'GET') return next();
        const u = new URL(req.url, 'http://localhost');
        const route = u.pathname;
        if (route !== '/api/files' && route !== '/api/files/raw' && route !== '/api/files/tree') {
          return next();
        }
        void (async () => {
          try {
            if (route === '/api/files/tree') {
              const root = u.searchParams.get('root') ?? '';
              const disk = toDiskPath(root);
              if (disk === null) return sendJson(res, 403, { error: 'forbidden' });
              try {
                const tree = await walkTree(disk, root, basename(disk));
                return sendJson(res, 200, { tree });
              } catch {
                return sendJson(res, 200, { tree: null });
              }
            }
            const disk = toDiskPath(u.searchParams.get('path'));
            if (disk === null) return sendJson(res, 403, { error: 'forbidden' });
            if (route === '/api/files/raw') {
              try {
                await stat(disk);
              } catch {
                return sendJson(res, 404, { error: 'not-found' });
              }
              const ext = disk.slice(disk.lastIndexOf('.')).toLowerCase();
              res.statusCode = 200;
              res.setHeader('Content-Type', RAW_CONTENT_TYPE[ext] ?? 'application/octet-stream');
              createReadStream(disk).on('error', () => {
                if (!res.headersSent) res.statusCode = 500;
                res.end();
              }).pipe(res);
              return;
            }
            // /api/files — text content. ?optional=1 mirrors the studio server
            // contract: an absent file returns 200 {exists:false} (not 404) so
            // per-developer optional state like play-config.json logs no error.
            try {
              const content = await readFile(disk, 'utf8');
              return sendJson(res, 200, { content });
            } catch {
              if (u.searchParams.get('optional') === '1') {
                return sendJson(res, 200, { content: null, exists: false });
              }
              return sendJson(res, 404, { error: 'not-found' });
            }
          } catch {
            return sendJson(res, 500, { error: 'internal' });
          }
        })();
      });
    },
  };
}

// INTERFACE_DIR resolution — embedded vs standalone:
//   - Embedded in studio: the parent studio tree's packages/interface (../../
//     interface) is the canonical single copy; prefer it so editor shares the
//     same interface instance studio uses.
//   - Standalone clone: editor vendors interface as its own submodule at
//     packages/interface; use that.
const STUDIO_INTERFACE = resolve(PACKAGE_DIR, '../interface');
const VENDORED_INTERFACE = resolve(PACKAGE_DIR, 'packages/interface');
const INTERFACE_DIR = existsSync(resolve(STUDIO_INTERFACE, 'src/app-kit.ts'))
  ? STUDIO_INTERFACE
  : VENDORED_INTERFACE;
// @forgeax/design now lives inside the interface repo (packages/design), so it
// travels with whichever interface checkout we resolved above.
const DESIGN_DIR = resolve(INTERFACE_DIR, 'packages/design');
// host-sdk / types are studio-layer packages only exercised by the wb:* plugin
// path (studio-only; never rendered in the standalone editor shell). interface
// now imports host-sdk as TYPES ONLY (the runtime port factories are injected
// via PanelRenderers), so a standalone clone needs NO host-sdk runtime binding
// and NO stub — type-only imports are erased at build. We still alias to the
// real sources WHEN the studio tree is present (embedded mode) so types resolve.
const STUDIO_ROOT = resolve(PACKAGE_DIR, '../..');
const HOST_SDK = resolve(STUDIO_ROOT, 'packages/host-sdk/src/index.ts');
const TYPES_SRC = resolve(STUDIO_ROOT, 'packages/types/src/index.ts');
const studioLayerAlias: Record<string, string> = {};
if (existsSync(HOST_SDK)) studioLayerAlias['@forgeax/host-sdk'] = HOST_SDK;
if (existsSync(TYPES_SRC)) studioLayerAlias['@forgeax/types'] = TYPES_SRC;

export default defineConfig({
  root: resolve(PACKAGE_DIR, 'standalone'),
  base: '/',
  plugins: [react(), gameApiMiddleware()],
  // Expose the game slug to the standalone client bundle so it can pin the
  // game and thread ?scene=/?gameRoot= into the editor iframes. null = no --game.
  define: { __FORGEAX_GAME_SLUG__: JSON.stringify(GAME_SLUG) },
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
      '@forgeax/design/preset': resolve(DESIGN_DIR, 'preset.ts'),
      '@forgeax/design/theme': resolve(DESIGN_DIR, 'theme.ts'),
      '@forgeax/design/tokens.css': resolve(DESIGN_DIR, 'tokens.css'),
      '@forgeax/design': resolve(DESIGN_DIR, 'index.ts'),
      // host-sdk / types only when the studio tree is present (embedded mode).
      ...studioLayerAlias,
    },
  },
  optimizeDeps: {
    // Same exclusion as interface vite — pre-bundle would drop named exports
    // that lazy editor-core code expects.
    exclude: ['@forgeax/engine-runtime'],
    // Pre-bundle react so the single-instance dedupe holds. dockview /
    // @forgeax/interface are NOT listed: optimizeDeps.include resolves from the
    // vite ROOT (standalone/), but those packages live in the vendored
    // interface's own node_modules (resolvable from DockShell.tsx's location,
    // not from the root). Vite auto-discovers and optimizes them on first
    // crawl from the actual import sites, so listing them here only produced a
    // spurious "Failed to resolve dependency" warning.
    include: ['react', 'react-dom', 'react-dom/client'],
  },
  server: {
    port: 15290,
    strictPort: true,
    host: '127.0.0.1',
    fs: {
      // DockShell/EditorPanelFrame + design live under INTERFACE_DIR (the
      // vendored submodule when standalone, or the studio sibling when
      // embedded). Allow the editor root (covers packages/interface) and, when
      // embedded, the studio root so the shared interface copy is served too.
      allow: existsSync(resolve(STUDIO_ROOT, 'package.json'))
        ? [PACKAGE_DIR, STUDIO_ROOT]
        : [PACKAGE_DIR],
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
