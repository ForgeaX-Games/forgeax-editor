// worktree-ports.ts — one port policy for every standalone editor checkout.
//
// The main checkout owns slot 0. A created worktree receives the next free
// slot, persisted in .forgeax-worktree.json, so restarting a worktree keeps its
// URLs stable while multiple worktrees remain isolated. fx.ts and the direct
// dev:standalone entry both consume this module; there is no second port map.

import { createServer } from 'node:net';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

export const WORKTREE_CONFIG_FILE = '.forgeax-worktree.json';
export const WORKTREE_PORT_LOCK_FILE = '.forgeax-worktree-port.lock';
export const WORKTREE_PORT_CONFIG_VERSION = 1;
export const WORKTREE_PORT_STRIDE = 100;

export const PORT_KEYS = [
  'standalone',
  'editRuntime',
  'gameApi',
  'playRuntime',
  'rhiReviewer',
  'bridge',
] as const;

export type PortKey = (typeof PORT_KEYS)[number];
export type PortMap = Readonly<Record<PortKey, number>>;

export const PORT_ENV: Readonly<Record<PortKey, string>> = {
  standalone: 'FORGEAX_STANDALONE_PORT',
  editRuntime: 'FORGEAX_EDIT_RUNTIME_PORT',
  gameApi: 'FORGEAX_GAME_API_PORT',
  playRuntime: 'FORGEAX_PLAY_RUNTIME_PORT',
  rhiReviewer: 'FORGEAX_RHI_REVIEWER_PORT',
  bridge: 'FORGEAX_BRIDGE_PORT',
};

// Slot 0 is deliberately the existing human-development profile. In
// particular, raw play-runtime remains on 15173 for Studio compatibility; the
// fx-managed profile uses 15273 and worktree slots derive from this map.
export const DEFAULT_PORTS: PortMap = {
  standalone: 15290,
  editRuntime: 15280,
  gameApi: 15281,
  playRuntime: 15273,
  rhiReviewer: 15274,
  bridge: 15296,
};

type WorktreePortFile = {
  readonly version: number;
  readonly ports: Record<string, unknown>;
};

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

function parsePort(value: unknown, source: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!validPort(parsed)) {
    throw new Error(`${source} must be an integer port from 1024 to 65535`);
  }
  return parsed;
}

