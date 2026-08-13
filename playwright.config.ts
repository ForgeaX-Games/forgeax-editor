// Playwright config for @forgeax/editor — isolated viewport Runtime gate.
//
// The :15290 host owns chrome and in-process panels. The :15280 Edit Runtime is
// served through the same-origin /editor proxy and owns Gateway, Edit World,
// AssetRegistry and canvas. Servers used here:
//   - :15290 — standalone shell host (`bun run dev:standalone`, cwd '.')
//   - :15280 — replaceable Edit Runtime (`bun run dev:edit-runtime`)
//   - :15173 — play-runtime preview. Kept for e2e that open
//              `/preview/?game=<slug>` (fullscreen play path).
//
// Anchors:
//   viewport Runtime architecture (one carrier iframe, no panel iframes)
//   requirements AC-09 (hideChatAndForge=true hides chat-panel + forge-entry)
//   requirements AC-14 (bun -F editor test:e2e exit 0)
//   research F-4 (webServer array + 10s expect.poll fallback)

import { defineConfig } from '@playwright/test';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

// The fixed defaults preserve the normal developer entry points. CI/fix-up
// evidence may supply private ports so a fresh current-HEAD server never
// reuses or terminates an unrelated root/studio service.
const e2eHostPort = process.env.FORGEAX_E2E_PORT ?? '15290';
const e2eEditPort = process.env.FORGEAX_E2E_EDIT_PORT ?? '15280';
const e2eApiPort = process.env.FORGEAX_E2E_API_PORT ?? '15281';
const e2eEnginePort = process.env.FORGEAX_E2E_ENGINE_PORT ?? '15173';
const e2eTemplateHostPort = process.env.FORGEAX_E2E_TEMPLATE_PORT ?? '15490';
const e2eTemplateEditPort = process.env.FORGEAX_E2E_TEMPLATE_EDIT_PORT ?? '15480';
const e2eTemplateApiPort = process.env.FORGEAX_E2E_TEMPLATE_API_PORT ?? '15481';
const e2eTemplateEnginePort = process.env.FORGEAX_E2E_TEMPLATE_ENGINE_PORT ?? '15473';
function deriveBridgePort(hostPort: string, fallback: string): string {
  const numeric = Number(hostPort);
  return Number.isInteger(numeric) ? String(numeric + 6) : fallback;
}
const e2eBridgePort = process.env.FORGEAX_E2E_BRIDGE_PORT
  ?? deriveBridgePort(e2eHostPort, '15296');
const e2eTemplateBridgePort = process.env.FORGEAX_E2E_TEMPLATE_BRIDGE_PORT
  ?? deriveBridgePort(e2eTemplateHostPort, '15496');
const e2eBrowserChannel = process.env.FORGEAX_E2E_BROWSER_CHANNEL;
const e2eRuntimeScopeId = process.env.FORGEAX_RUNTIME_SCOPE_ID ?? 'standalone-sample';
const e2eRuntimeGeneration = process.env.FORGEAX_RUNTIME_GENERATION ?? '1';
// Save E2E must exercise real file IO without rewriting the tracked sample.
// The copy is exact, isolated to this Playwright process, and removed only at
// process exit; the browser still addresses it as the game slug "sample".
const e2eTempRoot = mkdtempSync(join(tmpdir(), 'forgeax-save-e2e-'));
// Each webServer below is a real, concurrent Vite process. Vite's default
// cache directories live beside the shared package sources, so the sample and
// template stacks can otherwise race while writing the same optimized React /
// Zod modules and serve a transient 504 (Outdated Optimize Dep). Give each
// stack one private root; the three configs split that root by Vite role.
const e2eSampleViteCacheRoot = join(e2eTempRoot, 'vite-cache', 'sample');
const e2eTemplateViteCacheRoot = join(e2eTempRoot, 'vite-cache', 'template');
const e2eGameDir = join(e2eTempRoot, 'sample');
cpSync(resolve('games/sample'), e2eGameDir, {
  recursive: true,
  // Keep diagnostics accidentally left in the tracked sample checkout from
  // poisoning the isolated catalog. Tests create their own uniquely named
  // fixtures in the temp game and must start from a schema-valid baseline.
  filter: (source) => {
    const name = basename(source);
    return !name.startsWith('diag') && !name.startsWith('_diag');
  },
});
// New-game template journey (docs/2026-08-06-new-game-template-journey-e2e-plan
// D-1): a FRESH copy of the engine's canonical template, initialized into the
// same isolated temp root — the editor-side equivalent of "user clicks New
// Game" in studio. Copied at config time because webServers capture the game
// dir at boot. node_modules is excluded: the host aliases every
// @forgeax/engine-* import to this workspace (vite.config.ts
// engineWorktreeResolve), so the copied tree needs no bundled deps.
const e2eTemplateGameDir = join(e2eTempRoot, 'new-game-template');
cpSync(resolve('packages/engine/templates/game-default'), e2eTemplateGameDir, {
  recursive: true,
  filter: (src) => basename(src) !== 'node_modules',
});
// Stage the real producer input before any fresh backend/catalog process starts.
// J1's disposable source fixture must exist before all three webServers start:
// the browser/backend import path reads the isolated game directory that is
// captured at server boot. Keep the binary in the temp copy only, so the
// product tree remains binary-free while J1 exercises the real on-disk import
// contract.
cpSync(resolve('forgeax-editor-assets/characters/Fox.glb'), join(e2eGameDir, 'assets/Fox.glb'));
process.env.FORGEAX_E2E_GAME_DIR = e2eGameDir;
process.once('exit', () => rmSync(e2eTempRoot, { recursive: true, force: true }));

