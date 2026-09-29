#!/usr/bin/env bun
// dev-standalone.ts — one-command standalone editor dev stack.
//
// Starts the standalone editor servers, wired correctly:
//   :15290  standalone chrome host (vite, root=apps/standalone/) — proxies /editor → :15280
//   :15280  edit-runtime (panel + viewport iframe source)
//   :15281  game backend (only when FORGEAX_GAME_DIR is supplied)
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
import {
  resolveHostCatalogScope,
  waitForHostCatalogReady,
  waitForHttpReady,
} from './lib/wait-host-catalog.ts';
import { portEnvironment, resolveWorktreePorts } from './lib/worktree-ports.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANUAL_RUN_ID = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const MANUAL_LOG_DIR = resolve(ROOT, '..', '.forgeax-debug', 'manual-runs');
const configuredGameDir = process.env.FORGEAX_GAME_DIR;
const MANUAL_GAME_NAME = basename(configuredGameDir ? resolve(configuredGameDir) : 'standalone');
const MANUAL_LOG_FILE = join(MANUAL_LOG_DIR, `${MANUAL_GAME_NAME}-${MANUAL_RUN_ID}.log`);
mkdirSync(MANUAL_LOG_DIR, { recursive: true });
const WORKTREE_PORTS = resolveWorktreePorts(ROOT);
const PORTS = [
  WORKTREE_PORTS.standalone,
  WORKTREE_PORTS.editRuntime,
  ...(configuredGameDir === undefined ? [] : [WORKTREE_PORTS.gameApi]),
];
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

const useNodeViteRuntime = process.env.FORGEAX_SMOKE_VITE_RUNTIME === 'node';
const nodeExecutable = process.env.FORGEAX_SMOKE_NODE_BIN ?? 'node';
const viteBin = resolve(ROOT, 'node_modules/vite/bin/vite.js');
const hostViteConfig = resolve(ROOT, 'vite.config.ts');
const playViteConfig = resolve(ROOT, 'packages/play-runtime/vite.config.ts');

function parseRequiredCatalogSources(): readonly string[] {
  const raw = process.env.FORGEAX_CATALOG_REQUIRED_SOURCES;
  if (raw === undefined || raw.trim().length === 0) return [];
  return raw.split(',').map((sourcePath) => sourcePath.trim()).filter((sourcePath) => sourcePath.length > 0);
}

function resolvePlayEnginePort(): number {
  const raw = process.env.FORGEAX_ENGINE_PORT
    ?? process.env.FORGEAX_E2E_ENGINE_PORT
    ?? process.env.FORGEAX_PLAY_RUNTIME_PORT;
  if (raw === undefined || raw === '') return WORKTREE_PORTS.playRuntime;
  return Number.parseInt(raw, 10);
}

function hostViteLaunch(): { command: string; args: string[] } {
  if (useNodeViteRuntime) {
    return { command: nodeExecutable, args: [viteBin, '--config', hostViteConfig] };
  }
  return { command: 'bun', args: ['run', 'dev'] };
}

function startDeferredPlayRuntime(): void {
  const playPort = resolvePlayEnginePort();
  const playCwd = resolve(ROOT, 'packages/play-runtime');
  const playArgs = useNodeViteRuntime
    ? [viteBin, '--config', playViteConfig, '--port', String(playPort), '--strictPort']
    : ['x', 'vite', '--config', playViteConfig, '--port', String(playPort), '--strictPort'];
  const playCommand = useNodeViteRuntime ? nodeExecutable : 'bun';
  console.log(`[dev-standalone] starting deferred play-runtime :${playPort} ...`);
  startManagedService({
    name: 'play-runtime-deferred',
    command: playCommand,
    args: playArgs,
    options: {
      cwd: playCwd,
      env: {
        ...runtimeBaseEnv,
        FORGEAX_VITE_CACHE_ROOT: resolve(VITE_CACHE_ROOT, 'play-runtime-deferred'),
        FORGEAX_GAMES_URL_PREFIX: process.env.FORGEAX_GAMES_URL_PREFIX ?? 'smoke-games',
      },
      teeLogPath: MANUAL_LOG_FILE,
    },
  });
}

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
const fatalExitGate: { resolve: (() => void) | null } = { resolve: null };

