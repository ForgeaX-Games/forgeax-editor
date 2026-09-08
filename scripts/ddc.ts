import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
// Keep the CLI on the Engine-owned status schema; this import is source-first
// because the standalone editor does not require Engine dist for script help.
import { DDC_STATUS_SCHEMA } from '../packages/engine/packages/ddc/src/status.ts';
import { resolveDdcRootPolicy } from './vite/ddc-root-policy.ts';

type Health = 'ready' | 'blocked' | 'missing' | 'stale' | 'failed' | 'unavailable';
type Classification = 'migratable' | 'unavailable' | 'protected';
type ActionKind = 'inspect' | 'allocate-generation' | 'retry' | 'cold-rebuild' | 'prune';

interface RecoveryAction {
  readonly kind: ActionKind;
  readonly executable: boolean;
  readonly exactTarget?: string;
  readonly reason: string;
}

interface InventoryEntry {
  readonly layer: 'build' | 'project' | 'runtime';
  readonly owner: 'engine-ddc' | 'engine-pack' | 'plugin' | 'runtime' | 'unknown';
  readonly rootKind: 'build-cache' | 'project-ddc' | 'runtime';
  readonly classification: Classification;
  readonly exactTarget: string;
  readonly bytes: number;
  readonly lastUsed: string;
  readonly reason: string;
  readonly protectedBy: readonly string[];
  readonly signature: string;
}

type PublicInventoryEntry = Omit<InventoryEntry, 'signature'>;

interface HeadFacts {
  readonly current: readonly string[];
  readonly lastKnownGood: readonly string[];
  readonly leases: readonly string[];
  readonly currentGenerations: readonly number[];
  readonly revisions: readonly number[];
}

interface DdcStatusEnvelope {
  readonly schemaVersion: typeof DDC_STATUS_SCHEMA;
  readonly health: Health;
  readonly gameDir: string;
  readonly projectDdcRoot: string;
  readonly buildCacheRoot: string;
  readonly layers: readonly Record<string, unknown>[];
  readonly legacy: {
    readonly entries: readonly PublicInventoryEntry[];
    readonly bytes: number;
    readonly reclaimableBytes: number;
  };
  readonly recoveryActions: readonly RecoveryAction[];
}

interface CliErrorPayload {
  readonly code: string;
  readonly detail: string;
  readonly hint: string;
  readonly expected: unknown;
  readonly actual?: unknown;
  readonly recoveryActions: readonly RecoveryAction[];
}

const HELP = `forgeax DDC recovery CLI

Usage:
  bun fx ddc status --game DIR --json
  bun fx ddc rebuild --game DIR --json
  bun fx ddc prune --game DIR --dry-run --json
  bun fx ddc prune --game DIR --execute --json

Actions:
  status   inspect project-local and legacy derived state; read-only
  rebuild  report a cold rebuild request and producer availability
  prune    inventory exact targets; does not delete by default

Safety:
  --dry-run is the default for prune. --execute deletes only revalidated,
  migratable exact targets and never removes protected or unknown state.
`;

interface FileFact {
  readonly path: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

async function readFileFact(path: string): Promise<FileFact | null> {
  try {
    const value = await lstat(path);
    if (value.isSymbolicLink()) return null;
    return { path, bytes: value.isFile() ? value.size : 0, mtimeMs: value.mtimeMs };
  } catch {
    return null;
  }
}

async function collectFiles(root: string): Promise<readonly FileFact[]> {
  const rootFact = await readFileFact(root);
  if (rootFact === null) return [];
  if (!rootFact.bytes && (await lstat(root)).isFile()) return [rootFact];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: FileFact[] = [];
  for (const entry of entries) {
    const child = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...(await collectFiles(child)));
    else if (entry.isFile()) {
      const fact = await readFileFact(child);
      if (fact !== null) files.push(fact);
    }
  }
  return files;
}

async function byteCount(root: string): Promise<{ bytes: number; lastUsed: number }> {
  const files = await collectFiles(root);
  return {
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    lastUsed: files.reduce((latest, file) => Math.max(latest, file.mtimeMs), 0),
  };
}

