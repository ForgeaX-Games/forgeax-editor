import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { BUN_EXECUTABLE } from '../ci/bun-runtime.mjs';
import { isHarnessSyncFailure, isSimpleGitHooksEnoent } from '../lib/setup-process.ts';
import {
  createSetupEnvelope,
  formatSetupEnvelope,
  projectSetupCommandFailure,
  resetEngineNodeModulesIfBunLinked,
  runSetupDependencyInstalls,
} from '../fx.ts';

const root = resolve(import.meta.dir, '../..');
const reportFixture = await Bun.file('scripts/ci/fixtures/fx-contract-report.json').json();

function runFx(args: string[]) {
  return spawnSync(BUN_EXECUTABLE, ['scripts/fx.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function fakeRunner(
  outcomes: Array<{status: number; output?: string}>,
) {
  const calls: Array<{command: string; args: string[]; env: NodeJS.ProcessEnv}> = [];
  return {
    calls,
    run(command: string, args: readonly string[], env: NodeJS.ProcessEnv) {
      calls.push({command, args: [...args], env: {...env}});
      return outcomes.shift() ?? {status: 0};
    },
  };
}

test('simple-git-hooks retry predicate requires both package and ENOENT markers', () => {
  expect(isSimpleGitHooksEnoent('simple-git-hooks: ENOENT package.json')).toBe(true);
  expect(isSimpleGitHooksEnoent('simple-git-hooks: package.json not found')).toBe(false);
  expect(isSimpleGitHooksEnoent('ENOENT: package.json not found')).toBe(false);
  expect(isHarnessSyncFailure('simple-git-hooks: ENOENT package.json')).toBe(false);
});

test('setup dependency runner uses one default sparse snapshot across Bun and pnpm', () => {
  const runner = fakeRunner([{status: 0}, {status: 0}]);
  const result = runSetupDependencyInstalls({env: {}, run: runner.run});

  expect(result.setupEnv.effectiveSparseValue).toBe('1');
  expect(runner.calls.map(({command}) => command)).toEqual(['bun', 'pnpm']);
  expect(runner.calls[0]?.env.FORGEAX_HARNESS_SPARSE_DOCS).toBe('1');
  expect(runner.calls[1]?.env.FORGEAX_HARNESS_SPARSE_DOCS).toBe('1');
  expect(runner.calls[1]?.env.FORGEAX_HARNESS_SPARSE_DOCS).toBe(
    runner.calls[0]?.env.FORGEAX_HARNESS_SPARSE_DOCS,
  );
});

test('setup dependency runner resets the Bun-linked Engine graph before pnpm', () => {
  const events: string[] = [];
  const runner = fakeRunner([{status: 0}, {status: 0}]);
  runSetupDependencyInstalls({
    env: {},
    run(command, args, env) {
      events.push(command);
      return runner.run(command, args, env);
    },
    beforeEngineInstall: () => events.push('reset-engine-node-modules'),
  });

  expect(events).toEqual(['bun', 'reset-engine-node-modules', 'pnpm']);
});

function createEngineNodeModulesTree() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'forgeax-fx-engine-node-modules-'));
  const editorRoot = join(tempRoot, 'editor');
  const engineDir = join(editorRoot, 'packages', 'engine');
  const bunTarget = join(editorRoot, 'node_modules', '.bun', 'vitest@bun', 'node_modules', 'vitest');
  mkdirSync(join(engineDir, 'packages'), {recursive: true});
  mkdirSync(bunTarget, {recursive: true});
  return {tempRoot, editorRoot, engineDir, bunTarget};
}

function createDirLink(target: string, link: string): void {
  mkdirSync(dirname(link), {recursive: true});
  symlinkSync(target, link, 'dir');
}

test('engine reset finds nested scoped Bun contamination even without root Vitest', () => {
  const tree = createEngineNodeModulesTree();
  const nestedNodeModules = join(tree.engineDir, 'packages', '@scope', 'engine-plugin', 'node_modules');
  const rootNodeModules = join(tree.engineDir, 'node_modules');
  try {
    mkdirSync(rootNodeModules, {recursive: true});
    writeFileSync(join(rootNodeModules, 'root-marker'), 'root');
    mkdirSync(nestedNodeModules, {recursive: true});
    createDirLink(tree.bunTarget, join(nestedNodeModules, 'vitest'));

    resetEngineNodeModulesIfBunLinked({editorRoot: tree.editorRoot, engineDir: tree.engineDir});

    expect(existsSync(rootNodeModules)).toBe(false);
    expect(existsSync(nestedNodeModules)).toBe(false);
    expect(existsSync(tree.bunTarget)).toBe(true);
  } finally {
    rmSync(tree.tempRoot, {force: true, recursive: true});
  }
});