type ServiceSpec = {
  name: string;
  command: string;
  args: string[];
  options: SpawnServiceOptions;
};

const fatalExit = new Promise<void>((resolve) => {
  fatalExitGate.resolve = () => { resolve(); };
});

function signalFatalExit(): void {
  fatalExitGate.resolve?.();
}

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
    signalFatalExit();
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
      signalFatalExit();
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
const useExternalGameBackend = process.env.FORGEAX_DEV_STACK_EXTERNAL_GAME_BACKEND === '1';
const shouldStartGameBackend = gameDirAbs !== undefined && !useExternalGameBackend;

const runtimeBaseEnv: NodeJS.ProcessEnv = {
  ...process.env,
  ...portEnv,
  ...bridgeEnv,
  FORGEAX_VITE_CACHE_ROOT: VITE_CACHE_ROOT,
  ...(gameDirAbs === undefined
    ? {}
    : {
        FORGEAX_GAME_DIR: gameDirAbs,
        FORGEAX_GAME_ID: process.env.FORGEAX_GAME_ID ?? basename(gameDirAbs),
        FORGEAX_RUNTIME_SCOPE_ID: process.env.FORGEAX_RUNTIME_SCOPE_ID
          ?? `standalone-${basename(gameDirAbs)}`,
        FORGEAX_RUNTIME_GENERATION: process.env.FORGEAX_RUNTIME_GENERATION ?? '1',
        FORGEAX_GAME_API_PORT: String(WORKTREE_PORTS.gameApi),
        FORGEAX_SOURCE_CATALOG_URL: `http://127.0.0.1:${WORKTREE_PORTS.standalone}/__pack/scopes/${encodeURIComponent(process.env.FORGEAX_RUNTIME_SCOPE_ID ?? `standalone-${basename(gameDirAbs)}`)}/${encodeURIComponent(process.env.FORGEAX_RUNTIME_GENERATION ?? '1')}/catalog.json`,
        FORGEAX_GAMES_URL_PREFIX: process.env.FORGEAX_GAMES_URL_PREFIX ?? 'host-games',
      }),
  ...(HOST_DDC_PROJECT_ROOT === undefined
    ? {}
    : {
        FORGEAX_DDC_PROJECT_ROOT: HOST_DDC_PROJECT_ROOT,
        FORGEAX_DDC_BUILD_CACHE_ROOT: resolve(HOST_DDC_PROJECT_ROOT, 'build'),
      }),
};

