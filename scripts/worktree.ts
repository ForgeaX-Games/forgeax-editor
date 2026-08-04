#!/usr/bin/env bun
// worktree.ts — one-command worktree creation for the standalone editor.
//
// `bun fx worktree <name>` creates a codex/<name> branch below .worktrees,
// initializes every recursive submodule, installs the Bun workspace, runs the
// full engine setup, and persists an isolated port slot for that checkout.
// The operation never switches the current checkout's branch.

import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  acquireWorktreePortLock,
  allocateWorktreePorts,
  writeWorktreePorts,
  type PortMap,
} from './lib/worktree-ports.ts';

const IS_WIN = process.platform === 'win32';

type Options = {
  readonly name: string;
  readonly from: string;
  readonly skipSetup: boolean;
};

function gitOutput(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function gitStatus(args: string[], cwd: string): number {
  const result = spawnSync('git', args, { cwd, stdio: 'ignore', shell: IS_WIN });
  return result.status ?? 1;
}

function run(command: string, args: string[], cwd: string, label: string): void {
  console.log(`\n[worktree] ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: IS_WIN,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed${result.status === null ? ' (terminated by signal)' : ` (exit ${result.status})`}`);
  }
}

function parseOptions(argv: string[]): Options {
  const name = argv[0] ?? '';
  if (!name || name.startsWith('-')) throw new Error('usage: bun fx worktree <name> [--from REF] [--no-setup]');

  let from = 'HEAD';
  let skipSetup = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--no-setup' || arg === '--skip-setup') {
      skipSetup = true;
    } else if (arg === '--from') {
      from = argv[++i] ?? '';
      if (!from) throw new Error('--from needs a git ref');
    } else if (arg.startsWith('--from=')) {
      from = arg.slice('--from='.length);
      if (!from) throw new Error('--from needs a git ref');
    } else {
      throw new Error(`unknown worktree flag: ${arg}`);
    }
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes('..') || name.endsWith('/')) {
    throw new Error('worktree name must be a simple git-safe name (letters, numbers, ., _, -, /)');
  }
  return { name, from, skipSetup };
}

function branchFor(name: string): string {
  return name.startsWith('codex/') ? name : `codex/${name}`;
}

function directoryFor(name: string): string {
  const slug = name
    .replace(/^codex\//, '')
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('worktree name produces an empty directory name');
  return slug;
}

function repositoryRoot(cwd: string): string {
  const currentRoot = gitOutput(['rev-parse', '--show-toplevel'], cwd);
  const commonDir = gitOutput(['rev-parse', '--git-common-dir'], cwd);
  if (!currentRoot || !commonDir) throw new Error('not inside a git checkout');
  return dirname(resolve(currentRoot, commonDir));
}

function isExistingPath(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
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

function runInstall(target: string): void {
  try {
    run('bun', ['install'], target, 'installing Bun workspace dependencies');
  } catch (error) {
    // The repository documents a one-time simple-git-hooks extraction race;
    // retrying here makes the one-click path recover without user intervention.
    console.warn(`[worktree] first bun install failed; retrying once: ${error instanceof Error ? error.message : String(error)}`);
    run('bun', ['install'], target, 'retrying Bun workspace installation');
  }
}

export async function createWorktree(argv: string[]): Promise<void> {
  const options = parseOptions(argv);
  const cwd = process.cwd();
  const root = repositoryRoot(cwd);
  const branch = branchFor(options.name);
  const dirName = directoryFor(options.name);
  const target = join(root, '.worktrees', dirName);

  if (isExistingPath(target)) throw new Error(`worktree directory already exists: ${target}`);
  if (gitStatus(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], cwd) === 0) {
    throw new Error(`branch already exists: ${branch} (choose another name)`);
  }
  if (gitStatus(['rev-parse', '--verify', `${options.from}^{commit}`], cwd) !== 0) {
    throw new Error(`git ref does not resolve to a commit: ${options.from}`);
  }

  const dirty = gitOutput(['status', '--porcelain'], cwd) !== '';
  if (dirty) {
    console.warn('[worktree] source checkout has uncommitted changes; only the selected git ref will be copied.');
  }

  mkdirSync(join(root, '.worktrees'), { recursive: true });
  const releaseLock = acquireWorktreePortLock(root);
  try {
    const allocation = await allocateWorktreePorts(root);
    run('git', ['worktree', 'add', '-b', branch, target, options.from], cwd, `creating ${branch}`);
    writeWorktreePorts(target, allocation.ports);

    run('git', ['submodule', 'update', '--init', '--recursive'], target, 'initializing recursive submodules');
    runInstall(target);
    if (options.skipSetup) {
      console.log('[worktree] skipping engine setup (--no-setup).');
    } else {
      run('bun', ['fx', 'setup'], target, 'building engine dist and wasm artifacts');
    }

    console.log(`\n[worktree] ready\n  path       ${target}\n  branch     ${branch}\n  port slot  ${allocation.slot}\n  ${portSummary(allocation.ports)}\n\nNext:\n  cd ${target}\n  bun fx start              # Edit mode with HMR\n  bun fx start --play       # also start Play runtime\n\nRemove later with:\n  git worktree remove ${target}`);
  } catch (error) {
    console.error(`[worktree] created path may need attention: ${target}`);
    throw error;
  } finally {
    releaseLock();
  }
}

if (import.meta.main) {
  createWorktree(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`[worktree] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
