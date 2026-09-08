import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_WORKTREE_JOBS,
  branchFor,
  bunInstallArgs,
  directoryFor,
  parseWorktreeOptions,
  submoduleStatusProblems,
  submoduleUpdateArgs,
} from '../worktree.ts';

describe('worktree bootstrap contract', () => {
  test('uses bounded jobs and safe defaults', () => {
    expect(parseWorktreeOptions(['feature/demo'])).toEqual({
      name: 'feature/demo',
      from: 'HEAD',
      jobs: DEFAULT_WORKTREE_JOBS,
      dryRun: false,
      noSetup: false,
      keepOnFailure: false,
    });
  });

  test('parses fast, dry-run, explicit ref, jobs, and failure-retention flags', () => {
    expect(
      parseWorktreeOptions([
        'codex/feature/demo',
        '--from=origin/main',
        '--jobs=2',
        '--fast',
        '--dry-run',
        '--keep-on-failure',
      ]),
    ).toEqual({
      name: 'codex/feature/demo',
      from: 'origin/main',
      jobs: 2,
      dryRun: true,
      noSetup: true,
      keepOnFailure: true,
    });
  });

  test('keeps the old no-setup spelling as an alias', () => {
    expect(parseWorktreeOptions(['feature/demo', '--no-setup', '--skip-setup']).noSetup).toBe(true);
  });

  test('rejects invalid job counts and missing values', () => {
    expect(() => parseWorktreeOptions(['feature/demo', '--jobs', '0'])).toThrow(
      '--jobs must be an integer from 1 to 8',
    );
    expect(() => parseWorktreeOptions(['feature/demo', '--jobs'])).toThrow('--jobs requires a value');
    expect(() => parseWorktreeOptions(['feature/demo', '--from', '--fast'])).toThrow(
      '--from requires a value',
    );
  });

  test('keeps branch and directory identities deterministic', () => {
    expect(branchFor('feature/demo')).toBe('codex/feature/demo');
    expect(branchFor('codex/feature/demo')).toBe('codex/feature/demo');
    expect(directoryFor('codex/feature/demo')).toBe('feature-demo');
  });

  test('uses shallow recursive submodule initialization with bounded parallelism', () => {
    expect(submoduleUpdateArgs(3)).toEqual([
      'submodule',
      'update',
      '--init',
      '--recursive',
      '--depth',
      '1',
      '--jobs',
      '3',
    ]);
  });

  test('adds an optional local reference without changing the shallow contract', () => {
    expect(submoduleUpdateArgs(2, '/tmp/engine-assets-reference')).toEqual([
      'submodule',
      'update',
      '--init',
      '--recursive',
      '--depth',
      '1',
      '--jobs',
      '2',
      '--reference',
      '/tmp/engine-assets-reference',
    ]);
  });

  test('detects incomplete recursive submodules', () => {
    expect(
      submoduleStatusProblems([' 1234567 packages/engine', '-abcdef0 packages/interface', '+7654321 packages/platform-io'].join('\n')),
    ).toEqual(['packages/interface', 'packages/platform-io']);
  });

  test('uses deterministic frozen Bun installation without lifecycle races', () => {
    expect(bunInstallArgs()).toEqual(['install', '--frozen-lockfile', '--ignore-scripts']);
  });
});
