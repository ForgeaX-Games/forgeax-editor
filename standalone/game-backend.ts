// game-backend.ts — the standalone editor's REUSED platform-io backend (R3).
//
// WHY A SEPARATE BUN PROCESS — BY DESIGN (not a workaround)
//   [feat-20260705-editor-runtime-gates-and-backend-seams T7/q3; ideal-clean-architecture.md §5]
//   editor-core reaches its backend via the injected ApiClient (R2). Standalone
//   has no studio server, so this process IS the backend — and it must be the
//   REAL @forgeax/platform-io file router, not a hand-written second backend.
//   It can't live inside vite.config.ts: vite 8 loads its config through Node's
//   ESM loader, which can't resolve platform-io's extensionless `.ts` barrel
//   re-exports (bun can — which is why cli/server mount the same router fine).
//   So we run it as its own bun process and let the :15290 host vite PROXY
//   `/api` here. This mirrors studio exactly: a bun process serving the hono IO
//   router, the editor proxying to it — only confined to one game.
//
//   Confinement: singleGameFileBackend(GAME_DIR) restricts every read/write to
//   the one --game dir, addressed by client-space `<slug>/<rel>` (the exact
//   paths editor-core's resolveGamePath emits). Read + WRITE = self-boot B2.
//
// createFilesRouter() returns a Hono instance whose routes are rooted at `/`
// (`/`, `/upload`, `/raw`, `/tree`); the browser hits `/api/files…`. We re-root
// the request path before handing it to the router's .fetch, so this file needs
// NO `hono` import (hono isn't a direct editor dep — it lives only inside
// platform-io's own node_modules; bun resolves @forgeax/platform-io natively).
//
// Run (fx.ts wires this): FORGEAX_GAME_DIR=<dir> bun standalone/game-backend.ts
//   env FORGEAX_GAME_API_PORT overrides the port (default 15281).

import { createFilesRouter, createPrefsRouter, singleGameFileBackend } from '@forgeax/platform-io';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const gameDir = process.env.FORGEAX_GAME_DIR;
if (!gameDir) {
  console.error('[game-backend] FORGEAX_GAME_DIR is required (the --game dir).');
  process.exit(1);
}

const port = Number(process.env.FORGEAX_GAME_API_PORT ?? 15281);
const gameSlug = basename(resolve(gameDir));

/**
 * Engine catalog rows can retain Studio's project-space `games/<slug>/...`
 * source path. The standalone backend deliberately accepts the narrower
 * `<slug>/...` client coordinate, so normalize that legacy alias at the host
 * boundary before the shared platform router applies its confinement check.
 */
function singleGameClientPath(path: string): string {
  const studioPrefix = `games/${gameSlug}`;
  if (path === studioPrefix) return gameSlug;
  if (path.startsWith(`${studioPrefix}/`)) return `${gameSlug}/${path.slice(studioPrefix.length + 1)}`;
  return path;
}

// Read editor version from package.json at startup for /api/version endpoint.
let editorVersion = '0.0.0';
try {
  const pkg = await Bun.file(new URL('../package.json', import.meta.url)).json();
  editorVersion = pkg.version || editorVersion;
} catch {
  // Keep fallback version.
}

// Two real @forgeax/platform-io routers, the exact ones cli/server mount:
//   /api/files  — file IO, confined to the one --game dir (read + WRITE = B2).
//   /api/prefs  — UI-pref server mirror (workspace-layout, browser-localStorage,
//     uninstalled-agents), persisted under <gameDir>/.forgeax/prefs/. Without
//     this, the client's GET/PUT /api/prefs/workspace-layout/* 404'd (the
//     `--game` path returns 404+json, which the client doesn't latch as
//     "no backend" the way it does the no-game SPA-html fallback) — harmless
//     console noise, but now the layout actually persists into the game.
const filesBackend = singleGameFileBackend(gameDir);
const filesRouter = createFilesRouter(filesBackend);
const PREFIXES = [
  { prefix: '/api/files', router: filesRouter, isFiles: true },
  { prefix: '/api/prefs', router: createPrefsRouter(gameDir), isFiles: false },
] as const;

