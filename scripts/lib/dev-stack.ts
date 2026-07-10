// dev-stack.ts — cross-platform process helpers shared by fx.ts and
// dev-standalone.ts.
//
// Replaces the bash idioms that only ran on POSIX (`lsof -ti`, `kill 0`
// process-group teardown) so the standalone editor stack starts/stops
// identically on Linux, macOS, and a Windows dev box (no Git-Bash needed).

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';

const IS_WIN = process.platform === 'win32';

const c = {
  blue: '\x1b[0;34m',
  green: '\x1b[0;32m',
  yellow: '\x1b[0;33m',
  red: '\x1b[0;31m',
  reset: '\x1b[0m',
};

export const step = (msg: string): void => console.log(`${c.blue}[fx]${c.reset} ${msg}`);
export const ok = (msg: string): void => console.log(`${c.green}[fx] ✓${c.reset} ${msg}`);
export const warn = (msg: string): void => console.log(`${c.yellow}[fx] !${c.reset} ${msg}`);
export function die(msg: string): never {
  console.error(`${c.red}[fx] ✗${c.reset} ${msg}`);
  process.exit(1);
}

/** True if `cmd` resolves on PATH (cross-platform `command -v`). */
export function has(cmd: string): boolean {
  const probe = IS_WIN ? 'where' : 'command';
  const args = IS_WIN ? [cmd] : ['-v', cmd];
  const r = spawnSync(probe, args, { stdio: 'ignore', shell: IS_WIN });
  return r.status === 0;
}

/** Assert `cmd` is on PATH, else die with an install hint. */
export function require(cmd: string, hint: string): void {
  if (!has(cmd)) die(`missing '${cmd}' on PATH. ${hint}`);
}

/** Return the PIDs LISTENing on `port` (cross-platform). */
export function listenPids(port: number): string[] {
  if (IS_WIN) {
    // netstat -ano: last column is the PID; match LISTENING rows for :port.
    const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
    if (r.status !== 0 || !r.stdout) return [];
    const pids = new Set<string>();
    for (const line of r.stdout.split('\n')) {
      if (!/LISTENING/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      const local = cols[1] ?? '';
      if (local.endsWith(`:${port}`)) {
        const pid = cols[cols.length - 1];
        if (pid && pid !== '0') pids.add(pid);
      }
    }
    return [...pids];
  }
  // POSIX: lsof -ti gives bare PIDs; exits non-zero when nothing listens.
  const r = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' });
  if (!r.stdout) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Kill a single PID (tree on Windows), force-killing if `force`. */
function killPid(pid: string, force: boolean): void {
  if (IS_WIN) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
      stdio: 'ignore',
    });
  } else {
    spawnSync('kill', [...(force ? ['-9'] : []), String(pid)], { stdio: 'ignore' });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Stop whatever listens on `ports` — precise (never `pkill vite`): graceful
 * kill, brief wait, then SIGKILL/`/F` any survivor. Returns true if it killed
 * anything.
 */
export async function killByPorts(ports: number[]): Promise<boolean> {
  let killed = false;
  for (const p of ports) {
    let pids = listenPids(p);
    if (pids.length === 0) continue;
    for (const pid of pids) killPid(pid, false);
    await sleep(300);
    pids = listenPids(p);
    for (const pid of pids) killPid(pid, true);
    ok(`freed :${p}`);
    killed = true;
  }
  return killed;
}

export type SpawnServiceOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  detach?: boolean;
  logFd?: number;
};

/**
 * Spawn a long-lived child. Returns the ChildProcess.
 *
 * Foreground (default): inherits stdio, own process group on POSIX so the
 * cleanup handler can tear the whole tree down.
 *
 * Background (`opts.detach`): fully detached + unref'd so the child outlives
 * this CLI process on every platform (mirrors the old bash `nohup … &`); stdio
 * is ignored (or redirected to `opts.logFd` when given).
 */
export function spawnService(cmd: string, args: string[], opts: SpawnServiceOptions = {}): ChildProcess {
  const child = spawn(cmd, args, {
    stdio: opts.detach ? ['ignore', opts.logFd ?? 'ignore', opts.logFd ?? 'ignore'] : 'inherit',
    shell: IS_WIN, // resolve `bun`/`bun.exe` via PATHEXT on Windows
    detached: opts.detach || !IS_WIN, // bg: detach everywhere; fg POSIX: own group
    cwd: opts.cwd,
    env: opts.env ?? process.env,
  });
  if (opts.detach) child.unref(); // let this process exit without waiting
  return child;
}

/**
 * Install SIGINT/SIGTERM/exit handlers that tear down the given children and
 * free the given ports. Mirrors the bash `trap cleanup EXIT INT TERM` + `kill 0`.
 */
export function installCleanup(children: ChildProcess[], ports: number[]): void {
  let done = false;
  const cleanup = (): void => {
    if (done) return;
    done = true;
    console.log();
    step('shutting down ...');
    for (const ch of children) {
      if (!ch.pid) continue;
      try {
        if (IS_WIN) spawnSync('taskkill', ['/PID', String(ch.pid), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(-ch.pid, 'SIGTERM'); // negative pid = the group
      } catch {
        // already gone
      }
    }
    // Backstop: anything still holding our ports.
    void killByPorts(ports);
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
  process.on('exit', cleanup);
}

export { IS_WIN };
