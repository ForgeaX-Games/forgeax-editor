import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  authorizeDependabotLockSync,
  classifyGeneratedDiff,
  runLockSync,
} from '../dependabot-lock-sync.mjs';

const allowed = {
  eventName: "pull_request_target",
  actor: "dependabot[bot]",
  repositoryFullName: "ForgeaX-Games/forgeax-editor",
  baseRef: "main",
  headRef: "dependabot/npm_and_bun/bun-1.3.14",
  headRepositoryFullName: "ForgeaX-Games/forgeax-editor",
  ecosystem: "npm",
  changedPaths: ["package.json", "bun.lock"],
  baseRepositoryFullName: "ForgeaX-Games/forgeax-editor",
};

test('admits the trusted same-repository npm lock-sync request', () => {
  assert.deepEqual(authorizeDependabotLockSync(allowed).ok, true);
});

const deniedCases = [
  ['unauthorized actor', { actor: 'octocat' }],
  ['fork repository', { headRepositoryFullName: 'octocat/forgeax-editor' }],
  ['explicit fork flag', { headRepoFork: true }],
  ['wrong base', { baseRef: 'develop' }],
  ['wrong branch', { headRef: 'feature/lock-sync' }],
  ['wrong path', { changedPaths: ['src/index.ts'] }],
  ['wrong event', { eventName: 'pull_request' }],
  ['non-Dependabot ecosystem', { ecosystem: 'cargo' }],
  ['missing paths', { changedPaths: [] }],
];

for (const [name, override] of deniedCases) {
  test(`rejects ${name}`, () => {
    assert.equal(authorizeDependabotLockSync({ ...allowed, ...override }).ok, false);
  });
}

test('accepts nested package manifests but no arbitrary files', () => {
  assert.equal(
    authorizeDependabotLockSync({
      ...allowed,
      changedPaths: ['packages/editor-core/package.json', 'packages/engine/packages/foo/package.json', 'bun.lock'],
    }).ok,
    true,
  );
  assert.equal(authorizeDependabotLockSync({ ...allowed, changedPaths: ['packages/editor-core/src/index.ts'] }).ok, false);
});

test('classifies an empty generated status as an idempotent no-op', () => {
  assert.deepEqual(classifyGeneratedDiff([]), { ok: true, action: 'noop', paths: [] });
  assert.deepEqual(classifyGeneratedDiff([]), { ok: true, action: 'noop', paths: [] });
});

test('classifies exactly one unstaged bun.lock modification as commit work', () => {
  assert.deepEqual(classifyGeneratedDiff([' M bun.lock']), { ok: true, action: 'commit', paths: ['bun.lock'] });
});

for (const [name, status] of [
  ['manifest plus lock', [' M bun.lock', ' M package.json']],
  ['generated file', ['?? node_modules/generated.txt']],
  ['staged lock', ['M  bun.lock']],
]) {
  test(`rejects unexpected generated diff: ${name}`, () => {
    assert.equal(classifyGeneratedDiff(status).ok, false);
  });
}

