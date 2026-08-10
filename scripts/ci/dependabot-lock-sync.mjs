#!/usr/bin/env node
// Trusted-base owner for the Editor's Dependabot Bun lock synchronization.
// This file is invoked from the trusted base checkout. The workflow must finish
// authorization here before it checks out or installs the PR head.

import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const DEPENDABOT_ACTOR = 'dependabot[bot]';
export const TRUSTED_EVENT = 'pull_request_target';
export const TRUSTED_BASE = 'main';
export const COMMIT_MESSAGE = 'chore(deps): sync bun.lock for dependabot bump';
export const COMMIT_AUTHOR_NAME = 'github-actions[bot]';
export const COMMIT_AUTHOR_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
export const NPM_BUN_BRANCH = /^dependabot\/npm_and_bun\/.+$/;

const ALLOWED_PACKAGE_MANIFEST = /^packages\/(?:[^/]+\/)*package\.json$/;

function deny(code, detail) {
  return { ok: false, code, reason: `${code}: ${detail}` };
}

function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

export function isAllowedChangedPath(path) {
  return path === 'bun.lock' || path === 'package.json' || ALLOWED_PACKAGE_MANIFEST.test(path);
}

/**
 * Admit only the exact trusted Dependabot shape. This is deliberately pure so
 * the workflow's security boundary can be tested without GitHub or a checkout.
 */
export function authorizeDependabotLockSync(request) {
  if (!request || typeof request !== 'object') return deny('invalid-request', 'request is not an object');
  if (request.eventName !== TRUSTED_EVENT) return deny('event-not-allowed', request.eventName || '<missing>');
  if (request.actor !== DEPENDABOT_ACTOR) return deny('actor-not-allowed', request.actor || '<missing>');

  const repository = stringValue(request.repositoryFullName);
  const baseRepository = stringValue(request.baseRepositoryFullName || repository);
  const headRepository = stringValue(request.headRepositoryFullName);
  if (!repository || baseRepository !== repository || headRepository !== repository) {
    return deny('repository-not-trusted', `${baseRepository || '<missing>'} -> ${headRepository || '<missing>'}`);
  }
  if (request.headRepoFork === true) return deny('fork-not-allowed', 'head repository is a fork');
  if (request.baseRef !== TRUSTED_BASE) return deny('base-not-allowed', request.baseRef || '<missing>');

  const headRef = stringValue(request.headRef);
  if (!NPM_BUN_BRANCH.test(headRef)) return deny('branch-not-allowed', headRef || '<missing>');
  if (request.ecosystem !== undefined && request.ecosystem !== 'npm') {
    return deny('ecosystem-not-allowed', request.ecosystem || '<missing>');
  }

  if (!Array.isArray(request.changedPaths) || request.changedPaths.length === 0) {
    return deny('paths-missing', 'changed path list is empty');
  }
  const unexpectedPaths = request.changedPaths.filter((path) => !isAllowedChangedPath(path));
  if (unexpectedPaths.length > 0) {
    return deny('paths-not-allowed', unexpectedPaths.join(', '));
  }

  return { ok: true, reason: 'trusted Dependabot npm lock-sync request' };
}

export function requestFromGithubEvent({ event, eventName, actor, repositoryFullName, changedPaths }) {
  const pullRequest = event?.pull_request;
  return {
    eventName,
    actor: actor || event?.sender?.login || '',
    repositoryFullName,
    baseRepositoryFullName: pullRequest?.base?.repo?.full_name || '',
    baseRef: pullRequest?.base?.ref || '',
    headRepositoryFullName: pullRequest?.head?.repo?.full_name || '',
    headRepoFork: pullRequest?.head?.repo?.fork === true,
    headRef: pullRequest?.head?.ref || '',
    changedPaths,
  };
}

function parsePorcelainLine(line) {
  if (typeof line !== 'string' || line.length < 4) return null;
  return { status: line.slice(0, 2), path: line.slice(3) };
}

export function parsePorcelainStatus(output = '') {
  return String(output)
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map(parsePorcelainLine);
}

/**
 * Only an unstaged modification of the root bun.lock may be generated. An
 * empty status is a successful no-op, which makes retries idempotent.
 */
export function classifyGeneratedDiff(statusLines) {
  if (!Array.isArray(statusLines)) return deny('invalid-diff', 'status is not an array');
  const entries = statusLines.map(parsePorcelainLine);
  if (entries.some((entry) => entry === null)) return deny('invalid-diff', 'malformed porcelain status');
  if (entries.length === 0) return { ok: true, action: 'noop', paths: [] };

  const unexpected = entries.filter((entry) => entry.status !== ' M' || entry.path !== 'bun.lock');
  if (unexpected.length > 0) {
    return deny(
      'unexpected-generated-diff',
      unexpected.map((entry) => `${entry.status} ${entry.path}`).join(', '),
    );
  }
  return { ok: true, action: 'commit', paths: ['bun.lock'] };
}

