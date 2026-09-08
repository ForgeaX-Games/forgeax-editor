import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {tmpdir} from 'node:os';
import {
  flattenCollection,
  hydrateEngineArtifact,
  installCoreArtifact,
  selectCoreArtifact,
  selectEngineRun,
  verifyEngineArtifact,
} from '../hydrate-engine-artifact.mjs';

const engineSha = 'a'.repeat(40);

function tempRoot(name) {
  return mkdtempSync(join(tmpdir(), `forgeax-${name}-`));
}

function writeArtifactFixture(root) {
  const files = {
    'packages/core/dist/index.mjs': 'export {}\n',
    'packages/core/dist/index.d.ts': 'export {};\n',
    'packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm': 'wasm\n',
    'packages/fbx/pkg/fbx.mjs': 'export {}\n',
  };
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(join(target, '..'), {recursive: true});
    writeFileSync(target, content);
  }
}

test('flattenCollection preserves every page from gh api slurp output', () => {
  assert.deepEqual(
    flattenCollection([
      {workflow_runs: [{id: 1}]},
      {workflow_runs: [{id: 2}]},
    ], 'workflow_runs'),
    [{id: 1}, {id: 2}],
  );
});

test('selectEngineRun requires a successful exact-SHA run of the Engine CI workflow', () => {
  const run = selectEngineRun({
    engineSha,
    runs: [
      {id: 1, path: '.github/workflows/ci.yml', head_sha: engineSha, status: 'completed', conclusion: 'failure'},
      {id: 2, path: '.github/workflows/other.yml', head_sha: engineSha, status: 'completed', conclusion: 'success'},
      {id: 3, path: '.github/workflows/ci.yml', head_sha: engineSha, status: 'completed', conclusion: 'success', run_started_at: '2026-08-19T10:00:00Z'},
      {id: 4, path: '.github/workflows/ci.yml', head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'success'},
    ],
  });
  assert.equal(run?.id, 3);
});

test('selectCoreArtifact prefers the canonical artifact and rejects expired transfer artifacts', () => {
  const run = {run_attempt: 2};
  const artifact = selectCoreArtifact({
    run,
    artifacts: [
      {id: 10, name: 'core-build-a2-retry-1-a2', expired: false},
      {id: 11, name: 'core-build-a2', expired: true},
      {id: 12, name: 'core-build-a2', expired: false},
      {id: 13, name: 'core-build-a1', expired: false},
    ],
  });
  assert.equal(artifact?.id, 12);
});

test('installCoreArtifact copies only the Engine artifact payload and verifies the consumer layout', () => {
  const root = tempRoot('engine-artifact');
  try {
    const artifactRoot = join(root, 'download');
    const engineRoot = join(root, 'engine');
    writeArtifactFixture(artifactRoot);

    const layout = installCoreArtifact({artifactRoot, engineRoot});
    assert.deepEqual(layout, {packageCount: 1, esmCount: 1, declarationCount: 1});
    assert.equal(
      readFileSync(join(engineRoot, 'packages/core/dist/index.d.ts'), 'utf8'),
      'export {};\n',
    );
    assert.deepEqual(verifyEngineArtifact({engineRoot}), layout);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('verifyEngineArtifact fails closed when a required runtime or declaration family is absent', () => {
  const root = tempRoot('invalid-engine-artifact');
  try {
    mkdirSync(join(root, 'packages/core/dist'), {recursive: true});
    writeFileSync(join(root, 'packages/core/dist/index.mjs'), 'export {}\n');
    assert.throws(
      () => verifyEngineArtifact({engineRoot: root}),
      (error) => error.code === 'engine-artifact-layout-invalid',
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('hydrateEngineArtifact selects the exact Engine run and cleans its download staging', () => {
  const root = tempRoot('hydrate-engine-artifact');
  const engineRoot = join(root, 'engine');
  const calls = [];
  const run = {
    id: 42,
    path: '.github/workflows/ci.yml',
    head_sha: engineSha,
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
  };
  try {
    const summary = hydrateEngineArtifact({
      cwd: root,
      engineRoot,
      runCommand(command, args) {
        calls.push({command, args});
        if (command === 'git') return `${engineSha}\n`;
        if (command === 'gh' && args[0] === 'api' && args.some((arg) => arg.includes('/actions/runs?'))) {
          return `${JSON.stringify(run)}\n`;
        }
        if (command === 'gh' && args[0] === 'api' && args.some((arg) => arg.includes('/artifacts?'))) {
          return `${JSON.stringify({id: 99, name: 'core-build-a1', expired: false})}\n`;
        }
        if (command === 'gh' && args[0] === 'run' && args[1] === 'download') {
          const downloadDir = args[args.indexOf('--dir') + 1];
          writeArtifactFixture(downloadDir);
          return '';
        }
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      },
    });

    assert.equal(summary.engineRunId, 42);
    assert.equal(summary.artifactId, 99);
    assert.equal(summary.artifactName, 'core-build-a1');
    assert.deepEqual(summary.layout, {packageCount: 1, esmCount: 1, declarationCount: 1});
    assert.equal(existsSync(join(engineRoot, 'packages/core/dist/index.d.ts')), true);
    assert.equal(calls.filter(({command}) => command === 'gh').length, 3);
    const downloadCall = calls.find(({command, args}) => command === 'gh' && args[1] === 'download');
    assert.ok(downloadCall);
    const downloadDir = downloadCall.args[downloadCall.args.indexOf('--dir') + 1];
    assert.equal(existsSync(downloadDir), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
