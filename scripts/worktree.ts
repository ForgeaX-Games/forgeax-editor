#!/usr/bin/env bun
// worktree.ts — one-command, disk-conscious worktree bootstrap for the editor.
//
// `bun fx worktree <name>` creates a codex/<name> branch below .worktrees,
// initializes shallow recursive submodules, reuses the common harness when it
// exists, installs the Bun graph deterministically, and optionally runs the
// full engine setup. The operation never switches the caller's branch.

import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  acquireWorktreePortLock,
  allocateWorktreePorts,
  writeWorktreePorts,
  type PortMap,
} from './lib/worktree-ports.ts';

const HARNESS_DIR = '.forgeax-harness';
const WORKTREES_DIR = '.worktrees';
const MAX_WORKTREES = 32;
export const DEFAULT_WORKTREE_JOBS = Math.max(1, Math.min(4, availableParallelism()));
const IS_WIN = process.platform === 'win32';

const BOOTSTRAP_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
};

let bootstrapInterrupted = false;

export type WorktreeOptions = {
  readonly name: string;
  readonly from: string;
  readonly jobs: number;
  readonly dryRun: boolean;
  readonly noSetup: boolean;
  readonly keepOnFailure: boolean;
};

export type HarnessMode = 'shared' | 'sparse';

function gitOutput(args: readonly string[], cwd: string): string {
  try {
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: BOOTSTRAP_ENV,
    }).trim();
  } catch {
    return '';
  }
}

function gitStatus(args: readonly string[], cwd: string): number {
  const result = spawnSync('git', [...args], {
    cwd,
    stdio: 'ignore',
    env: BOOTSTRAP_ENV,
    shell: IS_WIN,
  });
  return result.status ?? 1;
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  label: string,
  env: NodeJS.ProcessEnv = BOOTSTRAP_ENV,
  allowInterrupted = false,
): void {
  console.log(`\n[worktree] ${label}`);
  const result = spawnSync(command, [...args], {
    cwd,
    stdio: 'inherit',
    env,
    shell: IS_WIN,
  });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (bootstrapInterrupted && !allowInterrupted) throw new Error(`${label} interrupted`);
  if (result.status !== 0) {
    throw new Error(
      `${label} failed${result.status === null ? ' (terminated by signal)' : ` (exit ${result.status ?? 1})`}`,
    );
  }
}

function installSignalGuard(): () => void {
  bootstrapInterrupted = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    bootstrapInterrupted = true;
    console.error(`[worktree] ${signal} received; stopping and cleaning the new worktree`);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function repositoryRoot(cwd: string): string {
  const root = gitOutput(['rev-parse', '--show-toplevel'], cwd);
  if (!root) throw new Error('bun fx worktree must run inside a Git checkout');
  return resolve(root);
}

function commonRepositoryRoot(root: string): string {
  const commonDir =
    gitOutput(['rev-parse', '--path-format=absolute', '--git-common-dir'], root) ||
    gitOutput(['rev-parse', '--git-common-dir'], root);
  if (!commonDir) throw new Error('could not resolve the Git common directory');
  return resolve(dirname(resolve(root, commonDir)));
}

export function parseWorktreeOptions(argv: readonly string[]): WorktreeOptions {
  const name = argv[0] ?? '';
  if (!name || name.startsWith('-')) {
    throw new Error(
      'usage: bun fx worktree <name> [--from REF] [--jobs N] [--no-setup] [--keep-on-failure] [--dry-run]',
    );
  }

  let from = 'HEAD';
  let jobs = DEFAULT_WORKTREE_JOBS;
  let dryRun = false;
  let noSetup = false;
  let keepOnFailure = false;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--dry-run' || arg === '-n') {
      dryRun = true;
    } else if (arg === '--no-setup' || arg === '--skip-setup' || arg === '--fast') {
      noSetup = true;
    } else if (arg === '--keep-on-failure') {
      keepOnFailure = true;
    } else if (arg === '--from' || arg === '--jobs') {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--from') {
        from = value;
      } else {
        jobs = parseJobs(value);
      }
    } else if (arg.startsWith('--from=')) {
      from = arg.slice('--from='.length);
      if (!from) throw new Error('--from needs a git ref');
    } else if (arg.startsWith('--jobs=')) {
      jobs = parseJobs(arg.slice('--jobs='.length));
    } else {
      throw new Error(`unknown worktree flag: ${arg}`);
    }
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes('..') || name.endsWith('/')) {
    throw new Error('worktree name must be a simple git-safe name (letters, numbers, ., _, -, /)');
  }
  if (!from) throw new Error('--from needs a git ref');
  return { name, from, jobs, dryRun, noSetup, keepOnFailure };
}

