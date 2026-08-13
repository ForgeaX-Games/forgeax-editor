// Strict browser smoke configuration for the standalone editor.
//
// The smoke deliberately runs one game per Playwright process. The game is
// copied into an isolated host-owned directory so the standalone editor and
// the independent Preview server consume the exact same fixture without
// sharing a stale Vite graph between games.
//
// The browser mode mirrors forgeax-engine PR #1696: CI runs headed Chromium
// under Xvfb so software WebGPU does not take the headless GPU teardown path.

import { defineConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const root = resolve(process.cwd());
const createGameMode = process.env.FORGEAX_SMOKE_CREATE_GAME === '1';
const requestedGame = process.env.FORGEAX_SMOKE_GAME ?? (createGameMode ? 'game-default' : 'sample');
const gameSources: Record<string, string> = {
  'game-default': resolve(root, 'packages/engine/templates/game-default'),
  'gameplay-gate': resolve(root, 'e2e/fixtures/gameplay-gate'),
  sample: resolve(root, 'games/sample'),
};
// Playwright reloads the config in worker processes. In create mode the
// parent config publishes the empty target through FORGEAX_SMOKE_GAME_DIR for
// the web servers, so that variable must not be mistaken for the template
// source when a worker validates the config again.
const sourceOverride = !createGameMode && process.env.FORGEAX_SMOKE_GAME_DIR;
const sourceDir = sourceOverride
  ? resolve(sourceOverride)
  : gameSources[requestedGame];

if (sourceDir === undefined || !existsSync(resolve(sourceDir, 'forge.json'))) {
  throw new Error(
    `Unknown or invalid smoke game "${requestedGame}"; expected one of ${Object.keys(gameSources).join(', ')}`,
  );
}

const gameId = process.env.FORGEAX_SMOKE_GAME_ID ?? basename(sourceDir);
const inheritedCreateGameDir = createGameMode && process.env.FORGEAX_SMOKE_GAME_DIR
  ? resolve(process.env.FORGEAX_SMOKE_GAME_DIR)
  : undefined;
const tempRoot = inheritedCreateGameDir === undefined
  ? mkdtempSync(join(process.env.TMPDIR ?? '/tmp', `forgeax-editor-smoke-${gameId}-`))
  : dirname(inheritedCreateGameDir);
const gameDir = inheritedCreateGameDir ?? join(tempRoot, gameId);
if (createGameMode && inheritedCreateGameDir === undefined) {
  // Create mode starts with an empty slot. The browser smoke then submits
  // File → New Game with template=game-default; apps/standalone/game-backend.ts
  // copies the selected engine template into this slot before the host reloads.
  // Keep the asset root and package metadata present-but-empty so the running
  // Vite pack watcher is attached before New Game materializes the files.
  mkdirSync(gameDir, { recursive: true });
  mkdirSync(join(gameDir, 'assets'), { recursive: true });
  cpSync(resolve(sourceDir, 'package.json'), join(gameDir, 'package.json'));
} else if (!createGameMode) {
  cpSync(sourceDir, gameDir, { recursive: true });
}

process.env.FORGEAX_SMOKE_GAME_DIR = gameDir;
if (inheritedCreateGameDir === undefined) {
  process.once('exit', () => rmSync(tempRoot, { recursive: true, force: true }));
}

const defaultPorts = gameId === 'game-default'
  ? { host: '15590', edit: '15580', api: '15581', engine: '15573' }
  : gameId === 'gameplay-gate'
  ? { host: '15790', edit: '15780', api: '15781', engine: '15773' }
  : { host: '15690', edit: '15680', api: '15681', engine: '15673' };
const hostPort = process.env.FORGEAX_SMOKE_HOST_PORT ?? defaultPorts.host;
const editPort = process.env.FORGEAX_SMOKE_EDIT_PORT ?? defaultPorts.edit;
const apiPort = process.env.FORGEAX_SMOKE_API_PORT ?? defaultPorts.api;
const enginePort = process.env.FORGEAX_SMOKE_ENGINE_PORT ?? defaultPorts.engine;
const runtimeScopeSecret = process.env.FORGEAX_RUNTIME_SCOPE_SECRET ?? randomUUID();
const runtimeScopeId = process.env.FORGEAX_RUNTIME_SCOPE_ID ?? `standalone-${gameId}`;
const runtimeGeneration = process.env.FORGEAX_RUNTIME_GENERATION ?? '1';
process.env.FORGEAX_SMOKE_GAME_ID = gameId;
process.env.FORGEAX_SMOKE_HOST_PORT = hostPort;
process.env.FORGEAX_SMOKE_EDIT_PORT = editPort;
process.env.FORGEAX_SMOKE_API_PORT = apiPort;
process.env.FORGEAX_SMOKE_ENGINE_PORT = enginePort;
process.env.FORGEAX_RUNTIME_SCOPE_SECRET = runtimeScopeSecret;
process.env.FORGEAX_RUNTIME_SCOPE_ID = runtimeScopeId;
process.env.FORGEAX_RUNTIME_GENERATION = runtimeGeneration;

const hostEnv = {
  ...process.env as Record<string, string>,
  FORGEAX_GAME_DIR: gameDir,
  FORGEAX_ENGINE_PORT: enginePort,
  FORGEAX_INTERFACE_PORT: hostPort,
  FORGEAX_STANDALONE_PORT: hostPort,
  FORGEAX_EDIT_RUNTIME_PORT: editPort,
  FORGEAX_GAME_API_PORT: apiPort,
  FORGEAX_GAME_ID: gameId,
  FORGEAX_RUNTIME_SCOPE_SECRET: runtimeScopeSecret,
  FORGEAX_RUNTIME_SCOPE_ID: runtimeScopeId,
  FORGEAX_RUNTIME_GENERATION: runtimeGeneration,
  FORGEAX_GAMES_URL_PREFIX: 'host-games',
  FORGEAX_HMR_CLIENT_PORT: hostPort,
  FORGEAX_BRIDGE: '0',
};

export default defineConfig({
  testDir: resolve(root, 'apps/standalone/e2e'),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${hostPort}`,
    headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
    trace: 'off',
  },
  webServer: [
    {
      command: 'bun run dev',
      cwd: root,
      env: hostEnv,
      url: `http://127.0.0.1:${hostPort}`,
      reuseExistingServer: false,
      timeout: 90_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'bun run dev:edit-runtime',
      cwd: root,
      env: {
        ...process.env as Record<string, string>,
        FORGEAX_GAME_DIR: gameDir,
        FORGEAX_EDITOR_PORT: editPort,
        FORGEAX_INTERFACE_PORT: hostPort,
        FORGEAX_HMR_CLIENT_PORT: hostPort,
        FORGEAX_GAME_API_PORT: apiPort,
        FORGEAX_SERVER_PORT: apiPort,
        FORGEAX_RUNTIME_SCOPE_SECRET: runtimeScopeSecret,
        FORGEAX_RUNTIME_SCOPE_ID: runtimeScopeId,
        FORGEAX_RUNTIME_GENERATION: runtimeGeneration,
      },
      url: `http://127.0.0.1:${editPort}/editor/`,
      reuseExistingServer: false,
      timeout: 90_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `bun x vite --port ${enginePort} --strictPort`,
      cwd: resolve(root, 'packages/play-runtime'),
      env: {
        ...process.env,
        FORGEAX_GAME_DIR: gameDir,
        FORGEAX_GAME_ID: gameId,
        FORGEAX_ENGINE_PORT: enginePort,
        FORGEAX_RUNTIME_SCOPE_SECRET: runtimeScopeSecret,
        FORGEAX_RUNTIME_SCOPE_ID: runtimeScopeId,
        FORGEAX_RUNTIME_GENERATION: runtimeGeneration,
        FORGEAX_GAMES_URL_PREFIX: 'smoke-games',
        FORGEAX_HMR_CLIENT_PORT: hostPort,
        FORGEAX_GAME_API_PORT: apiPort,
      },
      url: `http://127.0.0.1:${enginePort}/preview/`,
      reuseExistingServer: false,
      timeout: 90_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'bun apps/standalone/game-backend.ts',
      cwd: root,
      env: {
        ...process.env,
        FORGEAX_GAME_DIR: gameDir,
        FORGEAX_GAME_API_PORT: apiPort,
      },
      url: `http://127.0.0.1:${apiPort}/api/health`,
      reuseExistingServer: false,
      timeout: 90_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
  projects: [
    {
      name: `editor-smoke-${gameId}`,
      use: {
        browserName: 'chromium',
        ...(process.env.FORGEAX_SMOKE_BROWSER_CHANNEL
          ? { channel: process.env.FORGEAX_SMOKE_BROWSER_CHANNEL }
          : {}),
        launchOptions: {
          args: [
            '--enable-unsafe-webgpu',
            '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
            '--use-vulkan=swiftshader',
            '--disable-vulkan-surface',
            '--ignore-gpu-blocklist',
            '--disable-gpu-driver-bug-workarounds',
            '--disable-dawn-features=disallow_unsafe_apis',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
  ],
});
