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
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const gameDir = process.env.FORGEAX_GAME_DIR;
if (!gameDir) {
  console.error('[game-backend] FORGEAX_GAME_DIR is required (the --game dir).');
  process.exit(1);
}

const port = Number(process.env.FORGEAX_GAME_API_PORT ?? 15281);
const instanceRootAbs = resolve(gameDir);
const gameSlug = basename(instanceRootAbs);
const engineTemplatesRoot = resolve(import.meta.dir, '../packages/engine/templates');

const GAME_TEMPLATE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** Read the standalone catalog from the same engine-owned template directory as Studio. */
async function listGameTemplates(): Promise<Array<{ slug: string; name: string }>> {
  const entries = await readdir(engineTemplatesRoot, { withFileTypes: true });
  const templates: Array<{ slug: string; name: string }> = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory()
      || entry.name.startsWith('.')
      || entry.name.startsWith('_')
      || entry.name === 'node_modules'
      || !GAME_TEMPLATE_SLUG_RE.test(entry.name)
    ) continue;
    try {
      const manifest = JSON.parse(await readFile(join(engineTemplatesRoot, entry.name, 'forge.json'), 'utf8')) as { name?: unknown };
      if (typeof manifest.name === 'string' && manifest.name.trim().length > 0) {
        templates.push({ slug: entry.name, name: manifest.name });
      }
    } catch {
      // A template without a valid forge.json is not launchable and is omitted.
    }
  }
  return templates.sort((a, b) => a.slug.localeCompare(b.slug));
}

interface GameManifest {
  id?: unknown;
  name?: unknown;
  [key: string]: unknown;
}

async function readCurrentGameManifest(): Promise<GameManifest | null> {
  try {
    return JSON.parse(await readFile(join(gameDir, 'forge.json'), 'utf8')) as GameManifest;
  } catch {
    return null;
  }
}

async function listStandaloneGames(): Promise<{ games: Array<{ slug: string; name: string; fileCount: number; mtime: number }>; activeSlug: string | null }> {
  const manifest = await readCurrentGameManifest();
  if (manifest === null) return { games: [], activeSlug: null };
  const [entries, manifestStat] = await Promise.all([
    readdir(gameDir, { withFileTypes: true }),
    stat(join(gameDir, 'forge.json')),
  ]);
  return {
    games: [{
      slug: gameSlug,
      name: typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name : gameSlug,
      fileCount: entries.length,
      mtime: manifestStat.mtimeMs,
    }],
    activeSlug: gameSlug,
  };
}