function parseJobs(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 8) {
    throw new Error('--jobs must be an integer from 1 to 8');
  }
  return Number(value);
}

export function branchFor(name: string): string {
  return name.startsWith('codex/') ? name : `codex/${name}`;
}

export function directoryFor(name: string): string {
  const slug = name
    .replace(/^codex\//, '')
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('worktree name produces an empty directory name');
  return slug;
}

export function submoduleUpdateArgs(jobs: number, reference?: string): string[] {
  return [
    'submodule',
    'update',
    '--init',
    '--recursive',
    '--depth',
    '1',
    '--jobs',
    String(jobs),
    ...(reference ? ['--reference', reference] : []),
  ];
}

export function submoduleStatusProblems(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.match(/^[-+U][0-9a-f]{7,40}\s+(.+)$/i)?.[1]?.trim() ?? '')
    .filter(Boolean);
}

function submoduleReference(commonRoot: string): string | undefined {
  const workingTree = join(commonRoot, 'packages', 'engine', 'forgeax-engine-assets');
  if (isGitCheckout(workingTree)) return workingTree;

  const commonDir =
    gitOutput(['rev-parse', '--path-format=absolute', '--git-common-dir'], commonRoot) ||
    gitOutput(['rev-parse', '--git-common-dir'], commonRoot);
  if (!commonDir) return undefined;

  // The editor pins Engine as a submodule, and Engine pins the large assets
  // repository below it. A common checkout often has that nested Git module's
  // object database even when its working tree is absent. Reusing it avoids a
  // repeated hundreds-of-megabytes fetch for every editor worktree. The
  // reference is optional and only used when the exact module exists.
  const candidate = join(
    resolve(commonRoot, commonDir),
    'modules',
    'packages',
    'engine',
    'modules',
    'forgeax-engine-assets',
  );
  if (!pathExists(join(candidate, 'objects'))) return undefined;
  return gitOutput(
    ['--git-dir', candidate, 'rev-parse', '--verify', 'HEAD'],
    commonRoot,
  )
    ? candidate
    : undefined;
}

export function bunInstallArgs(): string[] {
  // Bun has no pnpm-style --prefer-offline flag. Its global cache is reused by
  // default; frozen + no-scripts is the deterministic equivalent that also
  // avoids the known first-extract simple-git-hooks race.
  return ['install', '--frozen-lockfile', '--ignore-scripts'];
}

function worktreeCount(root: string): number {
  return gitOutput(['worktree', 'list', '--porcelain'], root)
    .split(/^worktree /m)
    .filter((entry) => entry.trim() !== '').length;
}

function isGitCheckout(path: string): boolean {
  if (!pathExists(path)) return false;
  const topLevel = gitOutput(['rev-parse', '--show-toplevel'], path);
  const head = gitOutput(['rev-parse', '--verify', 'HEAD'], path);
  if (!topLevel || !head) return false;
  try {
    return realpathSync(topLevel) === realpathSync(path);
  } catch {
    return false;
  }
}

function initializeSubmodules(targetRoot: string, jobs: number, reference?: string): void {
  run(
    'git',
    ['submodule', 'sync', '--recursive'],
    targetRoot,
    'synchronizing recursive submodule URLs',
  );

  const runShallow = (source?: string) =>
    spawnSync('git', submoduleUpdateArgs(jobs, source), {
      cwd: targetRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: BOOTSTRAP_ENV,
      shell: IS_WIN,
    });
  let shallow = runShallow(reference);
  if (bootstrapInterrupted) throw new Error('recursive submodule initialization interrupted');
  if (shallow.error) {
    throw new Error(`recursive submodule initialization could not start: ${shallow.error.message}`);
  }

  if (shallow.status !== 0 && reference) {
    // A reference is only an acceleration hint. Some Git versions cannot use
    // a nested submodule's detached module as an alternate during a recursive
    // shallow clone; retry the same bounded shallow fetch without the hint
    // before considering the slower full-depth fallback.
    console.log('[worktree] local submodule reference unavailable; retrying shallow fetch without it');
    shallow = runShallow();
    if (bootstrapInterrupted) throw new Error('recursive submodule initialization interrupted');
    if (shallow.error) {
      throw new Error(`recursive submodule initialization could not start: ${shallow.error.message}`);
    }
  }

  if (shallow.status !== 0) {
    // A shallow server or an older Git can reject the optimized fetch. Retry
    // once with one job so correctness wins without parallel full-history
    // downloads. The first attempt is captured to keep a recoverable fallback
    // from looking like an intermediate failure to the user.
    console.log('[worktree] shallow submodule fetch unavailable; retrying with one full-depth job');
    const full = spawnSync(
      'git',
      [
        'submodule',
        'update',
        '--init',
        '--recursive',
        '--jobs',
        '1',
      ],
      {
        cwd: targetRoot,
        stdio: 'inherit',
        env: BOOTSTRAP_ENV,
        shell: IS_WIN,
      },
    );
    if (bootstrapInterrupted) throw new Error('recursive submodule initialization interrupted');
    if (full.error) {
      throw new Error(`recursive submodule fallback could not start: ${full.error.message}`);
    }
    if (full.status !== 0) {
      const shallowDetail = `${shallow.stderr ?? ''}`.trim().replace(/\s+/g, ' ');
      throw new Error(
        `recursive submodule initialization failed${shallowDetail ? ` (shallow: ${shallowDetail})` : ''}`,
      );
    }
  }

  const status = spawnSync('git', ['submodule', 'status', '--recursive'], {
    cwd: targetRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: BOOTSTRAP_ENV,
    shell: IS_WIN,
  });
  if (bootstrapInterrupted) throw new Error('recursive submodule status check interrupted');
  const problems = submoduleStatusProblems(String(status.stdout ?? ''));
  if ((status.status ?? 1) !== 0 || problems.length > 0) {
    throw new Error(
      `recursive submodule initialization is incomplete${problems.length > 0 ? `: ${problems.join(', ')}` : ''}`,
    );
  }
}

