#!/usr/bin/env bun
// dev-standalone.ts — one-command standalone editor dev stack.
//
// Starts the two servers the standalone editor needs, wired correctly:
//   :15290  standalone chrome host (vite, root=apps/standalone/) — proxies /editor → :15280
//   :15280  edit-runtime (panel + viewport iframe source)
//
// The crucial bit is FORGEAX_INTERFACE_PORT=15290: edit-runtime's vite HMR
// clientPort defaults to 18920 (the studio-embed host). In standalone the host
// is :15290, so without this override the HMR websocket hammers a dead :18920
// and floods the console with ERR_CONNECTION_REFUSED. See edit-runtime
// vite.config.ts `hmr.clientPort` and playwright.config.ts webServer env.
//
// Cross-platform: pure Node APIs (no Git-Bash) — runs on Windows too.

import { execFileSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installCleanup, spawnService, type SpawnServiceOptions } from './lib/dev-stack.ts';
import { portEnvironment, resolveWorktreePorts } from './lib/worktree-ports.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANUAL_RUN_ID = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const MANUAL_LOG_DIR = resolve(ROOT, '..', '.forgeax-debug', 'manual-runs');
const configuredGameDir = process.env.FORGEAX_GAME_DIR;
const MANUAL_GAME_NAME = basename(configuredGameDir ? resolve(configuredGameDir) : 'standalone');
const MANUAL_LOG_FILE = join(MANUAL_LOG_DIR, `${MANUAL_GAME_NAME}-${MANUAL_RUN_ID}.log`);
mkdirSync(MANUAL_LOG_DIR, { recursive: true });
const WORKTREE_PORTS = resolveWorktreePorts(ROOT);
const PORTS = [WORKTREE_PORTS.standalone, WORKTREE_PORTS.editRuntime];
const bridgePort = String(WORKTREE_PORTS.bridge);
const bridgeEnabled = process.env.FORGEAX_BRIDGE !== '0';
const managedPorts = bridgeEnabled ? [...PORTS, WORKTREE_PORTS.bridge] : PORTS;
const portEnv = portEnvironment(WORKTREE_PORTS);
const gameDirAbs = configuredGameDir === undefined ? undefined : resolve(configuredGameDir);
const engineRevision = (() => {
  try {
    return execFileSync(
      'git',
      ['-C', resolve(ROOT, 'packages/engine'), 'rev-parse', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim() || 'unversioned';
  } catch {
    try {
      return readFileSync(resolve(ROOT, 'packages/engine/.dist-sha'), 'utf8').trim() || 'unversioned';
    } catch {
      return 'unversioned';
    }
  }
})();
const DDC_HOST_ROOT = gameDirAbs === undefined
  ? undefined
  : resolve(gameDirAbs, '.forgeax', 'ddc', 'v2', 'hosts', `engine-${engineRevision}`);
const HOST_DDC_PROJECT_ROOT = DDC_HOST_ROOT === undefined
  ? undefined
  : resolve(DDC_HOST_ROOT, `standalone-host-${WORKTREE_PORTS.standalone}`);
const VITE_CACHE_ROOT = process.env.FORGEAX_VITE_CACHE_ROOT
  ?? resolve(gameDirAbs ?? ROOT, '.forgeax', 'vite-cache', `engine-${engineRevision}`);

// The standalone stack intentionally runs two Vite producers: the chrome host
// owns the in-process editor runtime, while edit-runtime remains available as
// the replaceable iframe carrier. They must not publish into the same project
// DDC root concurrently (each process has its own publication coordinator).
// The game owns the parent Engine-scoped namespace; each process gets a
// process-scoped project root below it. This changes no authored game facts and
// prevents one carrier's publication from invalidating the other's candidate.
const EDIT_RUNTIME_DDC_PROJECT_ROOT = DDC_HOST_ROOT === undefined
  ? undefined
  : resolve(
    DDC_HOST_ROOT,
    `edit-runtime-${WORKTREE_PORTS.editRuntime}`,
  );

const children: ChildProcess[] = [];
const restartAttempts = new Map<string, number>();
const restartTimers = new Set<ReturnType<typeof setTimeout>>();
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_DELAY_MS = 1_000;
const lifecycleEventLogPath = process.env.FORGEAX_DEV_STACK_EVENT_LOG;
let shuttingDown = false;
let shutdownEventWritten = false;
let resolveFatalExit: (() => void) | null = null;

type ServiceSpec = {
  name: string;
  command: string;
  args: string[];
  options: SpawnServiceOptions;
};

const fatalExit = new Promise<void>((resolvePromise) => {
  resolveFatalExit = resolvePromise;
});

function writeLifecycleEvent(eventPayload: Record<string, unknown>): void {
  if (!lifecycleEventLogPath) return;
  appendFileSync(lifecycleEventLogPath, `${JSON.stringify(eventPayload)}\n`, 'utf8');
}

function logChildEvent(
  event: 'started' | 'error' | 'exited' | 'restart-scheduled' | 'restart-exhausted',
  details: Record<string, unknown>,
): void {
  const eventPayload = { event, ...details };
  const payload = JSON.stringify(eventPayload);
  const writer = event === 'error' || event === 'exited' || event === 'restart-exhausted'
    ? console.error
    : console.log;
  writer(`[dev-standalone] child-${event} ${payload}`);
  // Keep SIGKILL as the raw signal field so CI can classify it without parsing console text.
  writeLifecycleEvent(eventPayload);
}

function stopSupervision(reason = 'signal', signal: NodeJS.Signals | null = null): void {
  if (!shutdownEventWritten) {
    shutdownEventWritten = true;
    writeLifecycleEvent({
      event: 'shutdown',
      service: null,
      pid: null,
      code: null,
      signal,
      shuttingDown: true,
      reason,
    });
  }
  shuttingDown = true;
  for (const timer of restartTimers) clearTimeout(timer);
  restartTimers.clear();
}

function startManagedService(spec: ServiceSpec): void {
  let child: ChildProcess;
  try {
    child = spawnService(spec.command, spec.args, spec.options);
  } catch (error: unknown) {
    logChildEvent('error', {
      service: spec.name,
      message: error instanceof Error ? error.message : String(error),
    });
    stopSupervision('spawn-error');
    resolveFatalExit?.();
    return;
  }

  children.push(child);
  logChildEvent('started', { service: spec.name, pid: child.pid ?? null });

  let exitHandled = false;
  const handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (exitHandled) return;
    exitHandled = true;
    logChildEvent('exited', {
      service: spec.name,
      pid: child.pid ?? null,
      code,
      signal,
      shuttingDown,
    });
    if (shuttingDown) return;

    const attempt = restartAttempts.get(spec.name) ?? 0;
    if (attempt >= MAX_RESTART_ATTEMPTS) {
      logChildEvent('restart-exhausted', {
        service: spec.name,
        attempts: attempt,
        code,
        signal,
      });
      stopSupervision('restart-exhausted', signal);
      resolveFatalExit?.();
      return;
    }

    const nextAttempt = attempt + 1;
    restartAttempts.set(spec.name, nextAttempt);
    logChildEvent('restart-scheduled', {
      service: spec.name,
      attempt: nextAttempt,
      maxAttempts: MAX_RESTART_ATTEMPTS,
      delayMs: RESTART_DELAY_MS,
      code,
      signal,
    });
    const timer = setTimeout(() => {
      restartTimers.delete(timer);
      if (!shuttingDown) startManagedService(spec);
    }, RESTART_DELAY_MS);
    restartTimers.add(timer);
  };

  child.once('error', (error: Error) => {
    logChildEvent('error', {
      service: spec.name,
      pid: child.pid ?? null,
      message: error.message,
    });
    handleExit(null, null);
  });
  child.once('exit', handleExit);
}

process.once('SIGINT', () => stopSupervision('signal', 'SIGINT'));
process.once('SIGTERM', () => stopSupervision('signal', 'SIGTERM'));
installCleanup(children, managedPorts);

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
  VITE_FORGEAX_BRIDGE_PORT: bridgePort,
};
const runtimeBaseEnv: NodeJS.ProcessEnv = {
  ...process.env,
  ...portEnv,
  ...bridgeEnv,
  FORGEAX_VITE_CACHE_ROOT: VITE_CACHE_ROOT,
  ...(HOST_DDC_PROJECT_ROOT === undefined
    ? {}
    : {
        FORGEAX_DDC_PROJECT_ROOT: HOST_DDC_PROJECT_ROOT,
        FORGEAX_DDC_BUILD_CACHE_ROOT: resolve(HOST_DDC_PROJECT_ROOT, 'build'),
      }),
};