function parsePortMap(value: unknown, source: string): PortMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${source} must be an object`);
  }

  const raw = value as Record<string, unknown>;
  const parsed = {} as Record<PortKey, number>;
  const seen = new Set<number>();
  for (const key of PORT_KEYS) {
    if (!hasOwn(raw, key)) throw new Error(`${source}.${key} is required`);
    const port = parsePort(raw[key], `${source}.${key}`);
    if (seen.has(port)) throw new Error(`${source} assigns port ${port} more than once`);
    seen.add(port);
    parsed[key] = port;
  }
  return parsed;
}

export function readWorktreePorts(root: string): PortMap | null {
  const path = join(root, WORKTREE_CONFIG_FILE);
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  const file = parsed as Partial<WorktreePortFile>;
  if (file.version !== WORKTREE_PORT_CONFIG_VERSION) {
    throw new Error(
      `${path} has unsupported version ${String(file.version)} (expected ${WORKTREE_PORT_CONFIG_VERSION})`,
    );
  }
  return parsePortMap(file.ports, `${path}.ports`);
}

export function writeWorktreePorts(root: string, ports: PortMap): void {
  const path = join(root, WORKTREE_CONFIG_FILE);
  writeFileSync(
    path,
    `${JSON.stringify({ version: WORKTREE_PORT_CONFIG_VERSION, ports }, null, 2)}\n`,
    'utf8',
  );
}

function environmentPort(env: NodeJS.ProcessEnv, key: PortKey, fallback: number): number {
  const name = PORT_ENV[key];
  const raw = env[name];
  return raw === undefined || raw === '' ? fallback : parsePort(raw, name);
}

/** Resolve env override > worktree assignment > the main-checkout defaults. */
export function resolveWorktreePorts(root: string, env: NodeJS.ProcessEnv = process.env): PortMap {
  const assigned = readWorktreePorts(root);
  const resolved = {} as Record<PortKey, number>;
  for (const key of PORT_KEYS) {
    resolved[key] = environmentPort(env, key, assigned?.[key] ?? DEFAULT_PORTS[key]);
  }
  return resolved;
}

/** Environment consumed by Vite, the backend, the play host, and the relay. */
export function portEnvironment(ports: PortMap): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PORT_KEYS) env[PORT_ENV[key]] = String(ports[key]);
  env.FORGEAX_INTERFACE_PORT = String(ports.standalone);
  return env;
}

export function portsForSlot(slot: number): PortMap {
  if (!Number.isInteger(slot) || slot < 0) throw new Error(`invalid worktree port slot: ${slot}`);
  const offset = slot * WORKTREE_PORT_STRIDE;
  const ports = {} as Record<PortKey, number>;
  for (const key of PORT_KEYS) ports[key] = DEFAULT_PORTS[key] + offset;
  return ports;
}

function configPaths(root: string): string[] {
  const paths = [join(root, WORKTREE_CONFIG_FILE)];
  const worktrees = join(root, '.worktrees');
  if (!existsSync(worktrees)) return paths;

  for (const entry of readdirSync(worktrees, { withFileTypes: true })) {
    const candidate = join(worktrees, entry.name, WORKTREE_CONFIG_FILE);
    try {
      if (entry.isDirectory() && existsSync(candidate)) paths.push(candidate);
      else if (entry.isSymbolicLink() && lstatSync(candidate).isFile()) paths.push(candidate);
    } catch {
      // A worktree can disappear while it is being removed. Its config will
      // no longer be an allocation source on the next invocation.
    }
  }
  return paths;
}

function reservedPorts(root: string): Set<number> {
  const reserved = new Set<number>(Object.values(DEFAULT_PORTS));
  for (const path of configPaths(root)) {
    const ports = readWorktreePorts(path.slice(0, -WORKTREE_CONFIG_FILE.length));
    if (ports) for (const port of Object.values(ports)) reserved.add(port);
  }
  return reserved;
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (available: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(available);
    };
    server.once('error', () => finish(false));
    server.listen({ host: '0.0.0.0', port, exclusive: true }, () => {
      server.close(() => finish(true));
    });
  });
}

async function available(ports: PortMap, reserved: Set<number>): Promise<boolean> {
  const values = Object.values(ports);
  if (values.some((port) => reserved.has(port))) return false;
  const results = await Promise.all(values.map((port) => canBind(port)));
  return results.every(Boolean);
}

export async function allocateWorktreePorts(root: string): Promise<{ readonly slot: number; readonly ports: PortMap }> {
  const reserved = reservedPorts(root);
  for (let slot = 1; slot < 1000; slot++) {
    const ports = portsForSlot(slot);
    if (await available(ports, reserved)) return { slot, ports };
  }
  throw new Error('no free worktree port slot found in the first 999 slots');
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Serialize allocation so two terminals cannot choose the same free slot. */
export function acquireWorktreePortLock(root: string): () => void {
  const path = join(root, WORKTREE_PORT_LOCK_FILE);
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw error;
    let pid = 0;
    try {
      pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    } catch {
      // Keep the lock if its owner cannot be identified.
    }
    if (pid > 0 && !processIsAlive(pid)) {
      unlinkSync(path);
      fd = openSync(path, 'wx');
    } else {
      throw new Error(
        `worktree port allocation is already running${pid > 0 ? ` (pid ${pid})` : ''}; retry after it finishes`,
      );
    }
  }

  writeSync(fd, `${process.pid}\n`);
  return () => {
    closeSync(fd);
    try {
      unlinkSync(path);
    } catch {
      // The lock may have been cleaned up after an interrupted invocation.
    }
  };
}