function initializeHarnessPlan(commonRoot: string): HarnessMode {
  return isGitCheckout(join(commonRoot, HARNESS_DIR)) ? 'shared' : 'sparse';
}

function initializeHarness(targetRoot: string, commonRoot: string): HarnessMode {
  const targetHarness = join(targetRoot, HARNESS_DIR);
  if (pathExists(targetHarness)) throw new Error(`harness target already exists: ${targetHarness}`);

  const sharedHarness = join(commonRoot, HARNESS_DIR);
  if (isGitCheckout(sharedHarness)) {
    const link = relative(dirname(targetHarness), sharedHarness) || '.';
    symlinkSync(link, targetHarness, 'dir');
    return 'shared';
  }

  run(
    'node',
    ['scripts/sync-harness.mjs'],
    targetRoot,
    'materializing sparse .forgeax-harness (docs only; no full clone)',
    { ...BOOTSTRAP_ENV, FORGEAX_HARNESS_SPARSE_DOCS: '1' },
  );
  if (!isGitCheckout(targetHarness)) {
    throw new Error('sparse .forgeax-harness initialization completed without a Git checkout');
  }
  return 'sparse';
}

function installDependencies(targetRoot: string): void {
  run(
    'bun',
    bunInstallArgs(),
    targetRoot,
    'installing frozen Bun workspace dependencies (lifecycle scripts skipped)',
    {
      ...BOOTSTRAP_ENV,
      FORGEAX_SKIP_HARNESS_SYNC: '1',
      SKIP_INSTALL_SIMPLE_GIT_HOOKS: '1',
    },
  );
  run('node', ['scripts/sync-radix-hoist.mjs'], targetRoot, 'repairing Bun radix resolution links');
}

function setupEnvironment(): NodeJS.ProcessEnv {
  return {
    ...BOOTSTRAP_ENV,
    // The frozen install above already materialized the editor graph. Avoid a
    // second Bun install inside fx setup; setup still owns engine pnpm deps,
    // wasm, dist, and declaration artifacts.
    FORGEAX_SKIP_EDITOR_BUN_INSTALL: '1',
    FORGEAX_SKIP_HARNESS_SYNC: '1',
    SKIP_INSTALL_SIMPLE_GIT_HOOKS: '1',
  };
}

function removeCreatedWorktree(root: string, targetRoot: string, branch: string): void {
  if (pathExists(targetRoot)) {
    run(
      'git',
      ['worktree', 'remove', '--force', targetRoot],
      root,
      'removing failed worktree',
      BOOTSTRAP_ENV,
      true,
    );
  }
  if (gitStatus(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], root) === 0) {
    run('git', ['branch', '-D', branch], root, 'removing failed worktree branch', BOOTSTRAP_ENV, true);
  }
}

function portSummary(ports: PortMap): string {
  return [
    `host       http://localhost:${ports.standalone}`,
    `edit       :${ports.editRuntime}`,
    `game API   :${ports.gameApi}`,
    `play       :${ports.playRuntime}`,
    `RHI        :${ports.rhiReviewer}`,
    `gateway    :${ports.bridge}`,
  ].join('\n  ');
}

