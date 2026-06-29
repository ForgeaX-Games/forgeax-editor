// game-backend.ts — the standalone editor's REUSED platform-io backend (R3).
//
// WHY A SEPARATE BUN PROCESS (ideal-clean-architecture.md §5 "复用,不另写后端"):
//   editor-core reaches its backend via the injected ApiClient (R2). Standalone
//   has no studio server, so this process IS the backend — and it must be the
//   REAL @forgeax/platform-io 后L1 router, not a hand-written second backend.
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
// Run (cli.mjs wires this): FORGEAX_GAME_DIR=<dir> bun standalone/game-backend.ts
//   env FORGEAX_GAME_API_PORT overrides the port (default 15281).

import { createFilesRouter, singleGameFileBackend } from '@forgeax/platform-io';

const gameDir = process.env.FORGEAX_GAME_DIR;
if (!gameDir) {
  console.error('[game-backend] FORGEAX_GAME_DIR is required (the --game dir).');
  process.exit(1);
}

const port = Number(process.env.FORGEAX_GAME_API_PORT ?? 15281);
const FILES_PREFIX = '/api/files';
const router = createFilesRouter(singleGameFileBackend(gameDir));

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== FILES_PREFIX && !url.pathname.startsWith(`${FILES_PREFIX}/`)) {
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Re-root `/api/files…` → `/…` for the router's own route table.
    url.pathname = url.pathname.slice(FILES_PREFIX.length) || '/';
    return router.fetch(new Request(url.href, req));
  },
});

console.log(`[game-backend] reusing @forgeax/platform-io for '${gameDir}' → http://127.0.0.1:${server.port}${FILES_PREFIX}`);
