// repro-default-scene-import-404.mjs — browser regression gate for the
// standalone sample's startup/catalog/render path.
//
// The sample defaultScene is an authored internal `.pack.json` asset. A stale
// local import of the shared Fox asset leaves two `.meta.json` sidecars with
// the same sub-asset GUIDs under the declared `assets` + `@shared/characters`
// roots. The pack scanner correctly marks that catalog as degraded and emits
// `{ schemaVersion, entries, authority, diagnostics }`. The runtime catalog
// parser rejects the marked projection, so loadByGuid(defaultScene) falls
// through to the dev-only POST /__import endpoint. That endpoint only accepts
// GUIDs declared by external `.meta.json` sidecars, so the request returns 404
// even though the default scene is present in the catalog and its DDC pack is
// served successfully.
//
// It boots the exact user command (including --rhi-debug), opens the real host
// in Chromium, and checks the same user-visible path: the Vite graph must not
// reference deleted optimizer chunks, the default scene must not fall through
// to /__import, and the mounted Fox material must retain its texture GUID.
// The last assertion is deliberately made through the live eval channel rather
// than a mock: a nested MaterialTextureValue used to survive as `{ texture: 0
// }`, so the viewport rendered a white Fox while the browser console stayed
// quiet.

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const GAME_DIR = resolve(ROOT, 'games/sample');
// Keep the default user command unchanged, but let local CI callers isolate
// this child from an already-running editor stack. `bun fx start` consumes the
// same port variables, so all services in the probe stay on one private set.
const HOST_PORT = Number(process.env.FORGEAX_REPRO_PORT ?? process.env.FORGEAX_STANDALONE_PORT ?? process.env.FORGEAX_E2E_PORT ?? 15290);
const GAME_API_PORT = Number(process.env.FORGEAX_REPRO_API_PORT ?? process.env.FORGEAX_GAME_API_PORT ?? process.env.FORGEAX_E2E_API_PORT ?? 15281);
const EDIT_RUNTIME_PORT = Number(process.env.FORGEAX_REPRO_EDIT_PORT ?? process.env.FORGEAX_EDIT_RUNTIME_PORT ?? 15280);
const PLAY_RUNTIME_PORT = Number(process.env.FORGEAX_REPRO_PLAY_PORT ?? process.env.FORGEAX_PLAY_RUNTIME_PORT ?? 15273);
const RHI_REVIEWER_PORT = Number(process.env.FORGEAX_REPRO_RHI_PORT ?? process.env.FORGEAX_RHI_REVIEWER_PORT ?? 15274);
const BRIDGE_PORT = Number(process.env.FORGEAX_REPRO_BRIDGE_PORT ?? process.env.FORGEAX_BRIDGE_PORT ?? 15296);
const HOST = `http://127.0.0.1:${HOST_PORT}`;
const DEFAULT_SCENE = '2b7c9a10-4d5e-5f60-8a1b-2c3d4e5f6071';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHost(getLog) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      // Do not mistake a stale listener for the host started by this exact
      // command: fx stops managed ports asynchronously before rebinding them.
      // A TCP connection is enough for readiness here. The browser navigation
      // below owns the user-visible HTTP response and app assertions; probing
      // Vite's HTTP endpoints is flaky on the self-hosted runner while its
      // server is still warming the dependency graph.
      const log = getLog().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      await new Promise((resolveConnection, rejectConnection) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: HOST_PORT });
        const timeout = setTimeout(() => {
          socket.destroy();
          rejectConnection(new Error('host port probe timed out'));
        }, 2_000);
        socket.once('connect', () => {
          clearTimeout(timeout);
          socket.destroy();
          resolveConnection();
        });
        socket.once('error', (error) => {
          clearTimeout(timeout);
          socket.destroy();
          rejectConnection(error);
        });
      });
      if (log.includes(String(HOST_PORT))) return;
    } catch {
      // The fx child is still booting.
    }
    await sleep(250);
  }
  throw new Error(`standalone host did not become ready\n${getLog().slice(-3000)}`);
}