test('engine reset removes the root and every existing direct and scoped package node_modules', () => {
  const tree = createEngineNodeModulesTree();
  const rootNodeModules = join(tree.engineDir, 'node_modules');
  const directNodeModules = join(tree.engineDir, 'packages', 'engine-core', 'node_modules');
  const scopedNodeModules = join(tree.engineDir, 'packages', '@scope', 'engine-plugin', 'node_modules');
  try {
    for (const path of [rootNodeModules, directNodeModules, scopedNodeModules]) {
      mkdirSync(path, {recursive: true});
      writeFileSync(join(path, 'marker'), 'generated');
    }
    createDirLink(tree.bunTarget, join(directNodeModules, 'vitest'));

    resetEngineNodeModulesIfBunLinked({editorRoot: tree.editorRoot, engineDir: tree.engineDir});

    for (const path of [rootNodeModules, directNodeModules, scopedNodeModules]) {
      expect(existsSync(path)).toBe(false);
    }
  } finally {
    rmSync(tree.tempRoot, {force: true, recursive: true});
  }
});

test('engine reset treats a broken generated link as contamination', () => {
  const tree = createEngineNodeModulesTree();
  const rootNodeModules = join(tree.engineDir, 'node_modules');
  const packageNodeModules = join(tree.engineDir, 'packages', 'engine-core', 'node_modules');
  try {
    mkdirSync(rootNodeModules, {recursive: true});
    mkdirSync(packageNodeModules, {recursive: true});
    symlinkSync(join(tree.tempRoot, 'missing-target'), join(rootNodeModules, 'vitest'), 'dir');

    resetEngineNodeModulesIfBunLinked({editorRoot: tree.editorRoot, engineDir: tree.engineDir});

    expect(existsSync(rootNodeModules)).toBe(false);
    expect(existsSync(packageNodeModules)).toBe(false);
  } finally {
    rmSync(tree.tempRoot, {force: true, recursive: true});
  }
});

test('engine reset preserves pnpm-owned clean links', () => {
  const tree = createEngineNodeModulesTree();
  const pnpmTarget = join(tree.tempRoot, 'pnpm-store', 'vitest', 'node_modules', 'vitest');
  const rootNodeModules = join(tree.engineDir, 'node_modules');
  const scopedNodeModules = join(tree.engineDir, 'packages', '@scope', 'engine-plugin', 'node_modules');
  try {
    mkdirSync(pnpmTarget, {recursive: true});
    mkdirSync(rootNodeModules, {recursive: true});
    mkdirSync(scopedNodeModules, {recursive: true});
    writeFileSync(join(rootNodeModules, 'root-marker'), 'root');
    writeFileSync(join(scopedNodeModules, 'package-marker'), 'package');
    createDirLink(pnpmTarget, join(rootNodeModules, 'vitest'));
    createDirLink(pnpmTarget, join(scopedNodeModules, 'vitest'));

    resetEngineNodeModulesIfBunLinked({editorRoot: tree.editorRoot, engineDir: tree.engineDir});

    expect(existsSync(join(rootNodeModules, 'root-marker'))).toBe(true);
    expect(existsSync(join(scopedNodeModules, 'package-marker'))).toBe(true);
    expect(existsSync(join(rootNodeModules, 'vitest'))).toBe(true);
    expect(existsSync(join(scopedNodeModules, 'vitest'))).toBe(true);
  } finally {
    rmSync(tree.tempRoot, {force: true, recursive: true});
  }
});

