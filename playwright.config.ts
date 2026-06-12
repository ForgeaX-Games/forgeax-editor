// Playwright config for @forgeax/editor — AC-09/12/14/15 e2e gate.
//
// Two webServers (mode-C from research F-4 + plan-strategy 2 D-9): the
// editor's standalone chrome host on :15290 (root = standalone/, calls
// mountStandalone(editorApp, { hideChatAndForge: true })), and the
// editor-edit-runtime vite root on :15280 (the iframe target that
// mountStandalone points at via app.entryUrl). The `?viewportOnly=1`
// URL is hard-wired in @forgeax/editor's defineApp call (research F-6
// C-1) — we only need the dev server up; URL composition stays in
// editor.
//
// Single-server hint from the M5 task description named only `bun -F
// editor dev` because that is the host page the AC-08 curl probes; the
// iframe target server is still required for the mount-standalone
// specs to receive VAG_* messages from the runtime, so it is added as
// the second webServer entry. Both servers reuse the legacy
// :15290/:15280 ports — OOS-8 forbids new ports.
//
// Anchors:
//   requirements AC-07 (iframe attached + src equals entryUrl) — port from P1.5
//   requirements AC-08 (host receives ≥1 VAG_* + zod safeParse success) — port from P1.5
//   requirements AC-09 (hideChatAndForge=true hides chat-panel + forge-entry; idempotent mount)
//   requirements AC-12 (e2e green after the move from standalone-editor-demo)
//   requirements AC-14 (bun -F editor test:e2e exit 0)
//   plan-strategy 2 D-9 (mode C — exposeFunction + addInitScript)
//   research F-4 (webServer array + 10s expect.poll fallback)
//   research F-6 C-1 (entryUrl = http://127.0.0.1:15280/?viewportOnly=1)

import { defineConfig } from '@playwright/test';

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
  timeout: 30_000,
  expect: {
    // Ten-second poll budget covers cold-start dev server + first VAG_*
    // emission (plan-strategy 4 R-AC-08 fallback). expect.poll uses
    // this when caller omits an explicit `timeout` option.
    timeout: 10_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:15290',
    headless: true,
    trace: 'off',
  },
  webServer: [
    {
      // editor standalone chrome host on :15290 — calls
      // mountStandalone(editorApp, { hideChatAndForge: true }) on
      // module load. Started via `bun -F editor dev` so the editor
      // package's vite.config.ts (root=standalone/, port=15290) applies.
      command: 'bun run dev',
      cwd: '.',
      url: 'http://127.0.0.1:15290',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // editor-edit-runtime — iframe target at app.entryUrl. Started
      // from its own package dir so the package's vite.config.ts
      // (PORT=15280, base='/editor/') applies unchanged.
      command: 'bunx vite --port 15280 --strictPort',
      cwd: './packages/edit-runtime',
      url: 'http://127.0.0.1:15280/editor/',
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
