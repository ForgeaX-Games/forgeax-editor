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

// The page bridge is opt-in so standalone starts the relay and page together,
// while CI / bare Vite hosts never attempt a dead websocket. CRITICAL: these
// two Vite compile-time vars must reach the HOST vite (`bun run dev`, :15290)
// too — the standalone shell imports ViewportComponent IN-PROCESS (no iframe /
// no /editor proxy), so the host vite is what inlines
// `import.meta.env.VITE_FORGEAX_BRIDGE` into the page's bridge-dial code. Giving
// them only to edit-runtime leaves the page's bridgeEnabled=false and
// connectBridge() never runs — so both spawns below share bridgeEnv.
const bridgeEnv: NodeJS.ProcessEnv = {
  VITE_FORGEAX_BRIDGE: process.env.FORGEAX_BRIDGE === '0' ? '0' : '1',
  // Pass the relay port through Vite's compile-time environment too: the relay
  // and live page must derive it from the same source of truth.
  VITE_FORGEAX_BRIDGE_PORT: process.env.FORGEAX_BRIDGE_PORT ?? '15295',
};

console.log('[dev-standalone] starting edit-runtime :15280 (HMR→15290) ...');
children.push(
  spawnService(
    'bun',
    ['-F', '@forgeax/editor-edit-runtime', 'dev', '--', '--port', '15280', '--strictPort'],
    {
      cwd: ROOT,
      env: { ...process.env, ...bridgeEnv, FORGEAX_INTERFACE_PORT: '15290' },
    },
  ),
);

// DEV-only live gateway bridge relay (:15295). Lets a CLI drive THIS open
// window in real time (skills/forgeax-editor-gateway/scripts/gateway-live.mjs) instead of a headless
// playwright instance. Loopback-only; the page bridge (ViewportComponent, DEV
// build) dials it. Opt out with FORGEAX_BRIDGE=0.
if (process.env.FORGEAX_BRIDGE !== '0') {
  console.log('[dev-standalone] starting gateway bridge relay :15295 ...');
  children.push(
    // `bun` not `node`: `ws` lives only in bun's isolated store
    // (node_modules/.bun/ws@*), unhoisted, so bare node ERR_MODULE_NOT_FOUNDs.
    // Script lives under the forgeax-editor-gateway skill (AI tools ship with
    // their harness); cwd=ROOT so `ws` still resolves from the root node_modules.
    spawnService('bun', ['skills/forgeax-editor-gateway/scripts/gateway-bridge-server.mjs'], {
      cwd: ROOT,
      env: { ...process.env },
    }),
  );
}

console.log('[dev-standalone] starting standalone host :15290 ...');
// Forward env (not just the default process.env fallback) so an exported
// FORGEAX_ENGINE_RHI_DEBUG=1 reaches the host too — the host is where the engine
// boots + POSTs captured tapes, so it needs the rhi-debug plugin's endpoints.
// bridgeEnv too: the host vite inlines VITE_FORGEAX_BRIDGE into the in-process
// ViewportComponent (see the bridgeEnv comment above).
children.push(spawnService('bun', ['run', 'dev'], { cwd: ROOT, env: { ...process.env, ...bridgeEnv } }));

// Keep alive until a child exits (then cleanup trap tears the rest down).
await new Promise<void>((resolvePromise) => {
  for (const ch of children) ch.on('exit', () => resolvePromise());
});