test('setup dependency runner preserves explicit zero and skip-editor without clone/fetch', () => {
  const normal = fakeRunner([{status: 0}, {status: 0}]);
  runSetupDependencyInstalls({
    env: {FORGEAX_HARNESS_SPARSE_DOCS: '0'},
    run: normal.run,
  });
  expect(normal.calls[0]?.env.FORGEAX_HARNESS_SPARSE_DOCS).toBe('0');
  expect(normal.calls[1]?.env.FORGEAX_HARNESS_SPARSE_DOCS).toBe('0');

  const skipped = fakeRunner([{status: 0}]);
  const result = runSetupDependencyInstalls({
    env: {
      FORGEAX_HARNESS_SPARSE_DOCS: '0',
      FORGEAX_SKIP_EDITOR_BUN_INSTALL: '1',
    },
    run: skipped.run,
  });
  expect(result.editorInstallSkipped).toBe(true);
  expect(skipped.calls.map(({command}) => command)).toEqual(['pnpm']);
  expect(skipped.calls[0]?.env.FORGEAX_HARNESS_SPARSE_DOCS).toBe('0');
  expect(skipped.calls[0]?.env.FORGEAX_SKIP_EDITOR_BUN_INSTALL).toBe('1');
});

test('setup dependency runner only adds skip on divergence and never on ordinary errors', () => {
  const diverged = fakeRunner([
    {status: 1, output: 'FORGEAX_HARNESS_DIVERGED'},
    {status: 0},
    {status: 0},
  ]);
  const fallback = runSetupDependencyInstalls({env: {}, run: diverged.run});
  expect(diverged.calls.map(({command}) => command)).toEqual(['bun', 'bun', 'pnpm']);
  expect(diverged.calls[1]?.env.FORGEAX_SKIP_HARNESS_SYNC).toBe('1');
  expect(diverged.calls[1]?.env.FORGEAX_HARNESS_SPARSE_DOCS).toBe('1');
  expect(diverged.calls[2]?.env.FORGEAX_SKIP_HARNESS_SYNC).toBe('1');
  expect(fallback.fallbacks).toEqual(['harness-divergence']);

  const explicitFull = fakeRunner([
    {status: 1, output: 'FORGEAX_HARNESS_DIVERGED'},
    {status: 0},
    {status: 0},
  ]);
  runSetupDependencyInstalls({
    env: {FORGEAX_HARNESS_SPARSE_DOCS: '0'},
    run: explicitFull.run,
  });
  expect(explicitFull.calls[1]?.env.FORGEAX_HARNESS_SPARSE_DOCS).toBe('0');
  expect(explicitFull.calls[1]?.env.FORGEAX_SKIP_HARNESS_SYNC).toBe('1');
  expect(explicitFull.calls[2]?.env.FORGEAX_HARNESS_SPARSE_DOCS).toBe('0');

  const ordinary = fakeRunner([{status: 1, output: 'network timeout'}]);
  const failed = runSetupDependencyInstalls({env: {}, run: ordinary.run});
  expect(ordinary.calls.map(({command}) => command)).toEqual(['bun']);
  expect(failed.fallbacks).toEqual([]);
  expect(failed.terminalStatus).toBe('failure');
});

test('setup command failure projection preserves the owning gate phase and recovery code', () => {
  expect(projectSetupCommandFailure(
    'pnpm',
    ['-r', '--filter', './packages/*', 'build'],
    1,
    {
      phase: 'engine-dist',
      code: 'engine-dist-build-failed',
      expected: 'Engine dist build exits with status 0',
      hint: 'Inspect the Engine dist build output and rerun bun fx setup.',
    },
  )).toEqual({
    phase: 'engine-dist',
    code: 'engine-dist-build-failed',
    expected: 'Engine dist build exits with status 0',
    observed: {
      command: 'pnpm',
      args: ['-r', '--filter', './packages/*', 'build'],
      status: 1,
    },
    hint: 'Inspect the Engine dist build output and rerun bun fx setup.',
  });
});

