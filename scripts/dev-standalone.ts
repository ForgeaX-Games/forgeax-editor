#!/usr/bin/env bun
// dev-standalone.ts — one-command standalone editor dev stack.
//
// Starts the two servers the standalone editor needs, wired correctly:
//   :15290  standalone chrome host (vite, root=standalone/) — proxies /editor → :15280
//   :15280  edit-runtime (panel + viewport iframe source)
//
// The crucial bit is FORGEAX_INTERFACE_PORT=15290: edit-runtime's vite HMR
// clientPort defaults to 18920 (the studio-embed host). In standalone the host
// is :15290, so without this override the HMR websocket hammers a dead :18920
// and floods the console with ERR_CONNECTION_REFUSED. See edit-runtime
// vite.config.ts `hmr.clientPort` and playwright.config.ts webServer env.
//
// Cross-platform: pure Node APIs (no Git-Bash) — runs on Windows too.

import { type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installCleanup, spawnService } from './lib/dev-stack.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORTS = [15290, 15280];

const children: ChildProcess[] = [];
installCleanup(children, PORTS);

console.log('[dev-standalone] starting edit-runtime :15280 (HMR→15290) ...');
children.push(
  spawnService(
    'bun',
    ['-F', '@forgeax/editor-edit-runtime', 'dev', '--', '--port', '15280', '--strictPort'],
    { cwd: ROOT, env: { ...process.env, FORGEAX_INTERFACE_PORT: '15290' } },
  ),
);

console.log('[dev-standalone] starting standalone host :15290 ...');
// Forward env (not just the default process.env fallback) so an exported
// FORGEAX_ENGINE_RHI_DEBUG=1 reaches the host too — the host is where the engine
// boots + POSTs captured tapes, so it needs the rhi-debug plugin's endpoints.
children.push(spawnService('bun', ['run', 'dev'], { cwd: ROOT, env: { ...process.env } }));

// Keep alive until a child exits (then cleanup trap tears the rest down).
await new Promise<void>((resolvePromise) => {
  for (const ch of children) ch.on('exit', () => resolvePromise());
});