function withinRoot(root: string, target: string): boolean {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const relativePath = relative(rootPath, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function exactSignature(bytes: number, mtimeMs: number): string {
  return createHash('sha256').update(`${bytes}:${mtimeMs}`).digest('hex');
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function readHeadFacts(projectRoot: string): Promise<HeadFacts> {
  const headsRoot = join(projectRoot, 'heads');
  const entries = await readdir(headsRoot, { withFileTypes: true }).catch(() => []);
  const current: string[] = [];
  const lastKnownGood: string[] = [];
  const leases: string[] = [];
  const currentGenerations: number[] = [];
  const revisions: number[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const record = await readJson(join(headsRoot, entry.name));
    if (record === null) continue;
    if (typeof record.currentKey === 'string') current.push(record.currentKey);
    if (typeof record.lastKnownGoodKey === 'string') lastKnownGood.push(record.lastKnownGoodKey);
    if (typeof record.revision === 'number') revisions.push(record.revision);
    if (typeof record.generation === 'number') currentGenerations.push(record.generation);
    const active = record.active;
    if (active !== null && typeof active === 'object') {
      const attempt = (active as { readonly attempt?: unknown }).attempt;
      if (typeof attempt === 'string') leases.push(attempt);
    }
  }
  return { current, lastKnownGood, leases, currentGenerations, revisions };
}

function displayTime(mtimeMs: number): string | null {
  return mtimeMs > 0 ? new Date(mtimeMs).toISOString() : null;
}

async function makeLegacyEntry(target: string): Promise<InventoryEntry> {
  const measured = await byteCount(target);
  const targetFact = await readFileFact(target);
  const signature = exactSignature(measured.bytes, targetFact?.mtimeMs ?? 0);
  const receipt = await readJson(join(target, 'receipt.json'));
  const integrity = await readJson(join(target, 'integrity.json'));
  const verified = receipt?.kind === 'pure-build-object' && integrity !== null;
  return {
    layer: verified ? 'build' : 'runtime',
    owner: verified ? 'engine-ddc' : 'unknown',
    rootKind: verified ? 'build-cache' : 'runtime',
    classification: verified ? 'migratable' : 'unavailable',
    exactTarget: resolve(target),
    bytes: measured.bytes,
    lastUsed: displayTime(measured.lastUsed) ?? new Date(0).toISOString(),
    reason: verified
      ? 'receipt and integrity prove a pure build object'
      : 'legacy state has no provable game owner or integrity contract',
    protectedBy: [],
    signature,
  };
}

async function inventoryLegacy(gameDir: string): Promise<readonly InventoryEntry[]> {
  const root = join(gameDir, 'node_modules', '.cache', 'forgeax-ddc');
  const children = await readdir(root, { withFileTypes: true }).catch(() => []);
  const entries: InventoryEntry[] = [];
  for (const child of children) {
    if (!child.isDirectory() || child.isSymbolicLink()) continue;
    const container = join(root, child.name);
    const marker = await readJson(join(container, 'receipt.json'));
    if (marker !== null) {
      entries.push(await makeLegacyEntry(container));
      continue;
    }
    const nested = await readdir(container, { withFileTypes: true }).catch(() => []);
    for (const item of nested) {
      if (item.isDirectory() && !item.isSymbolicLink()) {
        entries.push(await makeLegacyEntry(join(container, item.name)));
      }
    }
  }
  return entries;
}

async function makeStatus(gameDirInput: string): Promise<DdcStatusEnvelope> {
  const policy = resolveDdcRootPolicy(gameDirInput);
  const projectFacts = await byteCount(policy.projectDdcRoot);
  const buildFacts = await byteCount(policy.buildCacheRoot);
  const heads = await readHeadFacts(policy.projectDdcRoot);
  const legacyEntries = await inventoryLegacy(policy.gameDir);
  const legacyBytes = legacyEntries.reduce((sum, entry) => sum + entry.bytes, 0);
  const reclaimableBytes = legacyEntries
    .filter((entry) => entry.classification === 'migratable')
    .reduce((sum, entry) => sum + entry.bytes, 0);
  const projectProtectionFacts = [
    ...heads.current.map((key) => `current:${key}`),
    ...heads.lastKnownGood.map((key) => `lastKnownGood:${key}`),
    ...heads.leases.map((lease) => `lease:${lease}`),
  ];
  const status: Health = !projectFacts.bytes && legacyEntries.length === 0
    ? 'missing'
    : legacyEntries.some((entry) => entry.classification === 'unavailable')
      ? 'stale'
      : 'ready';
  const actions: RecoveryAction[] = [
    { kind: 'inspect', executable: true, reason: 'read status before changing derived state' },
    { kind: 'cold-rebuild', executable: true, reason: 'rebuild from author source when evidence is unavailable' },
  ];
  if (legacyEntries.some((entry) => entry.classification === 'migratable')) {
    actions.push({ kind: 'prune', executable: true, reason: 'dry-run exact targets before explicit prune' });
  }
  return {
    schemaVersion: DDC_STATUS_SCHEMA,
    health: status,
    gameDir: policy.gameDir,
    projectDdcRoot: policy.projectDdcRoot,
    buildCacheRoot: policy.buildCacheRoot,
    layers: [
      {
        kind: 'project',
        owner: 'engine-ddc',
        rootKind: 'project-ddc',
        current: heads.current[0],
        lastKnownGood: heads.lastKnownGood[0],
        generation: heads.currentGenerations[0],
        lease: heads.leases[0],
        revision: heads.revisions[0],
        bytes: projectFacts.bytes,
        lastUsed: displayTime(projectFacts.lastUsed),
        protection: projectProtectionFacts,
        actions,
      },
      {
        kind: 'build',
        owner: 'engine-ddc',
        rootKind: 'build-cache',
        bytes: buildFacts.bytes,
        lastUsed: displayTime(buildFacts.lastUsed),
        protection: [],
        actions: [{ kind: 'inspect', executable: true, reason: 'build CAS is an optional accelerator' }],
      },
    ],
    legacy: {
      entries: legacyEntries.map(({ signature: _signature, ...entry }) => entry),
      bytes: legacyBytes,
      reclaimableBytes,
    },
    recoveryActions: actions,
  };
}

function errorPayload(error: unknown): CliErrorPayload {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const value = error as { readonly code?: unknown; readonly expected?: unknown; readonly actual?: unknown; readonly hint?: unknown; readonly message?: unknown };
    return {
      code: typeof value.code === 'string' ? value.code : 'ddc-cli-failed',
      detail: typeof value.message === 'string' ? value.message : String(error),
      hint: typeof value.hint === 'string' ? value.hint : 'inspect the game root and retry',
      expected: value.expected ?? 'a valid game directory',
      ...(value.actual === undefined ? {} : { actual: value.actual }),
      recoveryActions: [{ kind: 'inspect', executable: true, reason: 'inspect the canonical game root before retrying' }],
    };
  }
  return {
    code: 'ddc-cli-failed',
    detail: error instanceof Error ? error.message : String(error),
    hint: 'inspect the command input and retry',
    expected: 'a valid DDC command',
    recoveryActions: [{ kind: 'inspect', executable: true, reason: 'inspect command input and status' }],
  };
}

function parseGame(args: readonly string[]): string {
  const index = args.indexOf('--game');
  if (index < 0 || args[index + 1] === undefined || args[index + 1]!.startsWith('--')) {
    throw Object.assign(new Error('--game DIR is required'), {
      code: 'ddc-game-root-required',
      expected: 'an existing game directory',
      hint: 'pass one canonical game directory with --game DIR',
    });
  }
  return args[index + 1]!;
}

function assertKnownFlags(args: readonly string[]): void {
  const known = new Set(['--game', '--json', '--dry-run', '--execute']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--game') {
      index += 1;
      continue;
    }
    if (!known.has(arg)) throw new Error(`unknown ddc flag: ${arg}`);
  }
}

async function prune(gameDir: string, execute: boolean): Promise<Record<string, unknown>> {
  const status = await makeStatus(gameDir);
  const policy = resolveDdcRootPolicy(gameDir);
  const candidates = await inventoryLegacy(policy.gameDir);
  const legacyRoot = join(policy.gameDir, 'node_modules', '.cache', 'forgeax-ddc');
  if (!execute) {
    return {
      schemaVersion: DDC_STATUS_SCHEMA,
      operation: 'prune',
      dryRun: true,
      candidates,
      deleted: [],
      reclaimedBytes: 0,
      reverified: false,
      recoveryActions: status.recoveryActions,
    };
  }
  const checked: InventoryEntry[] = [];
  const deletable = candidates.filter((candidate) => candidate.classification === 'migratable');
  for (const candidate of deletable) {
    if (!withinRoot(legacyRoot, candidate.exactTarget)) {
      throw Object.assign(new Error('exact prune target escaped its legacy root'), {
        code: 'ddc-prune-target-outside-root',
        expected: legacyRoot,
        actual: candidate.exactTarget,
        hint: 'run status again and use only an exact target within the game root',
      });
    }
    const fact = await readFileFact(candidate.exactTarget);
    const measured = await byteCount(candidate.exactTarget);
    if (fact === null || exactSignature(measured.bytes, fact.mtimeMs) !== candidate.signature) {
      throw Object.assign(new Error('exact prune target changed before deletion'), {
        code: 'ddc-prune-target-changed',
        expected: candidate.signature,
        actual: fact === null ? 'missing' : exactSignature(measured.bytes, fact.mtimeMs),
        hint: 'run a fresh dry-run and reverify the exact target before pruning',
      });
    }
    checked.push(candidate);
  }
  const deleted: string[] = [];
  for (const candidate of checked) {
    await rm(candidate.exactTarget, { recursive: true, force: false });
    deleted.push(candidate.exactTarget);
  }
  return {
    schemaVersion: DDC_STATUS_SCHEMA,
    operation: 'prune',
    dryRun: false,
    candidates,
    deleted,
    reclaimedBytes: checked.reduce((sum, entry) => sum + entry.bytes, 0),
    reverified: true,
    recoveryActions: status.recoveryActions,
  };
}

async function rebuild(gameDir: string): Promise<Record<string, unknown>> {
  const status = await makeStatus(gameDir);
  return {
    schemaVersion: DDC_STATUS_SCHEMA,
    operation: 'cold-rebuild',
    status: 'unavailable',
    gameDir: status.gameDir,
    projectDdcRoot: status.projectDdcRoot,
    error: {
      code: 'ddc-cold-rebuild-unavailable',
      detail: 'the CLI can inspect and prepare recovery but does not own a producer process',
      hint: 'start the canonical game host or producer, then rerun status to reverify',
      expected: 'an available Engine producer backed by author source',
      actual: 'no producer command was supplied to this read/write-safe CLI',
      recoveryActions: [{
        kind: 'cold-rebuild',
        executable: false,
        reason: 'delegate cold rebuild to the Engine producer; do not hand-edit DDC state',
      }],
    },
    previousStatus: status.health,
  };
}

export async function runDdcCli(args: readonly string[]): Promise<number> {
  if (args.length === 0 || args[0] === '--help' || args[0] === 'help') {
    console.log(HELP);
    return 0;
  }
  const action = args[0];
  if (action === '--version') {
    console.log(JSON.stringify({ schemaVersion: DDC_STATUS_SCHEMA }));
    return 0;
  }
  try {
    assertKnownFlags(args.slice(1));
    const gameDir = parseGame(args.slice(1));
    if (action === 'status') console.log(JSON.stringify(await makeStatus(gameDir), null, 2));
    else if (action === 'rebuild') console.log(JSON.stringify(await rebuild(gameDir), null, 2));
    else if (action === 'prune') console.log(JSON.stringify(await prune(gameDir, args.includes('--execute')), null, 2));
    else throw new Error(`unknown ddc action: ${action}`);
    return 0;
  } catch (error) {
    console.log(JSON.stringify({ schemaVersion: DDC_STATUS_SCHEMA, error: errorPayload(error) }, null, 2));
    return 1;
  }
}

if (import.meta.main) {
  runDdcCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
