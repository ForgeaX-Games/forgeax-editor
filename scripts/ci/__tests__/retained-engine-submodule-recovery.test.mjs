import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

function createSubmoduleFixture() {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-retained-engine-'));
  const engineSource = join(root, 'engine-source');
  const engineRemote = join(root, 'engine.git');
  const workspace = join(root, 'workspace');
  runGit(root, ['init', engineSource]);
  runGit(engineSource, ['config', 'user.email', 'ci@example.invalid']);
  runGit(engineSource, ['config', 'user.name', 'CI fixture']);
  writeFileSync(join(engineSource, 'engine.txt'), 'engine\n');
  runGit(engineSource, ['add', 'engine.txt']);
  runGit(engineSource, ['commit', '-m', 'engine']);
  runGit(root, ['clone', '--bare', engineSource, engineRemote]);

  runGit(root, ['init', workspace]);
  runGit(workspace, ['config', 'user.email', 'ci@example.invalid']);
  runGit(workspace, ['config', 'user.name', 'CI fixture']);
  runGit(workspace, ['commit', '--allow-empty', '-m', 'root']);
  runGit(workspace, ['-c', 'protocol.file.allow=always', 'submodule', 'add', engineRemote, 'packages/engine']);
  runGit(workspace, ['commit', '-am', 'pin engine']);
  return { root, workspace };
}

function retainedEngineRecoverySteps() {
  const marker = '      - name: Recover stale engine submodule fetch lock';
  const starts = [...workflow.matchAll(new RegExp(`^${marker}$`, 'gm'))]
    .map((match) => match.index)
    .filter((index) => index !== undefined);
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? workflow.length;
    const block = workflow.slice(start, end);
    const runStart = block.indexOf('        run: |\n');
    assert.ok(runStart >= 0, 'retained Engine recovery must be an inline Bash step');
    const run = block.slice(runStart + '        run: |\n'.length);
    const nextWorkflowLine = run.search(/\n      (?=#|- name:)/);
    return run.slice(0, nextWorkflowLine < 0 ? undefined : nextWorkflowLine)
      .split('\n')
      .map((line) => line.startsWith('          ') ? line.slice(10) : line)
      .join('\n')
      .trimEnd();
  });
}

function runRecovery(workspace, script) {
  const result = spawnSync('bash', ['-c', script], {
    cwd: workspace,
    encoding: 'utf8',
    env: {...process.env, GITHUB_WORKSPACE: workspace},
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('retained Engine recovery scripts repair only an invalid gitdir before checkout', () => {
  const steps = retainedEngineRecoverySteps();
  assert.ok(steps.length > 0);
  for (const script of steps) {
    assert.match(script, /git --git-dir="\$engine_gitdir" rev-parse --verify -q 'HEAD\^\{commit\}'/);
    assert.match(script, /rm -rf -- "\$GITHUB_WORKSPACE\/packages\/engine" "\$engine_gitdir"/);
    assert.ok(script.indexOf('HEAD^{commit}') < script.indexOf('rm -rf --'));
  }
  assert.deepEqual(steps, Array(steps.length).fill(steps[0]));
  assert.doesNotMatch(workflow, /submodules:\s*recursive\s*\n\s*fetch-depth:\s*0/);
});

test('the exact workflow recovery preserves a healthy retained Engine cache', () => {
  const { root, workspace } = createSubmoduleFixture();
  try {
    const engine = join(workspace, 'packages/engine');
    const gitdir = join(workspace, '.git/modules/packages/engine');
    writeFileSync(join(engine, 'healthy-cache-sentinel'), 'preserve\n');
    const output = runRecovery(workspace, retainedEngineRecoverySteps()[0]);
    assert.equal(existsSync(gitdir), true);
    assert.equal(existsSync(join(engine, 'healthy-cache-sentinel')), true);
    assert.doesNotMatch(output, /Rebuilding invalid retained Engine/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the exact workflow recovery removes an invalid Engine gitdir and allows checkout to recreate it', () => {
  const { root, workspace } = createSubmoduleFixture();
  try {
    const engine = join(workspace, 'packages/engine');
    const gitdir = join(workspace, '.git/modules/packages/engine');
    writeFileSync(join(gitdir, 'HEAD'), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n');
    const output = runRecovery(workspace, retainedEngineRecoverySteps()[0]);
    assert.match(output, /Rebuilding invalid retained Engine submodule gitdir/);
    assert.equal(existsSync(engine), false);
    assert.equal(existsSync(gitdir), false);

    runGit(workspace, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--force', '--depth=1', '--recursive']);
    assert.equal(existsSync(engine), true);
    assert.equal(runGit(workspace, ['-C', 'packages/engine', 'rev-parse', 'HEAD']).length, 40);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