export default defineConfig({
  testDir: './apps/standalone/e2e',
  // Keep Bun evidence/unit files in this folder out of Playwright's Node ESM
  // loader. Browser journeys are the explicit *.spec.ts surface.
  testMatch: '**/*.spec.ts',
  // Single chromium project — local runs default to headless, while the CI
  // smoke job selects headed Chromium under Xvfb. fullyParallel stays off
  // because the webServers share singleton ports; tests within the file are
  // sequential by design (idempotent-mount AC-09 reads global iframe state).
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
    // Stuck clicks (overlay / re-render) must fail fast — do not burn the full
    // 120s test timeout retrying actionability (see H-02~H-05, P-02/P-05/P-14).
    actionTimeout: 15_000,
    baseURL: `http://127.0.0.1:${e2eHostPort}`,
    headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
    trace: 'off',
  },
  webServer: [
    {
      // Editor shell host on :15290 — renders <DockShell hideChatAndForge /> and
      // starts the same host + Edit Runtime + Gateway bridge as standalone.
      //
      // Injects FORGEAX_GAME_DIR so shell metadata and the /api proxy use the
      // same game identity as the authoritative Runtime.
      // FORGEAX_INTERFACE_PORT=15290 prevents edit-runtime HMR from hammering the
      // non-existent studio port :18920 (AGENTS.md port map).
      command: 'bun run dev:standalone',
      cwd: '.',
      env: {
        ...process.env as Record<string, string>,
        FORGEAX_GAME_DIR: e2eGameDir,
        FORGEAX_ENGINE_PORT: e2eEnginePort,
        FORGEAX_PLAY_RUNTIME_PORT: e2eEnginePort,
        FORGEAX_STANDALONE_PORT: e2eHostPort,
        FORGEAX_EDIT_RUNTIME_PORT: e2eEditPort,
        FORGEAX_GAME_API_PORT: e2eApiPort,
        FORGEAX_VITE_CACHE_ROOT: e2eSampleViteCacheRoot,
        FORGEAX_BRIDGE_PORT: e2eBridgePort,
        FORGEAX_RUNTIME_SCOPE_ID: e2eRuntimeScopeId,
        FORGEAX_RUNTIME_GENERATION: e2eRuntimeGeneration,
        FORGEAX_HMR_CLIENT_PORT: e2eHostPort,
      },
      url: `http://127.0.0.1:${e2eHostPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
      // Let dev-standalone run its own process-group cleanup before Playwright
      // falls back to SIGKILL. Its child Vite/bridge processes are detached.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Play Runtime uses the same package command as standalone `fx start`.
      command: 'bun -F @forgeax/editor-play-runtime dev',
      cwd: '.',
      env: {
        ...process.env,
        FORGEAX_ENGINE_PORT: e2eEnginePort,
        FORGEAX_PLAY_RUNTIME_PORT: e2eEnginePort,
        FORGEAX_GAME_DIR: e2eGameDir,
        FORGEAX_VITE_CACHE_ROOT: e2eSampleViteCacheRoot,
        FORGEAX_GAME_ID: 'sample',
        FORGEAX_RUNTIME_SCOPE_ID: 'e2e-sample',
        FORGEAX_RUNTIME_GENERATION: '1',
        FORGEAX_GAMES_URL_PREFIX: 'host-games',
        FORGEAX_HMR_CLIENT_PORT: e2eHostPort,
        FORGEAX_GAME_API_PORT: e2eApiPort,
      },
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
      command: 'bun apps/standalone/game-backend.ts',
      cwd: '.',
      env: { ...process.env, FORGEAX_GAME_DIR: e2eGameDir, FORGEAX_GAME_API_PORT: e2eApiPort },
      url: `http://127.0.0.1:${e2eApiPort}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
    {
      // New-game template journey (.forgeax-harness/docs/2026-08-06-new-game-template-journey-e2e-plan
      // D-2): a SECOND standalone host on :15490 booted against the fresh
      // canonical-template copy — same `bun run dev:standalone` shape as webServer #1 with
      // its own port pair, so the template journey never perturbs the sample
      // host's specs. Only apps/standalone/e2e/__tests__/new-game-template-journey.spec.ts loads it.
      command: 'bun run dev:standalone',
      cwd: '.',
      env: {
        ...process.env as Record<string, string>,
        FORGEAX_GAME_DIR: e2eTemplateGameDir,
        FORGEAX_ENGINE_PORT: e2eTemplateEnginePort,
        FORGEAX_PLAY_RUNTIME_PORT: e2eTemplateEnginePort,
        FORGEAX_STANDALONE_PORT: e2eTemplateHostPort,
        FORGEAX_EDIT_RUNTIME_PORT: e2eTemplateEditPort,
        FORGEAX_GAME_API_PORT: e2eTemplateApiPort,
        FORGEAX_VITE_CACHE_ROOT: e2eTemplateViteCacheRoot,
        FORGEAX_BRIDGE_PORT: e2eTemplateBridgePort,
        FORGEAX_RUNTIME_SCOPE_ID: 'standalone-new-game-template',
        FORGEAX_RUNTIME_GENERATION: '1',
        FORGEAX_HMR_CLIENT_PORT: e2eTemplateHostPort,
      },
      url: `http://127.0.0.1:${e2eTemplateHostPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Disposable Play is now a real child realm. The fresh-template host
      // therefore needs a game-scoped Play producer too; sharing the sample
      // producer would correctly fail the runtime binding identity check.
      command: 'bun -F @forgeax/editor-play-runtime dev',
      cwd: '.',
      env: {
        ...process.env,
        FORGEAX_ENGINE_PORT: e2eTemplateEnginePort,
        FORGEAX_PLAY_RUNTIME_PORT: e2eTemplateEnginePort,
        FORGEAX_GAME_DIR: e2eTemplateGameDir,
        FORGEAX_VITE_CACHE_ROOT: e2eTemplateViteCacheRoot,
        FORGEAX_GAME_ID: 'new-game-template',
        FORGEAX_RUNTIME_SCOPE_ID: 'e2e-new-game-template',
        FORGEAX_RUNTIME_GENERATION: '1',
        FORGEAX_GAMES_URL_PREFIX: 'host-games',
        FORGEAX_HMR_CLIENT_PORT: e2eTemplateHostPort,
        FORGEAX_GAME_API_PORT: e2eTemplateApiPort,
      },
      url: `http://127.0.0.1:${e2eTemplateEnginePort}/preview/`,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
    {
      // The template host's /api backend pair (same game-backend.ts shape as
      // webServer #3, confined to the template copy) — without it the host's
      // /api proxy fails at boot and the spec's L1 clean-console assertion
      // would red on proxy noise instead of product errors.
      command: 'bun apps/standalone/game-backend.ts',
      cwd: '.',
      env: { ...process.env, FORGEAX_GAME_DIR: e2eTemplateGameDir, FORGEAX_GAME_API_PORT: e2eTemplateApiPort },
      url: `http://127.0.0.1:${e2eTemplateApiPort}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        ...(e2eBrowserChannel ? { channel: e2eBrowserChannel } : {}),
        launchOptions: {
          // Keep the broad smoke on the same software-Vulkan contract as the
          // strict editor smoke. ANGLE SwiftShader can destroy the WebGPU
          // device during this multi-server browser journey; RhiError is a
          // fatal smoke signal and must not be allowlisted.
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