test('setup dependency runner retries simple-git-hooks ENOENT once and continues to pnpm', () => {
  const runner = fakeRunner([
    {status: 1, output: 'error: ENOENT: no such file, simple-git-hooks/package.json'},
    {status: 0},
    {status: 0},
  ]);

  const result = runSetupDependencyInstalls({env: {}, run: runner.run});

  expect(result.terminalStatus).toBe('success');
  expect(runner.calls.map(({command}) => command)).toEqual(['bun', 'bun', 'pnpm']);
  expect(runner.calls.slice(0, 2).map(({args}) => args)).toEqual([
    ['install'],
    ['install'],
  ]);
  expect(runner.calls[0]?.env.FORGEAX_HARNESS_SPARSE_DOCS).toBe('1');
  expect(runner.calls[1]?.env.FORGEAX_HARNESS_SPARSE_DOCS).toBe('1');
  expect(runner.calls[2]?.env.FORGEAX_HARNESS_SPARSE_DOCS).toBe('1');
  expect(result.fallbacks).toEqual(['simple-git-hooks-enoent-retry']);
  expect(runner.calls[1]?.env.FORGEAX_SKIP_HARNESS_SYNC).toBeUndefined();
  expect(runner.calls[2]?.env.FORGEAX_SKIP_HARNESS_SYNC).toBeUndefined();
  expect(runner.calls[1]?.env.SKIP_INSTALL_SIMPLE_GIT_HOOKS).toBeUndefined();
});

test('setup dependency runner keeps editor-bun-install failure after simple-git-hooks ENOENT retry fails', () => {
  const runner = fakeRunner([
    {status: 1, output: 'simple-git-hooks: ENOENT package.json'},
    {status: 1, output: 'simple-git-hooks: ENOENT package.json'},
  ]);

  const result = runSetupDependencyInstalls({env: {}, run: runner.run});

  expect(runner.calls.map(({command}) => command)).toEqual(['bun', 'bun']);
  expect(result.terminalStatus).toBe('failure');
  expect(result.fallbacks).toEqual(['simple-git-hooks-enoent-retry']);
  expect(result.failure?.phase).toBe('editor-bun-install');
  expect(result.failure?.code).toBe('bun-install-failed');
  expect(result.failure?.observed).toEqual({
    status: 1,
    output: 'simple-git-hooks: ENOENT package.json',
  });
});

const envelopeBase = {
  effectiveSparseValue: '1',
  valueSource: 'default',
  requestedEditorHarnessMode: 'sparse',
  requestedEngineHarnessMode: 'sparse',
  actualEditorHarnessMode: 'sparse',
  actualEngineHarnessMode: 'sparse',
  fallbacks: [],
  artifactsVerified: true,
};

test('setup terminal envelope exposes one stable fx-setup/v1 success shape', () => {
  const envelope = createSetupEnvelope({
    ...envelopeBase,
    terminalStatus: 'success',
    phase: 'complete',
    code: 'setup-complete',
    expected: 'all setup gates complete',
    observed: {gates: ['engine-pnpm', 'engine-dist', 'critical-artifact-verify']},
    hint: 'Setup is ready for bun fx start.',
  });

  expect(envelope).toMatchObject({
    schemaVersion: 'fx-setup/v1',
    terminalStatus: 'success',
    phase: 'complete',
    code: 'setup-complete',
    effectiveSparseValue: '1',
    valueSource: 'default',
    requestedEditorHarnessMode: 'sparse',
    requestedEngineHarnessMode: 'sparse',
    actualEditorHarnessMode: 'sparse',
    actualEngineHarnessMode: 'sparse',
    fallbacks: [],
    artifactsVerified: true,
  });
  expect(Object.keys(envelope)).toEqual([
    'schemaVersion',
    'terminalStatus',
    'phase',
    'code',
    'expected',
    'observed',
    'hint',
    'effectiveSparseValue',
    'valueSource',
    'requestedEditorHarnessMode',
    'requestedEngineHarnessMode',
    'actualEditorHarnessMode',
    'actualEngineHarnessMode',
    'fallbacks',
    'artifactsVerified',
  ]);
  expect(JSON.parse(formatSetupEnvelope(envelope))).toEqual(envelope);
});