async function createStandaloneGame(input: { slug?: unknown; name?: unknown; brief?: unknown; template?: unknown }): Promise<Response> {
  const slug = typeof input.slug === 'string' ? input.slug.trim() : '';
  if (!GAME_TEMPLATE_SLUG_RE.test(slug)) {
    return new Response(JSON.stringify({ ok: false, error: 'slug must be lowercase ASCII / digits / hyphens' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (slug !== gameSlug) {
    return new Response(JSON.stringify({ ok: false, error: `standalone game slot is '${gameSlug}', received '${slug}'` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (await readCurrentGameManifest() !== null) {
    return new Response(JSON.stringify({ ok: false, error: `game '${slug}' already exists` }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const template = typeof input.template === 'string' && input.template.trim()
    ? input.template.trim()
    : 'game-default';
  if (!GAME_TEMPLATE_SLUG_RE.test(template)) {
    return new Response(JSON.stringify({ ok: false, error: `invalid template '${template}'` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const templateDir = join(engineTemplatesRoot, template);
  let templateManifest: GameManifest;
  try {
    templateManifest = JSON.parse(await readFile(join(templateDir, 'forge.json'), 'utf8')) as GameManifest;
    await stat(join(templateDir, 'main.ts'));
  } catch {
    return new Response(JSON.stringify({ ok: false, error: `template not found: ${template}` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const existingEntries = await readdir(gameDir, { withFileTypes: true }).catch(() => []);
  const isEmptyHostScaffold = existingEntries.length === 2
    && existingEntries.some((entry) => entry.name === 'package.json' && entry.isFile())
    && existingEntries.some((entry) => entry.name === 'assets' && entry.isDirectory())
    && (await readdir(join(gameDir, 'assets')).catch(() => [])).length === 0;
  if (existingEntries.length > 0 && !isEmptyHostScaffold) {
    return new Response(JSON.stringify({ ok: false, error: `game slot '${slug}' is not empty` }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await mkdir(gameDir, { recursive: true });
    await cp(templateDir, gameDir, {
      recursive: true,
      filter: (source) => !['.git', 'node_modules', 'sessions'].includes(basename(source)),
    });
    const manifest = {
      ...templateManifest,
      id: slug,
      name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : slug,
    };
    await writeFile(join(gameDir, 'forge.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const brief = typeof input.brief === 'string' ? input.brief.trim() : '';
    await writeFile(
      join(gameDir, 'FORGE.md'),
      `# ${manifest.name}\n\n${brief ? `${brief}\n` : '_(no brief yet)_\n'}`,
      'utf8',
    );
    return new Response(JSON.stringify({ ok: true, slug, template }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    await rm(gameDir, { recursive: true, force: true });
    await mkdir(gameDir, { recursive: true });
    return new Response(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

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
      // Runtime carriers use this stable absolute root as their managed-instance
      // identity. iframe, page and Tauri WebView hosts all consume the same fact.
      return new Response(JSON.stringify({ ok: true, uptime: process.uptime(), port, instanceRootAbs }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname === '/api/game-templates' && req.method === 'GET') {
      try {
        return new Response(JSON.stringify({ templates: await listGameTemplates() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    if (url.pathname === '/api/games' && req.method === 'GET') {
      try {
        return new Response(JSON.stringify(await listStandaloneGames()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    if (url.pathname === '/api/games' && req.method === 'POST') {
      let body: { slug?: unknown; name?: unknown; brief?: unknown; template?: unknown };
      try {
        body = await req.json() as typeof body;
      } catch {
        return new Response(JSON.stringify({ ok: false, error: 'invalid json' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return createStandaloneGame(body);
    }
    if (url.pathname === '/api/games/active' && req.method === 'GET') {
      return new Response(JSON.stringify({ activeSlug: (await readCurrentGameManifest()) ? gameSlug : null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname === '/api/games/active' && req.method === 'PUT') {
      let body: { slug?: unknown };
      try {
        body = await req.json() as typeof body;
      } catch {
        return new Response(JSON.stringify({ error: 'invalid json' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const activeSlug = typeof body.slug === 'string' ? body.slug : '';
      if (activeSlug !== gameSlug || (await readCurrentGameManifest()) === null) {
        return new Response(JSON.stringify({ error: `game '${activeSlug}' is unavailable` }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ activeSlug }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname === '/api/events/stream') {
      return emptyEventStream();
    }
    if (url.pathname === '/api/validation/project' && req.method === 'POST') {
      let options: { maxBytes?: number; maxEntities?: number } = {};
      try {
        const body = await req.clone().json() as Record<string, unknown>;
        options = {
          ...(typeof body.maxBytes === 'number' ? { maxBytes: body.maxBytes } : {}),
          ...(typeof body.maxEntities === 'number' ? { maxEntities: body.maxEntities } : {}),
        };
      } catch {
        return new Response(JSON.stringify({
          ok: false,
          error: { code: 'INVALID_ARGS', hint: 'project validation options must be a JSON object' },
        }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      try {
        // The existing validator is the producer-owned J5 fact source. Keep it
        // in the Bun host because it reads the confined game filesystem.
        const { validateGameProject } = await import('../scripts/game-validation.mjs');
        const result = validateGameProject(gameDir, options);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (error) {
        return new Response(JSON.stringify({
          ok: false,
          error: {
            code: 'project-validation-unavailable',
            hint: error instanceof Error ? error.message : String(error),
            retryable: true,
            recoveryActions: ['run.retry', 'editor.discover'],
          },
        }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
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
      hint: 'standalone mounts /api/files /api/prefs /api/version /api/health /api/game-templates /api/games /api/events/stream',
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