if (shouldStartGameBackend) {
  console.log(`[dev-standalone] starting game-backend :${WORKTREE_PORTS.gameApi} ...`);
  startManagedService({
    name: 'game-backend',
    command: 'bun',
    args: ['apps/standalone/game-backend.ts'],
    options: {
      cwd: ROOT,
      env: runtimeBaseEnv,
      teeLogPath: MANUAL_LOG_FILE,
    },
  });
  try {
    await waitForHttpReady(`http://127.0.0.1:${WORKTREE_PORTS.gameApi}/api/health`, {
      timeoutMs: 60_000,
      log: (message) => console.log(`[dev-standalone] ${message}`),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[dev-standalone] ${message}`);
    stopSupervision('game-backend-timeout');
    signalFatalExit();
    process.exitCode = 1;
    await fatalExit;
    process.exit(1);
  }
}

console.log(`[dev-standalone] starting standalone host :${WORKTREE_PORTS.standalone} ...`);
// Forward env (not just the default process.env fallback) so an exported
// FORGEAX_ENGINE_RHI_DEBUG=1 reaches the host too — the host is where the engine
// boots + POSTs captured tapes, so it needs the rhi-debug plugin's endpoints.
// bridgeEnv too: the host vite inlines VITE_FORGEAX_BRIDGE into the in-process
// ViewportComponent (see the bridgeEnv comment above).
const hostLaunch = hostViteLaunch();
startManagedService({
  name: 'standalone-host',
  command: hostLaunch.command,
  args: hostLaunch.args,
  options: {
    cwd: ROOT,
    env: runtimeBaseEnv,
    teeLogPath: MANUAL_LOG_FILE,
  },
});

const requiredCatalogSources = parseRequiredCatalogSources();
const requirePublishedCatalog = process.env.FORGEAX_CATALOG_REQUIRE_PUBLISHED === '1';

const hostCatalogScopeId = resolveHostCatalogScope({
  gameDir: gameDirAbs,
  scopeId: process.env.FORGEAX_RUNTIME_SCOPE_ID,
});

console.log(
  `[dev-standalone][boot-trace] game=${gameDirAbs ?? '(none)'} scope=${hostCatalogScopeId ?? '(http-only)'}`
  + ` catalogRequired=${requiredCatalogSources.length > 0 ? requiredCatalogSources.join('|') : 'none'}`
  + ` publish=${requirePublishedCatalog} vite=${useNodeViteRuntime ? 'node' : 'bun'}`
  + ` editWait=/editor/ playInStack=${process.env.FORGEAX_SMOKE_DEFERRED_PLAY === '1' ? 'deferred' : 'external'}`,
);

try {
  if (hostCatalogScopeId !== undefined) {
    await waitForHostCatalogReady({
      hostPort: WORKTREE_PORTS.standalone,
      gameDir: gameDirAbs,
      scopeId: hostCatalogScopeId,
      requiredSourcePaths: requiredCatalogSources,
      requirePublishedPackageUrls: requirePublishedCatalog,
      timeoutMs: requiredCatalogSources.length > 0 ? 180_000 : 90_000,
      log: (message) => console.log(`[dev-standalone] ${message}`),
    });
  } else {
    await waitForHttpReady(`http://127.0.0.1:${WORKTREE_PORTS.standalone}/`, {
      timeoutMs: 90_000,
      log: (message) => console.log(`[dev-standalone] ${message}`),
    });
  }
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[dev-standalone] ${message}`);
  stopSupervision('catalog-timeout');
  signalFatalExit();
  process.exitCode = 1;
  await fatalExit;
  process.exit(1);
}

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
      FORGEAX_VITE_CACHE_ROOT: resolve(VITE_CACHE_ROOT, 'edit-runtime'),
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

try {
  await waitForHttpReady(`http://127.0.0.1:${WORKTREE_PORTS.editRuntime}/editor/`, {
    timeoutMs: 120_000,
    log: (message) => console.log(`[dev-standalone] ${message}`),
  });
  console.log(`[dev-standalone][boot-trace] edit-runtime ready (Playwright webServer url polls :${WORKTREE_PORTS.editRuntime}/editor/)`);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[dev-standalone] ${message}`);
  stopSupervision('edit-runtime-timeout');
  signalFatalExit();
  process.exitCode = 1;
  await fatalExit;
  process.exit(1);
}

if (requiredCatalogSources.length > 0 || requirePublishedCatalog) {
  try {
    const editCatalogScopeId = gameDirAbs === undefined
      ? process.env.FORGEAX_RUNTIME_SCOPE_ID
      : (process.env.FORGEAX_RUNTIME_SCOPE_ID ?? `edit-${basename(gameDirAbs)}`);
    await waitForHostCatalogReady({
      hostPort: WORKTREE_PORTS.editRuntime,
      basePath: '/editor',
      ...(editCatalogScopeId !== undefined && editCatalogScopeId.length > 0
        ? { scopeId: editCatalogScopeId, gameDir: gameDirAbs }
        : {}),
      requiredSourcePaths: requiredCatalogSources,
      requirePublishedPackageUrls: requirePublishedCatalog,
      timeoutMs: requiredCatalogSources.length > 0 ? 180_000 : 90_000,
      log: (message) => console.log(`[dev-standalone] ${message}`),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[dev-standalone] ${message}`);
    stopSupervision('edit-catalog-timeout');
    signalFatalExit();
    process.exitCode = 1;
    await fatalExit;
    process.exit(1);
  }
}

if (process.env.FORGEAX_SMOKE_DEFERRED_PLAY === '1') {
  startDeferredPlayRuntime();
}

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

// Keep the stack alive while a child is restarted. Only exhausted restart
// attempts terminate the stack and let Playwright report infrastructure failure.
await fatalExit;
process.exitCode = 1;