/** Strong file revision used by AssetIO's source-sidecar CAS contract. */
async function fileRevision(clientPath: string): Promise<string | null> {
  const abs = filesBackend.resolveRead(clientPath);
  if (abs === null) return null;
  try {
    const bytes = await readFile(abs);
    return `"sha256:${createHash('sha256').update(bytes).digest('hex')}"`;
  } catch {
    return null;
  }
}

async function casResponse(
  request: Request,
  clientPath: string,
): Promise<Response | undefined> {
  if (request.method !== 'POST' || clientPath !== '/') return undefined;
  let body: { path?: unknown; expectedRevision?: unknown };
  try {
    body = await request.clone().json() as { path?: unknown; expectedRevision?: unknown };
  } catch {
    return undefined;
  }
  if (typeof body.path !== 'string' || typeof body.expectedRevision !== 'string') return undefined;
  const currentRevision = await fileRevision(body.path);
  if (currentRevision === null || currentRevision !== body.expectedRevision) {
    return new Response(JSON.stringify({ currentRevision }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    });
  }
  return undefined;
}

/**
 * Standalone has no studio event producer, but the shared interface still
 * opens the event stream for optional live chrome (confirmations and plugin
 * reloads). Returning the normal unavailable JSON envelope here makes the
 * browser's EventSource reject the response and report a console error. Keep
 * the transport contract valid instead: an empty SSE stream is harmless and
 * leaves the optional live features inactive until a standalone producer
 * exists.
 */
function emptyEventStream(): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': standalone event stream has no producers\n\n'));
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);

    // AC-09: zero-dependency endpoints (before PREFIXES matching, before hemostasis fallback).
    if (url.pathname === '/api/version') {
      return new Response(JSON.stringify({ version: editorVersion }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({ ok: true, uptime: process.uptime(), port }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname === '/api/events/stream') {
      return emptyEventStream();
    }

    for (const { prefix, router, isFiles } of PREFIXES) {
      if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
        // Re-root `<prefix>/...` -> `/...` for the router's own route table.
        url.pathname = url.pathname.slice(prefix.length) || '/';
        // Accept the catalog's project-space source coordinate in the
        // standalone one-game boundary. Both file reads/writes (`path`) and
        // tree refreshes (`root`) use the same client path contract.
        for (const key of ['path', 'root'] as const) {
          const value = url.searchParams.get(key);
          if (value) url.searchParams.set(key, singleGameClientPath(value));
        }
        if (isFiles) {
          const clientPath = url.searchParams.get('path') ?? '';
          const cas = await casResponse(req, url.pathname);
          if (cas !== undefined) return cas;
          let writePath: string | undefined;
          if (req.method === 'POST' && url.pathname === '/') {
            try {
              const body = await req.clone().json() as { path?: unknown };
              if (typeof body.path === 'string') writePath = body.path;
            } catch {
              writePath = undefined;
            }
          }
          const response = await filesRouter.fetch(new Request(url.href, req));
          if (url.pathname === '/raw' && req.method === 'GET' && url.searchParams.get('revision') === '1') {
            const revision = await fileRevision(clientPath);
            if (revision !== null) {
              const headers = new Headers(response.headers);
              headers.set('etag', revision);
              return new Response(response.body, { status: response.status, headers });
            }
          }
          if (req.method === 'POST' && url.pathname === '/' && response.ok) {
            const revision = writePath === undefined ? null : await fileRevision(writePath);
            if (revision !== null) {
              const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
              return new Response(JSON.stringify({ ...payload, revision }), {
                status: response.status,
                headers: { 'content-type': 'application/json' },
              });
            }
          }
          return response;
        }
        return router.fetch(new Request(url.href, req));
      }
    }

    // D-4 hemostasis: unmounted endpoints return HTTP 200 + unavailable envelope
    // (any HTTP method, boundary #8). A non-2xx status would still flood the browser
    // console with errors -- only 200 silences the noise.
    // AC-08: structured envelope with property-access discrimination (charter P3).
    return new Response(JSON.stringify({
      unavailable: true,
      reason: 'standalone',
      hint: 'studio-only endpoint; standalone mounts /api/files /api/prefs /api/version /api/health /api/events/stream',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  },
});

console.log(
  `[game-backend] reusing @forgeax/platform-io for '${gameDir}' -> http://127.0.0.1:${server.port}` +
    ` (${PREFIXES.map((p) => p.prefix).join(', ')})`,
);
