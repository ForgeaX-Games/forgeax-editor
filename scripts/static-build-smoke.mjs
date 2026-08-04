// static-build-smoke.mjs — J5 gate for a built game artifact.
//
// This owns the no-dev-server boundary: a plain node:http server mounts the
// artifact at the same /preview/ base used by play-runtime, then a real
// Chromium page boots the selected game. It deliberately does not start Vite,
// the editor host, a game backend, or a Gateway bridge.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const dist = resolve(process.argv[2] ?? '');
const gameId = process.argv[3] ?? '';
const gamesPrefix = process.argv[4] ?? 'host-games';
if (!dist || !gameId) {
  console.error('usage: bun scripts/static-build-smoke.mjs <dist> <game-id> [games-prefix]');
  process.exit(2);
}

const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.wgsl': 'text/plain',
  '.glsl': 'text/plain',
  '.bin': 'application/octet-stream',
  '.css': 'text/css',
};

const server = createServer(async (req, res) => {
  try {
    const requestPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    if (requestPath === '/favicon.ico') {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (!requestPath.startsWith('/preview')) {
      res.statusCode = 404;
      res.end('not mounted');
      return;
    }
    let rel = requestPath.slice('/preview'.length).replace(/^\/+/, '');
    if (rel.length === 0) rel = 'index.html';
    const file = join(dist, rel);
    if (!file.startsWith(`${dist}/`)) {
      res.statusCode = 400;
      res.end('bad path');
      return;
    }
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
    res.end(await readFile(file));
  } catch (error) {
    res.statusCode = 500;
    res.end(error instanceof Error ? error.message : String(error));
  }
});

await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('static server did not bind');
const baseUrl = `http://127.0.0.1:${address.port}/preview/`;

const probes = [
  `${baseUrl}`,
  `${baseUrl}pack-index.json`,
  `${baseUrl}${gamesPrefix}/${gameId}/forge.json`,
  `${baseUrl}${gamesPrefix}/${gameId}/assets/scene.pack.json`,
];
const statuses = [];
for (const url of probes) {
  const response = await fetch(url);
  statuses.push({ url, status: response.status });
}
if (statuses.some((row) => row.status !== 200)) {
  console.error(JSON.stringify({ phase: 'static-probe', statuses }, null, 2));
  server.close();
  process.exit(1);
}

const browserChannel = process.env.FORGEAX_E2E_BROWSER_CHANNEL;
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu'],
  ...(browserChannel ? { channel: browserChannel } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const failures = [];
const requests = [];
page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') {
    const location = message.location();
    failures.push(`console: ${message.text()}${location.url ? ` (${location.url})` : ''}`);
  }
});
page.on('request', (request) => requests.push(request.url()));
await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
const state = await page.evaluate(() => ({
  canvas: document.querySelectorAll('canvas').length,
  app: Boolean((window).__forgeax),
  entities: (window).__forgeax?.world?.inspect?.().entityCount ?? 0,
}));
const apiRequests = requests.filter((url) => new URL(url).pathname.startsWith('/api/'));
const result = { phase: 'browser-smoke', baseUrl, statuses, state, apiRequests, failures };
console.log(JSON.stringify(result, null, 2));
await page.screenshot({ path: join(dist, 'j5-smoke.png') });
await browser.close();
server.close();
if (state.canvas < 1 || !state.app || state.entities < 2 || apiRequests.length > 0 || failures.length > 0) process.exit(1);