function defaultSpawn(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

function commandFailed(result) {
  return !result || result.error || result.status !== 0;
}

function run(command, args, cwd, spawn, stdio = 'inherit') {
  return spawn(command, args, { cwd, encoding: 'utf8', stdio });
}

function failedSync(exitCode, reason) {
  return { exitCode, action: 'failed', reason };
}

/**
 * Run only after the trusted authorization step. All commands operate in the
 * isolated PR-head worktree while this module remains loaded from base.
 */
export function runLockSync({ worktree, ref, actor, spawn = defaultSpawn }) {
  if (actor !== DEPENDABOT_ACTOR) return { exitCode: 0, action: 'noop', reason: 'actor denied' };
  if (!NPM_BUN_BRANCH.test(ref || '')) return { exitCode: 0, action: 'noop', reason: 'branch denied' };

  const before = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], worktree, spawn, 'pipe');
  if (commandFailed(before)) return failedSync(1, 'could not inspect PR-head worktree');
  if (parsePorcelainStatus(before.stdout).length > 0) return failedSync(1, 'PR-head worktree was not clean');

  const install = run('bun', ['install', '--ignore-scripts'], worktree, spawn);
  if (commandFailed(install)) return failedSync(1, 'bun install --ignore-scripts failed');

  const after = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], worktree, spawn, 'pipe');
  if (commandFailed(after)) return failedSync(1, 'could not inspect generated diff');
  const plan = classifyGeneratedDiff(
    String(after.stdout ?? '')
      .split(/\r?\n/)
      .filter((line) => line.length > 0),
  );
  if (!plan.ok) return failedSync(1, plan.reason);
  if (plan.action === 'noop') return { exitCode: 0, action: 'noop', reason: 'bun.lock already synchronized' };

  const add = run('git', ['add', '--', 'bun.lock'], worktree, spawn);
  if (commandFailed(add)) return failedSync(1, 'could not stage bun.lock');
  const commit = run(
    'git',
    [
      '-c',
      `user.name=${COMMIT_AUTHOR_NAME}`,
      '-c',
      `user.email=${COMMIT_AUTHOR_EMAIL}`,
      'commit',
      '-m',
      COMMIT_MESSAGE,
      '--',
      'bun.lock',
    ],
    worktree,
    spawn,
  );
  if (commandFailed(commit)) return failedSync(1, 'could not commit bun.lock');

  const push = run('git', ['push', 'origin', `HEAD:${ref}`], worktree, spawn);
  if (commandFailed(push)) return failedSync(1, 'could not push bun.lock synchronization');
  return { exitCode: 0, action: 'committed', reason: 'bun.lock synchronized and pushed' };
}

function argumentValue(argv, name, fallback = '') {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function readChangedPaths(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function writeGithubOutput(result, outputPath) {
  if (!outputPath) return;
  const reason = String(result.reason || '').replace(/[\r\n]/g, ' ');
  appendFileSync(outputPath, `authorized=${result.ok ? 'true' : 'false'}\nreason=${reason}\n`);
}

export function main(argv = process.argv.slice(2), env = process.env, spawn = defaultSpawn) {
  const command = argv[0] || '';
  if (command === 'authorize-event') {
    const eventPath = argumentValue(argv, '--event-path', env.GITHUB_EVENT_PATH);
    const pathsPath = argumentValue(argv, '--changed-paths-file');
    if (!eventPath || !pathsPath) throw new Error('authorize-event needs --event-path and --changed-paths-file');
    const event = JSON.parse(readFileSync(eventPath, 'utf8'));
    const request = requestFromGithubEvent({
      event,
      eventName: env.GITHUB_EVENT_NAME || '',
      actor: env.GITHUB_ACTOR || '',
      repositoryFullName: env.GITHUB_REPOSITORY || '',
      changedPaths: readChangedPaths(pathsPath),
    });
    const result = authorizeDependabotLockSync(request);
    writeGithubOutput(result, env.GITHUB_OUTPUT);
    process.stdout.write(`${result.ok ? '[ok]' : '[skip]'} dependabot lock-sync admission: ${result.reason}\n`);
    return 0;
  }

  if (command === 'sync') {
    const result = runLockSync({
      worktree: argumentValue(argv, '--worktree', process.cwd()),
      ref: argumentValue(argv, '--ref', env.GITHUB_HEAD_REF),
      actor: env.GITHUB_ACTOR || '',
      spawn,
    });
    process.stdout.write(`[${result.action}] dependabot lock-sync: ${result.reason}\n`);
    return result.exitCode;
  }

  process.stderr.write(
    'Usage: node scripts/ci/dependabot-lock-sync.mjs authorize-event --event-path <path> --changed-paths-file <path>\n' +
      '       node scripts/ci/dependabot-lock-sync.mjs sync --worktree <path> --ref <branch>\n',
  );
  return 2;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`[reason] dependabot lock-sync owner: ${error.message ?? error}\n`);
    process.exit(1);
  }
}