test('setup terminal envelope distinguishes explicit full, skip, and divergence fallback', () => {
  const full = createSetupEnvelope({
    ...envelopeBase,
    effectiveSparseValue: '0',
    valueSource: 'explicit',
    requestedEditorHarnessMode: 'full',
    requestedEngineHarnessMode: 'full',
    actualEditorHarnessMode: 'full',
    actualEngineHarnessMode: 'full',
    terminalStatus: 'success',
    phase: 'complete',
    code: 'setup-complete',
    expected: 'all setup gates complete',
    observed: {requested: 'full'},
    hint: 'Setup is ready for bun fx start.',
  });
  const skip = createSetupEnvelope({
    ...envelopeBase,
    requestedEditorHarnessMode: 'skip',
    requestedEngineHarnessMode: 'skip',
    actualEditorHarnessMode: 'unknown',
    actualEngineHarnessMode: 'unknown',
    terminalStatus: 'success',
    phase: 'complete',
    code: 'setup-complete',
    expected: 'all setup gates complete',
    observed: {harnessSync: 'skipped'},
    hint: 'Harness sync was skipped; other setup gates ran.',
  });
  const fallback = createSetupEnvelope({
    ...envelopeBase,
    requestedEditorHarnessMode: 'fallback-skip',
    requestedEngineHarnessMode: 'fallback-skip',
    actualEditorHarnessMode: 'full',
    actualEngineHarnessMode: 'unknown',
    fallbacks: ['harness-divergence'],
    terminalStatus: 'success',
    phase: 'complete',
    code: 'setup-complete',
    expected: 'all setup gates complete',
    observed: {harnessSync: 'fallback-skip'},
    hint: 'Reconcile the Harness checkout before the next full sync.',
  });

  expect(full.effectiveSparseValue).toBe('0');
  expect(full.requestedEditorHarnessMode).toBe('full');
  expect(skip.requestedEditorHarnessMode).toBe('skip');
  expect(skip.actualEditorHarnessMode).toBe('unknown');
  expect(fallback.actualEditorHarnessMode).toBe('full');
  expect(skip.artifactsVerified).toBe(true);
  expect(fallback.fallbacks).toEqual(['harness-divergence']);
});

test('setup terminal envelope keeps structured recovery fields for ordinary and gate failures', () => {
  for (const sample of [
    createSetupEnvelope({
      ...envelopeBase,
      terminalStatus: 'failure',
      phase: 'editor-bun-install',
      code: 'bun-install-failed',
      expected: 'bun install exits with status 0',
      observed: {status: 1, output: 'network timeout'},
      hint: 'Check network access and rerun bun fx setup.',
      artifactsVerified: false,
    }),
    createSetupEnvelope({
      ...envelopeBase,
      terminalStatus: 'failure',
      phase: 'critical-artifact-verify',
      code: 'critical-artifact-missing',
      expected: 'all critical Engine artifacts exist',
      observed: {missing: ['packages/engine/packages/fbx/pkg/fbx-wasm.wasm']},
      hint: 'Rerun bun fx setup; do not create a placeholder artifact.',
      artifactsVerified: false,
    }),
  ]) {
    expect(sample.schemaVersion).toBe('fx-setup/v1');
    expect(sample.terminalStatus).toBe('failure');
    expect(sample.phase).toEqual(expect.any(String));
    expect(sample.code).toEqual(expect.any(String));
    expect(sample.expected).toEqual(expect.any(String));
    expect(sample.observed).toBeDefined();
    expect(sample.hint).toEqual(expect.any(String));
    expect(sample.artifactsVerified).toBe(false);
  }
});

test('setup help makes default sparse, explicit full, and skip discoverable', () => {
  const result = runFx(['--help']);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('FORGEAX_HARNESS_SPARSE_DOCS=1');
  expect(result.stdout).toContain('FORGEAX_HARNESS_SPARSE_DOCS=0');
  expect(result.stdout).toContain('FORGEAX_SKIP_HARNESS_SYNC=1');
});

test('contract discovery is read-only and exposes selectable homes and recovery fields', () => {
  const result = runFx(['ci', 'contract', '--json']);
  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.schemaVersion).toBe('forgeax-editor-ci-contract/v1');
  expect(payload.checks.map((check: { checkId: string }) => check.checkId)).toEqual([
    'b2-self-boot',
    'typecheck',
    'r0-hierarchy-ui-editability',
    'r0-sample-vfx-skill',
    'r0-engine-dogfood-diagnostics',
    'submodule-pin',
    'smoke-play',
    'editor-portability',
  ]);
  expect(payload.profiles['local-fast']).toEqual([
    'b2-self-boot',
    'typecheck',
    'r0-hierarchy-ui-editability',
    'r0-sample-vfx-skill',
    'r0-engine-dogfood-diagnostics',
  ]);
  expect(payload.profiles['local-full']).toEqual([
    'b2-self-boot',
    'typecheck',
    'r0-hierarchy-ui-editability',
    'r0-sample-vfx-skill',
    'r0-engine-dogfood-diagnostics',
    'submodule-pin',
    'smoke-play',
  ]);
  expect(payload.recovery).toEqual(reportFixture.discoveryRecovery);
});

