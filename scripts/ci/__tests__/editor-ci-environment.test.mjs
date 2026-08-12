import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  assertBunVersion,
  buildEnvironmentRecord,
  environmentFingerprint,
  runEnvironmentCheck,
  assertRunnerContract,
} from '../editor-ci-environment.mjs';

test('environment fingerprint includes the runner and toolchain contract', () => {
  const base = buildEnvironmentRecord({
    runner: 'runner-a',
    pool: 'standard',
    runnerOs: 'Linux',
    runnerArch: 'X64',
    osRelease: 'Ubuntu 22.04.5 LTS',
    platform: 'linux 6.1',
    arch: 'x64',
    bun: '1.3.14',
    bunRevision: '1.3.14+revision-a',
    node: '22.13.0',
    configuredNode: '22.13.0',
    configuredPnpm: '11.7.0',
    configuredRust: '1.93',
    configuredWasmPack: '0.14.0',
    compilerCommand: 'gcc-11',
    compiler: 'Apple clang 21',
    cpuModel: 'cpu-a',
    cpuCount: 8,
    memoryBytes: 16 * 1024 ** 3,
  });
  const same = { ...base };
  const differentRunner = { ...base, runner: 'runner-b' };
  const differentBun = { ...base, bun: '1.3.15' };
  const differentBunRevision = { ...base, bunRevision: '1.3.14+revision-b' };
  const differentRust = { ...base, configuredRust: '1.94' };
  const differentCompilerCommand = { ...base, compilerCommand: 'clang' };
  const differentCompiler = { ...base, compiler: 'gcc 14' };

  assert.equal(environmentFingerprint(base), environmentFingerprint(same));
  assert.notEqual(environmentFingerprint(base), environmentFingerprint(differentRunner));
  assert.notEqual(environmentFingerprint(base), environmentFingerprint(differentBun));
  assert.notEqual(environmentFingerprint(base), environmentFingerprint(differentBunRevision));
  assert.notEqual(environmentFingerprint(base), environmentFingerprint(differentRust));
  assert.notEqual(environmentFingerprint(base), environmentFingerprint(differentCompilerCommand));
  assert.notEqual(environmentFingerprint(base), environmentFingerprint(differentCompiler));
});

test('Bun version mismatch is a structured environment failure', () => {
  assert.throws(
    () => assertBunVersion('1.3.15', '1.3.14'),
    (error) => error.code === 'ci-environment-bun-mismatch',
  );
});

test('strict runner contract rejects a non-Linux or non-X64 CI host', () => {
  assert.throws(
    () => assertRunnerContract({ runnerOs: 'Darwin', runnerArch: 'ARM64', pool: 'standard' }, { strict: true }),
    (error) => error.code === 'ci-environment-contract-mismatch',
  );
});

test('environment check accepts the pinned Bun contract', () => {
  const result = runEnvironmentCheck({
    env: {
      CI_BUN_VERSION: '1.3.14',
      BUN_VERSION: '1.3.14',
      CI_BUN_REVISION: '1.3.14+revision-a',
      CI_RUNNER_POOL: 'standard',
      RUNNER_NAME: 'runner-a',
      RUNNER_OS: 'Linux',
      RUNNER_ARCH: 'X64',
      CI_OS_RELEASE: 'Ubuntu 22.04.5 LTS',
      CI_COMPILER_COMMAND: 'gcc-11',
      GITHUB_ACTIONS: 'true',
      GITHUB_SHA: 'a'.repeat(40),
      GITHUB_EVENT_NAME: 'push',
    },
  });
  assert.equal(result.record.bun, '1.3.14');
  assert.equal(result.record.bunRevision, '1.3.14+revision-a');
  assert.equal(result.record.pool, 'standard');
  assert.equal(result.record.osRelease, 'Ubuntu 22.04.5 LTS');
  assert.equal(result.record.compilerCommand, 'gcc-11');
  assert.match(result.fingerprint, /^[0-9a-f]{16}$/);
});

test('CI workflow routes build pools through the pinned environment action', () => {
  const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /CI_BUN_VERSION:\s+1\.3\.14/);
  assert.match(workflow, /CI_NODE_VERSION:\s+22\.13\.0/);
  assert.match(workflow, /CI_PNPM_VERSION:\s+11\.7\.0/);
  assert.match(workflow, /CI_RUST_TOOLCHAIN:\s+'1\.93'/);
  assert.match(workflow, /CI_WASM_PACK_VERSION:\s+0\.14\.0/);
  assert.doesNotMatch(workflow, /bun-version:\s*latest/);
  assert.doesNotMatch(workflow, /^\s*run:\s*bun\b/m);
  assert.match(workflow, /run: '\"\$CI_BUN_PATH\" run test:scripts'/);
  assert.match(workflow, /run: '\"\$CI_BUN_PATH\" scripts\/selfcheck-standalone-b2\.mjs'/);
  assert.equal(
    workflow.match(/uses:\s+\.\/\.github\/actions\/editor-ci-environment/g)?.length,
    3,
  );
  assert.equal(
    workflow.match(/key:\s+engine-dist-.*steps\.ci-environment\.outputs\.fingerprint.*steps\.engine\.outputs\.sha/g)?.length,
    3,
  );
  const environmentAction = readFileSync(resolve('.github/actions/editor-ci-environment/action.yml'), 'utf8');
  assert.match(environmentAction, /HOME=\$state_root\/home/);
  assert.match(environmentAction, /export HOME="\$state_root\/home"/);
  assert.match(environmentAction, /BUN_INSTALL=\$state_root\/home\/\.bun/);
  assert.match(environmentAction, /echo "\$state_root\/home\/\.bun\/bin" >> "\$GITHUB_PATH"/);
  assert.match(environmentAction, /expected_bun_version="\$\{\{ inputs\.bun-version \}\}"/);
  assert.match(environmentAction, /actual_bun_version="\$\(bun --version\)"/);
  assert.match(environmentAction, /bun_shim_dir="\$\{BUN_INSTALL%\/.bun\}\/bun-bin"/);
  assert.match(environmentAction, /ln -s "\$bun_path" "\$bun_shim_dir\/bun"/);
  assert.match(environmentAction, /printf 'PATH=%s:%s\\n' "\$bun_shim_dir" "\$PATH" >> "\$GITHUB_ENV"/);
  assert.match(environmentAction, /BUN_RUNTIME_TRANSPILER_CACHE_PATH=\$state_root\/bun-runtime-cache/);
  assert.match(environmentAction, /short_tmp_root="\/tmp\/fxci-/);
  assert.match(environmentAction, /TMPDIR=\$short_tmp_root/);
  assert.doesNotMatch(environmentAction, /TMPDIR=\$state_root\/tmp/);
  assert.doesNotMatch(environmentAction, /g\+\+-11/);
  assert.match(environmentAction, /CI_OS_RELEASE=/);
  assert.match(environmentAction, /Verify isolated Bun runtime/);
});