console.log(`[dev-standalone] starting edit-runtime :${WORKTREE_PORTS.editRuntime} (HMR→${WORKTREE_PORTS.standalone}) ...`);
console.log(`[dev-standalone] log-file ${MANUAL_LOG_FILE}`);
startManagedService({
  name: 'edit-runtime',
  command: 'bun',
  args: [
    '-F',
    '@forgeax/editor-edit-runtime',
    'dev',
    '--',
    '--port',
    String(WORKTREE_PORTS.editRuntime),
    '--strictPort',
  ],
  options: {
    cwd: ROOT,
    env: {
      ...runtimeBaseEnv,
      ...(EDIT_RUNTIME_DDC_PROJECT_ROOT === undefined
        ? {}
        : {
            FORGEAX_DDC_PROJECT_ROOT: EDIT_RUNTIME_DDC_PROJECT_ROOT,
            FORGEAX_DDC_BUILD_CACHE_ROOT: resolve(EDIT_RUNTIME_DDC_PROJECT_ROOT, 'build'),
          }),
    },
    teeLogPath: MANUAL_LOG_FILE,
  },
});

// DEV-only Gateway bridge relay (:15296 by default). Lets gateway.mjs drive this
// already-open window. Loopback-only; the page bridge (ViewportComponent, DEV
// build) dials it. Opt out with FORGEAX_BRIDGE=0.
if (bridgeEnabled) {
  console.log(`[dev-standalone] starting gateway bridge relay :${bridgePort} ...`);
  // `bun` not `node`: `ws` lives only in bun's isolated store
  // (node_modules/.bun/ws@*), unhoisted, so bare node ERR_MODULE_NOT_FOUNDs.
  // Script lives under the forgeax-editor-gateway skill (AI tools ship with
  // their harness); cwd=ROOT so `ws` still resolves from the root node_modules.
  startManagedService({
    name: 'gateway-bridge',
    command: 'bun',
    args: ['skills/forgeax-editor-gateway/scripts/gateway-bridge-server.mjs'],
    options: {
      cwd: ROOT,
      env: { ...runtimeBaseEnv, FORGEAX_BRIDGE_PORT: bridgePort },
      teeLogPath: MANUAL_LOG_FILE,
    },
  });
}

console.log(`[dev-standalone] starting standalone host :${WORKTREE_PORTS.standalone} ...`);
// Forward env (not just the default process.env fallback) so an exported
// FORGEAX_ENGINE_RHI_DEBUG=1 reaches the host too — the host is where the engine
// boots + POSTs captured tapes, so it needs the rhi-debug plugin's endpoints.
// bridgeEnv too: the host vite inlines VITE_FORGEAX_BRIDGE into the in-process
// ViewportComponent (see the bridgeEnv comment above).
startManagedService({
  name: 'standalone-host',
  command: 'bun',
  args: ['run', 'dev'],
  options: {
    cwd: ROOT,
    env: runtimeBaseEnv,
    teeLogPath: MANUAL_LOG_FILE,
  },
});

// Keep the stack alive while a child is restarted. Only exhausted restart
// attempts terminate the stack and let Playwright report infrastructure failure.
await fatalExit;
process.exitCode = 1;