function makeSpawn({ afterStatus = '', installStatus = 0, commitStatus = 0, pushStatus = 0 } = {}) {
  const calls = [];
  let statusCall = 0;
  const spawn = (cmd, args, options = {}) => {
    calls.push({ cmd, args: [...args], options });
    if (cmd === 'git' && args[0] === 'status') {
      statusCall += 1;
      return { status: 0, stdout: statusCall === 1 ? '' : afterStatus, stderr: '' };
    }
    if (cmd === 'bun' && args[0] === 'install') return { status: installStatus, stdout: '', stderr: '' };
    if (cmd === 'git' && args[0] === 'commit') return { status: commitStatus, stdout: '', stderr: '' };
    if (cmd === 'git' && args[0] === 'push') return { status: pushStatus, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, spawn };
}

test('runs Bun with scripts disabled and pushes only a lock-only commit', () => {
  const { calls, spawn } = makeSpawn({ afterStatus: ' M bun.lock' });
  const result = runLockSync({
    worktree: '/tmp/pr-head',
    ref: 'dependabot/npm_and_bun/bun-1.3.14',
    actor: 'dependabot[bot]',
    spawn,
  });
  assert.equal(result.action, 'committed');
  const install = calls.find((call) => call.cmd === 'bun');
  assert.deepEqual(install.args, ['install', '--ignore-scripts']);
  const push = calls.find((call) => call.cmd === 'git' && call.args[0] === 'push');
  assert.deepEqual(push.args, ['push', 'origin', 'HEAD:dependabot/npm_and_bun/bun-1.3.14']);
  assert.equal(push.args.includes('--force'), false);
  assert.equal(push.args.includes('--force-with-lease'), false);
});

test('rejects an unexpected generated diff without staging, committing, or pushing', () => {
  const { calls, spawn } = makeSpawn({ afterStatus: ' M bun.lock\n M package.json' });
  const result = runLockSync({
    worktree: '/tmp/pr-head',
    ref: 'dependabot/npm_and_bun/bun-1.3.14',
    actor: 'dependabot[bot]',
    spawn,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(calls.some((call) => call.cmd === 'git' && ['add', 'commit', 'push'].includes(call.args[0])), false);
});

test('a non-Dependabot sync invocation is a no-op and cannot execute a write', () => {
  const { calls, spawn } = makeSpawn({ afterStatus: ' M bun.lock' });
  const result = runLockSync({
    worktree: '/tmp/pr-head',
    ref: 'dependabot/npm_and_bun/bun-1.3.14',
    actor: 'octocat',
    spawn,
  });
  assert.equal(result.action, 'noop');
  assert.equal(calls.length, 0);
});

test('a rerun with no generated diff performs no commit or push', () => {
  const { calls, spawn } = makeSpawn({ afterStatus: '' });
  const first = runLockSync({
    worktree: '/tmp/pr-head',
    ref: 'dependabot/npm_and_bun/bun-1.3.14',
    actor: 'dependabot[bot]',
    spawn,
  });
  const second = runLockSync({
    worktree: '/tmp/pr-head',
    ref: 'dependabot/npm_and_bun/bun-1.3.14',
    actor: 'dependabot[bot]',
    spawn,
  });
  assert.equal(first.action, 'noop');
  assert.equal(second.action, 'noop');
  assert.equal(calls.some((call) => call.cmd === 'git' && ['add', 'commit', 'push'].includes(call.args[0])), false);
});

test('workflow keeps trusted-base authorization ahead of PR-head checkout/install', () => {
  const workflow = readFileSync(resolve('.github/workflows/sync-bun-lock-on-dependabot.yml'), 'utf8');
  const owner = readFileSync(resolve('scripts/ci/dependabot-lock-sync.mjs'), 'utf8');
  const trustedCheckout = workflow.indexOf('Checkout trusted base revision');
  const trustedNode = workflow.indexOf('Setup Node 22 for trusted admission');
  const changedPaths = workflow.indexOf('List changed paths from trusted base');
  const authorize = workflow.indexOf('Authorize Dependabot lock-sync request');
  const headCheckout = workflow.indexOf('Checkout PR head into isolated path');
  const sync = workflow.indexOf('Sync Bun lock from trusted owner');
  assert.ok(trustedCheckout >= 0 && trustedCheckout < trustedNode && trustedNode < changedPaths);
  assert.match(workflow, /uses: actions\/setup-node@v4/);
  assert.match(workflow, /node-version: 22/);
  assert.ok(changedPaths < authorize && authorize < headCheckout && headCheckout < sync);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /pull_request_target:/);
  assert.match(owner, /\['install', '--ignore-scripts'\]/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /--force(?:-with-lease)?\b/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /pull-requests: read/);
});

test('relative trusted-base CLI invocation executes authorization and writes its output', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-dependabot-lock-cli-'));
  try {
    const eventPath = join(root, 'event.json');
    const pathsPath = join(root, 'paths.txt');
    const outputPath = join(root, 'github-output.txt');
    writeFileSync(
      eventPath,
      JSON.stringify({
        sender: { login: 'dependabot[bot]' },
        pull_request: {
          base: { ref: 'main', repo: { full_name: 'ForgeaX-Games/forgeax-editor' } },
          head: {
            ref: 'dependabot/npm_and_bun/bun-1.3.14',
            repo: { full_name: 'ForgeaX-Games/forgeax-editor', fork: false },
          },
        },
      }),
    );
    writeFileSync(pathsPath, 'package.json\nbun.lock\n');
    const result = spawnSync(
      process.execPath,
      [
        'scripts/ci/dependabot-lock-sync.mjs',
        'authorize-event',
        '--event-path',
        eventPath,
        '--changed-paths-file',
        pathsPath,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: 'pull_request_target',
          GITHUB_ACTOR: 'dependabot[bot]',
          GITHUB_REPOSITORY: 'ForgeaX-Games/forgeax-editor',
          GITHUB_OUTPUT: outputPath,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[ok\] dependabot lock-sync admission/);
    assert.match(readFileSync(outputPath, 'utf8'), /authorized=true/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
