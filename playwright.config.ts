// Playwright config for @forgeax/editor — single-realm e2e gate.
//
// The :15290 host boots the engine in-process (runtime-vite-preset serves the
// shader manifest + pack catalog locally) and renders the viewport + panels as
// in-process components — no /editor iframe is needed. Servers used here:
//   - :15290 — the standalone host (`bun run dev`, cwd '.'). The single
//              document under test; boots the engine in-process.
//   - :15173 — play-runtime preview. Kept for e2e that open
//              `/preview/?game=<slug>` (fullscreen play path).
//
// Anchors:
//   requirements AC-04/AC-05 (single realm — no panel iframe, in-host canvas)
//   requirements AC-09 (hideChatAndForge=true hides chat-panel + forge-entry)
//   requirements AC-14 (bun -F editor test:e2e exit 0)
//   research F-4 (webServer array + 10s expect.poll fallback)

import { defineConfig } from '@playwright/test';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The fixed defaults preserve the normal developer entry points. CI/fix-up
// evidence may supply private ports so a fresh current-HEAD server never
// reuses or terminates an unrelated root/studio service.
const e2eHostPort = process.env.FORGEAX_E2E_PORT ?? '15290';
const e2eApiPort = process.env.FORGEAX_E2E_API_PORT ?? '15281';
const e2eEnginePort = process.env.FORGEAX_E2E_ENGINE_PORT ?? '15173';
// Save E2E must exercise real file IO without rewriting the tracked sample.
// The copy is exact, isolated to this Playwright process, and removed only at
// process exit; the browser still addresses it as the game slug "sample".
const e2eTempRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'forgeax-save-e2e-'));
const e2eGameDir = join(e2eTempRoot, 'sample');
cpSync(resolve('games/sample'), e2eGameDir, { recursive: true });
process.once('exit', () => rmSync(e2eTempRoot, { recursive: true, force: true }));

export default defineConfig({
  testDir: './e2e',
  // Single chromium project — headless CI default. fullyParallel off
  // because the two webServers share singleton ports; tests within the
  // file are sequential by design (idempotent-mount AC-09 reads global
  // iframe state).
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  timeout: 120_000,
  expect: {
    // Ten-second poll budget covers cold-start dev server + first VAG_*
    // emission (plan-strategy 4 R-AC-08 fallback). expect.poll uses
    // this when caller omits an explicit `timeout` option.
    timeout: 10_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${e2eHostPort}`,
    headless: true,
    trace: 'off',
  },
  webServer: [
    {
      // editor standalone chrome host on :15290 — renders <DockShell
      // hideChatAndForge /> and boots the engine IN-PROCESS on module load
      // (single realm). Started via `bun run dev` so the root vite.config.ts
      // (root=standalone/, port=15290, runtime-vite-preset serve) applies.
      // This is the ONLY document the e2e specs load.
      //
      // Injects FORGEAX_GAME_DIR=games/sample so the standalone host boots with
      // a real game loaded — the GAME_DIR env activates vite's /api -> :15281
      // proxy and define __FORGEAX_GAME_SLUG__.
      // FORGEAX_INTERFACE_PORT=15290 prevents edit-runtime HMR from hammering the
      // non-existent studio port :18920 (AGENTS.md port map).
      command: 'bun run dev',
      cwd: '.',
      env: {
        ...process.env as Record<string, string>,
        FORGEAX_GAME_DIR: e2eGameDir,
        FORGEAX_INTERFACE_PORT: e2eHostPort,
        FORGEAX_STANDALONE_PORT: e2eHostPort,
        FORGEAX_GAME_API_PORT: e2eApiPort,
      },
      url: `http://127.0.0.1:${e2eHostPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // engine vite dev server on :15173 — serves play-runtime preview at
      // /preview/?game=<slug> (fullscreen play path). OOS-4: play-runtime is
      // untouched by M2. Port 15173 is the play-runtime vite.config.ts default.
      command: `bunx vite --port ${e2eEnginePort} --strictPort`,
      cwd: './packages/play-runtime',
      env: { ...process.env, FORGEAX_ENGINE_PORT: e2eEnginePort },
      url: `http://127.0.0.1:${e2eEnginePort}/preview/`,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
    {
      // M5 (plan-strategy D-2): standalone game-backend bun process on :15281.
      // Mounts the real @forgeax/platform-io createFilesRouter + createPrefsRouter
      // confined to games/sample, plus /api/version + /api/health endpoints (M3).
      // webServer #1 proxies /api -> here when FORGEAX_GAME_DIR is set.
      // Readiness probe = /api/health (AC-09 endpoint, doubles as playwright
      // health check — this is why M3 precedes M5 in the milestone graph).
      command: 'bun standalone/game-backend.ts',
      cwd: '.',
      env: { ...process.env, FORGEAX_GAME_DIR: e2eGameDir, FORGEAX_GAME_API_PORT: e2eApiPort },
      url: `http://127.0.0.1:${e2eApiPort}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: {
          args: [
            '--enable-unsafe-webgpu',
            '--enable-webgpu-developer-features',
            '--use-gl=angle',
            '--use-angle=swiftshader',
          ],
        },
      },
    },
  ],
});