test('dirty checkout is admitted before execution and writes only the requested report', async () => {
  const marker = join(root, 'scripts/ci/.fx-contract-admission-marker');
  const reportDir = mkdtempSync(join(tmpdir(), 'forgeax-fx-contract-report-'));
  const reportPath = join(reportDir, 'report.json');
  writeFileSync(marker, 'temporary dirty state\n');
  try {
    const result = runFx(['ci', '--fast', '--report', reportPath]);
    expect(result.status).not.toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(reportPath)).toBe(true);
    const report = await Bun.file(reportPath).json();
    for (const field of reportFixture.envelopeFields) expect(report).toHaveProperty(field);
    expect(report.$schema).toBe('forgeax-editor-ci-report/v1');
    expect(report.contractVersion).toBe('forgeax-editor-ci-contract/v1');
    expect(report.schemaVersion).toBeUndefined();
    expect(report.status).toBeUndefined();
    expect(report.profile).toBe('fast');
    expect(report.executionHome).toBe('local-fast');
    expect(report.terminalStatus).toBe('failure');
    expect(report.failureClass).toBe('admission');
    expect(report.code).toBe('dirty-worktree');
    expect(report.attempts).toHaveLength(1);
  } finally {
    rmSync(marker, { force: true });
    rmSync(reportDir, { recursive: true, force: true });
  }
});

test('local profiles expose the shared prerequisite vocabulary without cloud provenance', async () => {
  const contractResult = runFx(['ci', 'contract', '--json']);
  expect(contractResult.status).toBe(0);
  const contract = JSON.parse(contractResult.stdout);
  expect(contract.prerequisiteRelease.schemaVersion).toBe('forgeax-prerequisite-release/v1');
  expect(contract.prerequisiteRelease.consumers['b2-self-boot']).toEqual([
    'engine-dist',
    'wgpu-wasm',
    'bun-install-facts',
  ]);
  expect(contract.prerequisiteRelease.consumers['smoke-play']).toEqual([
    'engine-dist',
    'wgpu-wasm',
    'fbx-wasm',
    'bun-install-facts',
  ]);
  expect(contract.requiredContexts.map((entry: { context: string }) => entry.context)).toEqual([
    'b2-self-boot',
    'typecheck',
    'submodule-pin',
    'smoke-play',
  ]);

  for (const profile of ['fast', 'full'] as const) {
    const marker = join(root, `scripts/ci/.fx-contract-${profile}-marker`);
    const reportDir = mkdtempSync(join(tmpdir(), `forgeax-fx-${profile}-parity-`));
    const reportPath = join(reportDir, 'report.json');
    writeFileSync(marker, 'temporary dirty state\n');
    try {
      const result = runFx(['ci', `--${profile}`, '--report', reportPath]);
      expect(result.status).not.toBe(0);
      const report = await Bun.file(reportPath).json();
      expect(report.executionHome).toBe(`local-${profile}`);
      expect(report.provenance).toMatchObject({kind: 'local', timingDomain: 'local-execution'});
      expect(report).toHaveProperty('prerequisiteRelease');
      expect(report.prerequisiteRelease).toBeNull();
    } finally {
      rmSync(marker, {force: true});
      rmSync(reportDir, {recursive: true, force: true});
    }
  }
});