async function main() {
  const child = spawn(
    'bun',
    ['fx', 'start', `--game=${GAME_DIR}`, '--rhi-debug'],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        FORGEAX_STANDALONE_PORT: String(HOST_PORT),
        FORGEAX_EDIT_RUNTIME_PORT: String(EDIT_RUNTIME_PORT),
        FORGEAX_GAME_API_PORT: String(GAME_API_PORT),
        FORGEAX_PLAY_RUNTIME_PORT: String(PLAY_RUNTIME_PORT),
        FORGEAX_RHI_REVIEWER_PORT: String(RHI_REVIEWER_PORT),
        FORGEAX_BRIDGE_PORT: String(BRIDGE_PORT),
      },
    },
  );
  let log = '';
  child.stdout.on('data', (data) => { log += String(data); });
  child.stderr.on('data', (data) => { log += String(data); });

  const stop = async () => {
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      sleep(5_000),
    ]);
    // fx owns the precise port cleanup; this is only a backstop if the parent
    // died before its SIGTERM handler ran.
      spawnSync('bun', ['fx', 'stop'], {
        cwd: ROOT,
        stdio: 'ignore',
        env: {
          ...process.env,
          FORGEAX_STANDALONE_PORT: String(HOST_PORT),
          FORGEAX_EDIT_RUNTIME_PORT: String(EDIT_RUNTIME_PORT),
          FORGEAX_GAME_API_PORT: String(GAME_API_PORT),
          FORGEAX_PLAY_RUNTIME_PORT: String(PLAY_RUNTIME_PORT),
          FORGEAX_RHI_REVIEWER_PORT: String(RHI_REVIEWER_PORT),
          FORGEAX_BRIDGE_PORT: String(BRIDGE_PORT),
        },
      });
  };

  try {
    await waitForHost(() => log);

    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--enable-unsafe-webgpu',
        '--enable-webgpu-developer-features',
        '--use-gl=angle',
        '--use-angle=swiftshader',
      ],
    });
    const page = await browser.newPage();
    const events = [];
    const importResponses = [];
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));

    page.on('request', (request) => {
      const url = request.url();
      if (url.endsWith('/pack-index.json') || url.includes(`/__import/${DEFAULT_SCENE}`)) {
        events.push(`request ${request.method()} ${url}`);
      }
    });
    page.on('response', async (response) => {
      const request = response.request();
      const url = response.url();
      if (url.endsWith('/pack-index.json') || url.includes(`/__import/${DEFAULT_SCENE}`)) {
        events.push(`response ${response.status()} ${request.method()} ${url}`);
      }
      if (url.endsWith('/pack-index.json')) {
        try {
          const body = await response.json();
          const entries = body?.entries ?? body;
          if (!Array.isArray(entries) || !entries.some(
            (entry) => entry?.guid?.toLowerCase() === DEFAULT_SCENE,
          )) {
            events.push(`catalog-missing-default-scene ${url}`);
          }
        } catch {
          // The assertion below reports a malformed/missing catalog.
        }
      }
      if (url.includes(`/__import/${DEFAULT_SCENE}`)) {
        importResponses.push(`${request.method()} ${response.status()} ${url}`);
      }
    });

    await page.goto(`${HOST}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('.fx-dockwrap').waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForFunction(async (guid) => {
      const response = await fetch('/pack-index.json');
      if (!response.ok) return false;
      const body = await response.json();
      const entries = body?.entries ?? body;
      return Array.isArray(entries) && entries.some((entry) => entry?.guid?.toLowerCase() === guid);
    }, DEFAULT_SCENE, { timeout: 30_000 });
    // Vite's cold graph + the host integrity scan can delay the first scene
    // load well beyond the catalog response, especially on CI runners.
    await page.waitForTimeout(30_000);

    const runtime = await page.evaluate(() => {
      const channel = globalThis.__forgeaxEval;
      if (!channel || typeof channel.eval !== 'function') {
        return { ok: false, error: 'standalone eval channel unavailable' };
      }
      const result = channel.eval(`JSON.stringify((() => {
        const meshes = query({ with: ['MeshRenderer'] });
        if (!meshes.ok) return { ok: false, error: meshes.error };
        const roots = query({ with: ['Name', 'Transform'] });
        if (!roots.ok) return { ok: false, error: roots.error };
        // J0 deliberately renames the authored root to "Fox J0 Human" through
        // the same Gateway path a user follows. Keep the probe keyed to the
        // stable asset identity prefix, not the pre-J0 display-name snapshot.
        const foxRoot = roots.rows.find((row) => (
          typeof row.Name.value === 'string' && row.Name.value.startsWith('Fox')
        ));
        const fox = meshes.rows.find((row) => row.MeshRenderer.materials.some((handle) => {
          const material = gateway.resolveAsset(handle);
          const texture = material.ok ? material.asset.values?.baseColorTexture : undefined;
          return texture && typeof texture === 'object' && typeof texture.texture === 'string';
        }));
        return {
          ok: true,
          meshRendererCount: meshes.rows.length,
          foxScale: foxRoot?.Transform.scale,
          foxTextured: fox !== undefined,
        };
      })())`);
      return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error };
    });
    await browser.close();

    const badImport = importResponses.filter((request) => request.startsWith('POST 404 '));
    if (badImport.length > 0) {
      throw new Error(
        'reproduced defaultScene -> /__import 404:\n' +
        events.join('\n') + '\n\nfx log:\n' + log.slice(-3000),
      );
    }
    if (/(?:Pre-transform error: )?The file does not exist at .*\.vite\/[^\n]*\/deps\/[^\n]+\.js/.test(log)) {
      throw new Error(
        'reproduced stale Vite optimize-deps chunk:\n' + log.slice(-6000),
      );
    }
    if (pageErrors.length > 0) {
      throw new Error(`standalone page errors:\n${pageErrors.join('\n')}`);
    }
    if (!runtime.ok) {
      throw new Error(`standalone runtime probe failed: ${JSON.stringify(runtime)}`);
    }
    let runtimeValue;
    try { runtimeValue = JSON.parse(runtime.value); } catch (error) {
      throw new Error(`standalone runtime probe returned invalid JSON: ${String(error)}\n${runtime.value}`);
    }
    const foxScale = runtimeValue.foxScale;
    if (
      runtimeValue.meshRendererCount < 4 ||
      runtimeValue.foxTextured !== true ||
      !Array.isArray(foxScale) ||
      foxScale.some((value) => Math.abs(value - 0.01) > 1e-6)
    ) {
      throw new Error(`standalone Fox/material regression: ${JSON.stringify(runtimeValue)}`);
    }
    console.log('defaultScene import fallback: no erroneous POST /__import 404 observed');
    console.log(`standalone scene/material probe: ${JSON.stringify(runtimeValue)}`);
  } finally {
    await stop();
  }
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exitCode = 1;
});