function printReady(
  targetRoot: string,
  branch: string,
  harnessMode: HarnessMode,
  allocation: { readonly slot: number; readonly ports: PortMap },
  noSetup: boolean,
): void {
  console.log('\n[worktree] ready');
  console.log(`  path       ${targetRoot}`);
  console.log(`  branch     ${branch}`);
  console.log(
    `  harness    ${harnessMode === 'shared' ? 'shared common clone (no disk copy)' : 'sparse docs clone'}`,
  );
  console.log(`  setup      ${noSetup ? 'skipped (--no-setup/--fast)' : 'engine dist and wasm ready'}`);
  console.log(`  port slot  ${allocation.slot}`);
  console.log(`  ${portSummary(allocation.ports)}`);
  if (noSetup) console.log('  note       run bun fx setup before bun fx ci or browser work');
  console.log(`\nNext:\n  cd ${targetRoot}\n  bun fx start              # Edit mode with HMR\n  bun fx start --play       # also start Play runtime`);
  console.log(`\nRemove later with:\n  bun fx stop\n  git worktree remove ${targetRoot}`);
}

function printDryRun(
  targetRoot: string,
  branch: string,
  options: WorktreeOptions,
  harnessMode: HarnessMode,
  allocation: { readonly slot: number; readonly ports: PortMap },
  reference?: string,
): void {
  console.log(`[dry-run] git worktree add -b ${branch} ${targetRoot} ${options.from}`);
  console.log('[dry-run] git submodule sync --recursive');
  console.log(
    `[dry-run] git submodule update --init --recursive --depth 1 --jobs ${options.jobs}${reference ? ` --reference ${reference}` : ''}`,
  );
  console.log(
    `[dry-run] harness: ${harnessMode === 'shared' ? 'relative symlink to common clone' : 'sparse docs clone'}`,
  );
  console.log(`[dry-run] bun ${bunInstallArgs().join(' ')}`);
  if (!options.noSetup) console.log('[dry-run] bun fx setup (reuse the frozen editor install)');
  console.log(`[dry-run] port slot ${allocation.slot} (${allocation.ports.standalone})`);
}

export async function createWorktree(argv: readonly string[], sourceRoot = process.cwd()): Promise<void> {
  const options = parseWorktreeOptions(argv);
  const checkoutRoot = repositoryRoot(sourceRoot);
  const root = commonRepositoryRoot(checkoutRoot);
  const reference = submoduleReference(root);
  const branch = branchFor(options.name);
  const targetRoot = join(root, WORKTREES_DIR, directoryFor(options.name));

  if (pathExists(targetRoot)) throw new Error(`worktree directory already exists: ${targetRoot}`);
  if (gitStatus(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], root) === 0) {
    throw new Error(`branch already exists: ${branch} (choose another name)`);
  }
  if (gitStatus(['rev-parse', '--verify', `${options.from}^{commit}`], checkoutRoot) !== 0) {
    throw new Error(`git ref does not resolve to a commit: ${options.from}`);
  }
  const count = worktreeCount(root);
  if (count >= MAX_WORKTREES) {
    throw new Error(
      `refusing to create another worktree: ${count} are already registered (limit ${MAX_WORKTREES}); remove unused worktrees first`,
    );
  }

  mkdirSync(join(root, WORKTREES_DIR), { recursive: true });
  const releaseLock = acquireWorktreePortLock(root);
  try {
    const allocation = await allocateWorktreePorts(root);
    const harnessMode = initializeHarnessPlan(root);
    if (options.dryRun) {
      printDryRun(targetRoot, branch, options, harnessMode, allocation, reference);
      return;
    }

    if (gitOutput(['status', '--porcelain'], checkoutRoot)) {
      console.log('[worktree] source checkout has uncommitted changes; only the selected git ref will be copied');
    }

    let created = false;
    const removeSignalGuard = installSignalGuard();
    try {
      run('git', ['worktree', 'add', '-b', branch, targetRoot, options.from], checkoutRoot, `creating ${branch}`);
      created = true;
      writeWorktreePorts(targetRoot, allocation.ports);
      const actualHarnessMode = initializeHarness(targetRoot, root);
      initializeSubmodules(targetRoot, options.jobs, reference);
      installDependencies(targetRoot);
      if (options.noSetup) {
        console.log('[worktree] skipping engine setup (--no-setup/--fast)');
      } else {
        run('bun', ['fx', 'setup'], targetRoot, 'building engine dist and wasm artifacts', setupEnvironment());
      }
      printReady(targetRoot, branch, actualHarnessMode, allocation, options.noSetup);
    } catch (error) {
      if (created && !options.keepOnFailure) {
        try {
          removeCreatedWorktree(root, targetRoot, branch);
        } catch (cleanupError) {
          console.error(
            `[worktree] automatic cleanup failed; inspect ${targetRoot}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }
      } else if (created) {
        console.error(`[worktree] bootstrap stopped; keeping ${targetRoot} for inspection`);
      }
      throw error;
    } finally {
      removeSignalGuard();
    }
  } finally {
    releaseLock();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createWorktree(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`[worktree] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