test('baseline JSON is progressively discoverable and keeps no-claim separate from facts', async () => {
  const inputPath = resolve('scripts/ci/fixtures/fx-contract-report.json');
  const result = runFx(['ci', 'baseline', '--json', '--input', inputPath]);
  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.summary).toMatchObject({status: 'no-claim', schema: 'forgeax-ci-baseline/v2'});
  expect(payload.schema.fields).toEqual([
    'attemptProvenance',
    'criticalPath',
    'requiredContexts',
    'costFacts',
    'readiness',
    'budgetClaim',
    'noClaim',
    'integrationIndex',
  ]);
  expect(payload.provenance.attemptProvenance).toEqual(reportFixture.baselineInput.attemptProvenance);
  expect(payload.facts.criticalPath).toEqual(reportFixture.baselineInput.criticalPath);
  expect(payload.facts.costFacts).toEqual(reportFixture.baselineInput.costFacts);
  expect(payload.claims.budgetClaim).toBeNull();
  expect(payload.noClaims[0]).toMatchObject({code: 'budget-population-insufficient'});
  expect(payload.rawPacket).toMatchObject({available: false});
  expect(payload.providerBilling).toBeUndefined();
});

test('contract and help expose the same public baseline vocabulary', () => {
  const contractResult = runFx(['ci', 'contract', '--json']);
  expect(contractResult.status).toBe(0);
  const contract = JSON.parse(contractResult.stdout);
  expect(contract.baselineEvidence.topIndex.fields).toContain('criticalPath');
  expect(contract.baselineEvidence.topIndex.layers).toEqual([
    'summary', 'schema', 'facts', 'claims', 'no-claims', 'raw-packet',
  ]);

  const helpResult = runFx(['--help']);
  expect(helpResult.status).toBe(0);
  expect(helpResult.stdout).toContain('ci baseline --json');
  expect(helpResult.stdout).toContain('ci contract --json');
  expect(helpResult.stdout).toContain('facts / claims / no-claims / provenance');
});

test('baseline CLI returns a structured non-zero error for an unreadable input', () => {
  const result = runFx(['ci', 'baseline', '--json', '--input', 'scripts/ci/fixtures/does-not-exist.json']);
  expect(result.status).not.toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.error).toMatchObject({code: 'baseline-input-unreadable'});
  expect(payload.error.hint).toEqual(expect.any(String));
  expect(payload.error.affectedProvenance).toBeNull();
});

test('baseline CLI rejects malformed provenance with the owner validation envelope', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'forgeax-baseline-cli-'));
  const inputPath = join(tempDir, 'malformed.json');
  writeFileSync(inputPath, JSON.stringify({schemaVersion: 'forgeax-ci-baseline/v2', attemptProvenance: {}}));
  try {
    const result = runFx(['ci', 'baseline', '--json', '--input', inputPath]);
    expect(result.status).not.toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.error).toMatchObject({code: 'attempt-provenance-missing'});
    expect(payload.error.affectedProvenance).toEqual({});
  } finally {
    rmSync(tempDir, {recursive: true, force: true});
  }
});

test('baseline CLI rejects a legal packetless no-claim envelope with a stable non-zero result', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'forgeax-baseline-cli-no-claim-'));
  const inputPath = join(tempDir, 'packetless.json');
  writeFileSync(inputPath, JSON.stringify({
    schemaVersion: 'forgeax-ci-baseline/v2',
    attemptProvenance: null,
    noClaim: [{
      code: 'attempt-packet-missing',
      expected: 'at least one complete current workflow run attempt packet',
      observed: {acceptedPackets: 0},
      hint: 'Collect the exact current attempt packet.',
      affectedProvenance: null,
    }],
  }));
  try {
    const result = runFx(['ci', 'baseline', '--json', '--input', inputPath]);
    expect(result.status).not.toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatchObject({code: 'attempt-packet-missing'});
    expect(payload.error.hint).toEqual(expect.any(String));
  } finally {
    rmSync(tempDir, {recursive: true, force: true});
  }
});

test('baseline CLI consumes the collector top-level raw packet reference', () => {
  const input = structuredClone(reportFixture.baselineInput);
  input.attempts = [{rawPacket: {available: true, path: 'job-packets/run-123-attempt-2.json'}}];
  input.rawPacket = input.attempts[0].rawPacket;
  const tempDir = mkdtempSync(join(tmpdir(), 'forgeax-baseline-cli-raw-packet-'));
  const inputPath = join(tempDir, 'collector-shaped.json');
  writeFileSync(inputPath, JSON.stringify(input));
  try {
    const result = runFx(['ci', 'baseline', '--json', '--input', inputPath]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).rawPacket).toEqual(input.rawPacket);
  } finally {
    rmSync(tempDir, {recursive: true, force: true});
  }
});
