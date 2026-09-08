import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  PORTABILITY_PLATFORMS,
  PORTABILITY_STAGES,
  aggregatePlatformReports,
  createNativeStagePlan,
  probeBrowserCapability,
  projectPortabilityRecovery,
  runNativePortability,
  selectSmokeMode,
  writeAggregateReport,
} from '../editor-portability.mjs';
import { validateEditorCiReport } from '../editor-ci-report.mjs';

const fixture = JSON.parse(
  readFileSync(resolve('scripts/ci/fixtures/editor-portability-cases.json'), 'utf8'),
);

test('native runner keeps the fixed platform and stage order', () => {
  assert.deepEqual(PORTABILITY_PLATFORMS, fixture.platforms);
  assert.deepEqual(PORTABILITY_STAGES, fixture.stages);
  assert.deepEqual(
    createNativeStagePlan({ platform: 'linux' }).map(({ stage }) => stage),
    fixture.stages,
  );
});

test('native runner records source SHA, recursive pins, and toolchain identity', async () => {
  const result = await runNativePortability({
    platform: 'linux',
    sourceSha: fixture.valid.sourceSha,
    recursivePins: fixture.valid.recursivePins,
    platformIdentity: fixture.valid.platformIdentity,
    stageHandlers: fixture.valid.stageHandlers,
  });

  assert.equal(result.ok, true);
  assert.equal(result.sourceSha, fixture.valid.sourceSha);
  assert.deepEqual(result.recursivePins, fixture.valid.recursivePins);
  assert.deepEqual(result.platform, fixture.valid.platformIdentity);
  assert.deepEqual(result.reports.map(({ stage }) => stage), fixture.stages);
  assert.ok(result.reports.every(({ terminalStatus }) => terminalStatus === 'pass'));
});

test('native runner emits exactly one terminal report per platform stage', async () => {
  const result = await runNativePortability({
    platform: 'windows',
    sourceSha: fixture.valid.sourceSha,
    recursivePins: fixture.valid.recursivePins,
    platformIdentity: fixture.valid.platformIdentity,
    stageHandlers: fixture.valid.stageHandlers,
  });

  const keys = result.reports.map((report) => `${report.platform.os}:${report.stage}`);
  assert.equal(new Set(keys).size, fixture.stages.length);
  assert.deepEqual(result.matrix.terminalResults.map(({ stage }) => stage), fixture.stages);
});

test('native runner turns stage and toolchain failures into structured terminal reports', async () => {
  const result = await runNativePortability({
    platform: 'macos',
    sourceSha: fixture.valid.sourceSha,
    recursivePins: fixture.valid.recursivePins,
    platformIdentity: fixture.valid.platformIdentity,
    stageHandlers: {
      ...fixture.valid.stageHandlers,
      setup: () => ({
        ok: false,
        failureClass: 'environment',
        code: 'required-toolchain-missing',
        expected: 'wasm-pack 0.14.0',
        observed: 'missing',
        hint: 'Install the pinned native toolchain before retrying setup.',
      }),
    },
  });

  assert.equal(result.ok, false);
  const setup = result.reports.find(({ stage }) => stage === 'setup');
  assert.equal(setup.terminalStatus, 'failure');
  assert.equal(setup.failureClass, 'environment');
  assert.equal(setup.code, 'required-toolchain-missing');
  assert.equal(typeof setup.firstFailure, 'object');
  for (const stage of fixture.requiredStages.slice(fixture.requiredStages.indexOf('setup') + 1)) {
    const report = result.reports.find((candidate) => candidate.stage === stage);
    assert.equal(report.terminalStatus, 'failure', stage);
    assert.equal(report.code, 'blocked-by-stage-failure', stage);
  }
  assert.deepEqual(
    result.reports.find(({stage}) => stage === 'setup').capability,
    {result: 'not-applicable', stage: 'setup'},
  );
  assert.equal(validateEditorCiReport(result.reports.find(({stage}) => stage === 'setup')).ok, true);
});

test('native runner writes a report when setup fails after identity collection', async () => {
  const reportDir = mkdtempSync('/tmp/forgeax-editor-portability-');
  const reportPath = join(reportDir, 'editor-portability-report.json');
  const sourceSha = fixture.valid.sourceSha;
  const identityOutputs = new Map([
    ['bun --version', '1.3.14\n'],
    ['bun --revision', 'bun-revision\n'],
    ['node --version', 'v22.13.0\n'],
    ['pnpm --version', '11.7.0\n'],
    ['rustc --version', 'rustc 1.93.0\n'],
    ['wasm-pack --version', 'wasm-pack 0.14.0\n'],
    ['emcc --version', 'emcc 4.0.15\n'],
  ]);
  const commandRunner = (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    if (key === 'git rev-parse --verify HEAD') return {ok: true, status: 0, stdout: `${sourceSha}\n`, stderr: ''};
    if (key === 'git submodule status --recursive') {
      return {ok: true, status: 0, stdout: fixture.valid.recursivePins.map(({pin, path}) => ` ${pin} ${path}\n`).join(''), stderr: ''};
    }
    if (key === 'bun fx setup') return {ok: false, status: 1, stdout: '', stderr: 'setup failed: missing native dependency'};
    if (identityOutputs.has(key)) return {ok: true, status: 0, stdout: identityOutputs.get(key), stderr: ''};
    return {ok: true, status: 0, stdout: '', stderr: ''};
  };

  try {
    const result = await runNativePortability({
      platform: 'linux',
      sourceSha,
      env: {RUNNER_ARCH: 'X64', ImageOS: 'ubuntu-24.04'},
      commandRunner,
      reportPath,
    });

    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.error.code, 'native-command-failed');
    assert.equal(result.error.stage, 'setup');
    assert.equal(result.error.observed, 'setup failed: missing native dependency');
    assert.equal(result.platform.toolchain.bun, '1.3.14');
    assert.deepEqual(JSON.parse(readFileSync(reportPath, 'utf8')), result.reports);
    assert.ok(result.reports.every((report) => validateEditorCiReport(report).ok), JSON.stringify(result.reports));
    const setup = result.reports.find(({stage}) => stage === 'setup');
    assert.equal(setup.code, 'native-command-failed');
    assert.equal(setup.observed, 'setup failed: missing native dependency');
    assert.equal(setup.firstFailure.stage, 'setup');
    for (const report of result.reports.slice(result.reports.indexOf(setup) + 1)) {
      assert.equal(report.terminalStatus, 'failure', report.stage);
      assert.equal(report.code, 'blocked-by-stage-failure', report.stage);
      assert.equal(report.firstFailure.stage, 'setup', report.stage);
      assert.equal(report.firstFailure.code, setup.code, report.stage);
    }
  } finally {
    rmSync(reportDir, {recursive: true, force: true});
  }
});

test('native runner writes a report when the first toolchain identity command fails', async () => {
  const reportDir = mkdtempSync('/tmp/forgeax-editor-portability-');
  const reportPath = join(reportDir, 'editor-portability-report.json');
  const sourceSha = fixture.valid.sourceSha;
  const commandRunner = (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    if (key === 'git rev-parse --verify HEAD') return {ok: true, status: 0, stdout: `${sourceSha}\n`, stderr: ''};
    if (key === 'git submodule update --init --recursive') return {ok: true, status: 0, stdout: '', stderr: ''};
    if (key === 'bun install --frozen-lockfile --ignore-scripts') return {ok: true, status: 0, stdout: '', stderr: ''};
    if (key === 'bun --version') return {ok: false, status: 1, stdout: '', stderr: 'bun identity unavailable'};
    return {ok: true, status: 0, stdout: '', stderr: ''};
  };

  try {
    const result = await runNativePortability({
      platform: 'linux',
      sourceSha,
      recursivePins: fixture.valid.recursivePins,
      env: {RUNNER_ARCH: 'X64', ImageOS: 'ubuntu-24.04'},
      commandRunner,
      reportPath,
    });

    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.error.code, 'native-command-failed');
    assert.equal(result.error.stage, 'setup');
    assert.equal(existsSync(reportPath), true);
    assert.deepEqual(result.platform.toolchain, {
      bun: '',
      bunRevision: '',
      node: '',
      pnpm: '',
      rust: '',
      wasmPack: '',
      emscripten: '',
    });
    assert.deepEqual(JSON.parse(readFileSync(reportPath, 'utf8')), result.reports);
    assert.equal(result.reports.length, PORTABILITY_STAGES.length);
    assert.ok(result.reports.every((report) => validateEditorCiReport(report).ok), JSON.stringify(result.reports));
    const aggregate = aggregatePlatformReports([
      result,
      await platformArtifact('windows'),
      await platformArtifact('macos'),
    ]);
    assert.equal(aggregate.ok, false);
    assert.equal(aggregate.error.code, 'matrix-toolchain-identity-missing');

    const setupIndex = result.reports.findIndex(({stage}) => stage === 'setup');
    const checkout = result.reports.find(({stage}) => stage === 'checkout');
    const install = result.reports.find(({stage}) => stage === 'install');
    const setup = result.reports[setupIndex];
    assert.equal(checkout.terminalStatus, 'pass');
    assert.equal(install.terminalStatus, 'pass');
    assert.equal(setup.terminalStatus, 'failure');
    assert.equal(setup.firstFailure.stage, 'setup');
    assert.equal(setup.firstFailure.code, setup.code);
    assert.equal(setup.observed, 'bun identity unavailable');
    for (const report of result.reports.slice(setupIndex + 1)) {
      assert.equal(report.terminalStatus, 'failure', report.stage);
      assert.equal(report.code, 'blocked-by-stage-failure', report.stage);
      assert.equal(report.firstFailure.stage, 'setup', report.stage);
      assert.equal(report.firstFailure.code, setup.code, report.stage);
    }
  } finally {
    rmSync(reportDir, {recursive: true, force: true});
  }
});

test('native stage plan refuses a platform outside the fixed acceptance set', () => {
  assert.throws(
    () => createNativeStagePlan({ platform: 'ubuntu' }),
    /unsupported portability platform/,
  );
});

test('deliberate missing-toolchain control is a platform failure and makes aggregation red', async () => {
  const result = await runNativePortability({
    platform: 'linux',
    sourceSha: fixture.valid.sourceSha,
    recursivePins: fixture.valid.recursivePins,
    platformIdentity: fixture.valid.platformIdentity,
    stageHandlers: fixture.valid.stageHandlers,
    failureControl: fixture.failureControls['missing-toolchain'],
  });

  assert.equal(result.ok, false);
  const setup = result.reports.find(({ stage }) => stage === 'setup');
  assert.equal(setup.terminalStatus, 'failure');
  assert.equal(setup.failureClass, 'environment');
  assert.equal(setup.code, fixture.failureControls['missing-toolchain'].code);
  const aggregate = aggregatePlatformReports(await Promise.all([
    result,
    platformArtifact('windows'),
    platformArtifact('macos'),
  ]));
  assert.equal(aggregate.error.code, 'matrix-stage-nonpass');
});

test('deliberate stage failure is terminal and blocks later stages', async () => {
  const result = await runNativePortability({
    platform: 'linux',
    sourceSha: fixture.valid.sourceSha,
    recursivePins: fixture.valid.recursivePins,
    platformIdentity: fixture.valid.platformIdentity,
    stageHandlers: fixture.valid.stageHandlers,
    failureControl: fixture.failureControls['stage-failure'],
  });

  assert.equal(result.ok, false);
  const failed = result.reports.find(({ stage }) => stage === 'type-static');
  assert.equal(failed.terminalStatus, 'failure');
  assert.equal(failed.code, fixture.failureControls['stage-failure'].code);
  for (const stage of fixture.stages.slice(fixture.stages.indexOf('type-static') + 1)) {
    const blocked = result.reports.find((report) => report.stage === stage);
    assert.equal(blocked.terminalStatus, 'failure', stage);
    assert.equal(blocked.code, 'blocked-by-stage-failure', stage);
  }
});

test('capability-unavailable control is bounded skipped, never pass', async () => {
  const result = await runNativePortability({
    platform: 'linux',
    sourceSha: fixture.valid.sourceSha,
    recursivePins: fixture.valid.recursivePins,
    platformIdentity: fixture.valid.platformIdentity,
    stageHandlers: fixture.valid.stageHandlers,
    failureControl: fixture.failureControls['capability-unavailable'],
  });

  assert.equal(result.ok, true);
  for (const stage of ['capability-probe', 'smoke']) {
    const report = result.reports.find((candidate) => candidate.stage === stage);
    assert.equal(report.terminalStatus, 'skipped', stage);
    assert.equal(report.capability.result, fixture.failureControls['capability-unavailable'].expectedResult, stage);
    assert.equal(typeof report.capability.boundary, 'string', stage);
    assert.equal(typeof report.capability.hint, 'string', stage);
  }
});

test('external transport retries once and preserves firstFailure and attempts', async () => {
  let calls = 0;
  const transport = fixture.failureControls['external-transport'];
  const result = await runNativePortability({
    platform: 'linux',
    sourceSha: fixture.valid.sourceSha,
    recursivePins: fixture.valid.recursivePins,
    platformIdentity: fixture.valid.platformIdentity,
    stageHandlers: {
      ...fixture.valid.stageHandlers,
      install: () => {
        calls += 1;
        return {ok: false, ...(calls === 1 ? transport.first : transport.second)};
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(calls, 2);
  const install = result.reports.find(({ stage }) => stage === 'install');
  assert.equal(install.code, transport.second.code);
  assert.equal(install.firstFailure.code, transport.first.code);
  assert.equal(install.attempts.length, 2);
  assert.deepEqual(install.attempts.map(({ attempt }) => attempt), [1, 2]);
});

test('AI recovery projection locates the contract entry and original platform stage report', async () => {
  let calls = 0;
  const transport = fixture.failureControls['external-transport'];
  const platform = await platformArtifact('linux', {
    stageHandlers: {
      ...fixture.valid.stageHandlers,
      install: () => {
        calls += 1;
        return {ok: false, ...(calls === 1 ? transport.first : transport.second)};
      },
    },
  });
  const aggregate = {
    checkId: 'editor-portability',
    sourceSha: fixture.valid.sourceSha,
    platformReports: [{platform: platform.platform, reports: platform.reports}],
  };

  const result = projectPortabilityRecovery({
    contract: fixture.aiRecovery.contract,
    aggregate,
    platformReports: [platform],
    platform: 'linux',
    stage: 'install',
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.checkId, fixture.aiRecovery.expected.checkId);
  assert.equal(result.value.profile, fixture.aiRecovery.expected.profile);
  assert.equal(result.value.artifactPath, fixture.aiRecovery.expected.artifactPath);
  assert.equal(result.value.sourceSha, fixture.aiRecovery.expected.sourceSha);
  assert.equal(result.value.platform, fixture.aiRecovery.expected.platform);
  assert.equal(result.value.stage, fixture.aiRecovery.expected.stage);
  assert.equal(result.value.failure.code, fixture.aiRecovery.expected.code);
  assert.equal(result.value.failure.firstFailure.code, transport.first.code);
  assert.equal(result.value.failure.attempts.length, 2);
  assert.equal(result.value.recovery.retryable, fixture.aiRecovery.expected.retryable);
  assert.equal(result.value.recovery.action, fixture.aiRecovery.expected.action);
});

test('AI recovery projection fails when structured recovery fields are absent', () => {
  const result = projectPortabilityRecovery({
    contract: fixture.aiRecovery.contract,
    aggregate: {checkId: 'editor-portability', sourceSha: fixture.valid.sourceSha},
    platformReports: [{
      sourceSha: fixture.valid.sourceSha,
      platform: fixture.valid.platformIdentity,
      reports: [{platform: 'linux', stage: 'install', terminalStatus: 'failure'}],
    }],
    platform: 'linux',
    stage: 'install',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'recovery-report-invalid');
  assert.equal(typeof result.error.expected, 'string');
  assert.equal(typeof result.error.observed, 'object');
  assert.equal(typeof result.error.hint, 'string');
});

function probeFromFixture(caseValue) {
  return probeBrowserCapability({
    browserChannel: caseValue.browserChannel,
    probeMode: async ({ mode }) => caseValue.probes[mode],
  });
}

for (const [name, caseValue] of Object.entries(fixture.capabilityCases)) {
  test(`capability probe records runtime facts for ${name}`, async () => {
    const result = await probeFromFixture(caseValue);

    assert.equal(result.result, caseValue.expected.result, name);
    assert.equal(result.browserChannel, caseValue.browserChannel, name);
    if (caseValue.expected.browserMode) assert.equal(result.browserMode, caseValue.expected.browserMode, name);
    for (const field of ['navigatorGpu', 'adapter', 'device', 'backend']) {
      if (Object.hasOwn(caseValue.expected, field)) assert.deepEqual(result[field], caseValue.expected[field], `${name}:${field}`);
    }
    if (Object.hasOwn(caseValue.expected, 'features')) assert.deepEqual(result.features, caseValue.expected.features, name);
    if (result.result === 'bounded-non-applicable') {
      assert.equal(typeof result.boundary, 'string', `${name}:boundary`);
      assert.notEqual(result.boundary.length, 0, `${name}:boundary`);
      assert.equal(typeof result.hint, 'string', `${name}:hint`);
      assert.notEqual(result.hint.length, 0, `${name}:hint`);
      assert.notEqual(result.browserMode, undefined, `${name}:browserMode`);
      assert.ok(Array.isArray(result.attempts), `${name}:attempts`);
    }
  });
}

for (const [name, caseValue] of Object.entries(fixture.smokeCases)) {
  test(`smoke selection follows runtime capability facts for ${name}`, () => {
    const result = selectSmokeMode(caseValue.capability);

    assert.equal(result.mode, caseValue.expected.mode, name);
    assert.equal(result.terminalStatus, caseValue.expected.terminalStatus, name);
    if (result.terminalStatus === 'skipped') {
      assert.equal(caseValue.capability.result, 'bounded-non-applicable', name);
      assert.equal(typeof result.boundary, 'string', `${name}:boundary`);
      assert.equal(typeof result.hint, 'string', `${name}:hint`);
    }
  });
}

test('smoke selection rejects liveness-only or incomplete capability claims', () => {
  assert.throws(
    () => selectSmokeMode({result: 'supported', browserMode: 'headed'}),
    /capability facts/i,
  );
  assert.throws(
    () => selectSmokeMode({result: 'skipped', browserMode: 'headless'}),
    /bounded-non-applicable/i,
  );
});

function identityFor(os) {
  return {
    ...fixture.valid.platformIdentity,
    os,
    architecture: os === 'windows' ? 'x64' : fixture.valid.platformIdentity.architecture,
  };
}

async function platformArtifact(os, overrides = {}) {
  return runNativePortability({
    platform: os,
    sourceSha: fixture.valid.sourceSha,
    recursivePins: fixture.valid.recursivePins,
    platformIdentity: identityFor(os),
    stageHandlers: fixture.valid.stageHandlers,
    ...overrides,
  });
}

test('aggregate accepts only the complete native matrix for one source SHA', async () => {
  const reports = await Promise.all(
    fixture.platforms.map((platform) => platformArtifact(platform)),
  );
  const result = aggregatePlatformReports(reports);

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.matrix.platforms, fixture.platforms);
  assert.equal(result.value.sourceSha, fixture.valid.sourceSha);
  assert.equal(result.value.terminalStatus, 'pass');
  assert.equal(result.value.matrix.terminalResults.length, fixture.platforms.length * fixture.stages.length);
});

test('aggregate rejects an empty toolchain identity across all three platforms', async () => {
  const reports = structuredClone(await Promise.all(
    fixture.platforms.map((platform) => platformArtifact(platform)),
  ));
  for (const report of reports) report.platform.toolchain = {};

  const result = aggregatePlatformReports(reports);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'matrix-toolchain-identity-missing');
  assert.deepEqual(result.error.expected, [
    'bun',
    'bunRevision',
    'node',
    'pnpm',
    'rust',
    'wasmPack',
    'emscripten',
  ]);
  assert.deepEqual(result.error.observed, {});
});

test('shared portability validation rejects a partial observed toolchain', async () => {
  const reports = structuredClone(await Promise.all(
    fixture.platforms.map((platform) => platformArtifact(platform)),
  ));
  delete reports[0].platform.toolchain.pnpm;

  const result = aggregatePlatformReports(reports);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'matrix-toolchain-identity-missing');
});

test('native command boundary captures actual toolchain identities and recursive pins', async () => {
  const calls = [];
  const commandRunner = (command, args) => {
    calls.push(`${command} ${args.join(' ')}`);
    if (command === 'git' && args[0] === 'submodule' && args[1] === 'status') return {ok: true, status: 0, stdout: ' 2222222222222222222222222222222222222222 packages/engine\n', stderr: ''};
    if (command === 'git' && args[0] === 'rev-parse') return {ok: true, status: 0, stdout: `${fixture.valid.sourceSha}\n`, stderr: ''};
    if (command === 'git' && args[0] === 'submodule') return {ok: true, status: 0, stdout: '', stderr: ''};
    const identities = {
      'bun --version': '1.3.14\n',
      'bun --revision': 'bun-revision\n',
      'node --version': 'v22.13.0\n',
      'pnpm --version': '11.7.0\n',
      'rustc --version': 'rustc 1.93.0\n',
      'wasm-pack --version': 'wasm-pack 0.14.0\n',
      'emcc --version': 'emcc 4.0.15\n',
    };
    return {ok: true, status: 0, stdout: identities[`${command} ${args.join(' ')}`] ?? '', stderr: ''};
  };
  const result = await runNativePortability({
    platform: 'linux',
    sourceSha: fixture.valid.sourceSha,
    env: {RUNNER_ARCH: 'X64', ImageOS: 'ubuntu-24.04'},
    commandRunner,
    stageHandlers: {
      wasm: {ok: true},
      'zero-binary': {ok: true, trackedBinaryFiles: []},
      'type-static': {ok: true},
      'capability-probe': {ok: true, capability: fixture.smokeCases.headless.capability},
      smoke: {ok: true},
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.platform.toolchain.bun, '1.3.14');
  assert.equal(result.platform.toolchain.bunRevision, 'bun-revision');
  assert.ok(calls.includes('bun --revision'));
  assert.ok(calls.includes('git submodule status --recursive'));
});

test('native producer fails closed when recursive pin collection is empty or fails', async () => {
  for (const commandRunner of [
    () => ({ok: true, status: 0, stdout: '', stderr: ''}),
    () => ({ok: false, status: 1, stdout: '', stderr: 'authentication failed'}),
  ]) {
    const result = await runNativePortability({platform: 'linux', sourceSha: fixture.valid.sourceSha, commandRunner});
    assert.equal(result.ok, false);
    assert.match(result.error.code, /^recursive-pins-/);
  }
});

test('native producer writes complete terminal evidence when recursive pin preflight fails', async () => {
  const reportPath = join(mkdtempSync(join(tmpdir(), 'forgeax-portability-')), 'report.json');
  const result = await runNativePortability({
    platform: 'linux',
    sourceSha: fixture.valid.sourceSha,
    env: {RUNNER_ARCH: 'X64', ImageOS: 'ubuntu24'},
    commandRunner: () => ({ok: false, status: 1, stdout: '', stderr: 'authentication failed'}),
    reportPath,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'recursive-pins-command-failed');
  const reports = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(reports.length, fixture.stages.length);
  assert.equal(reports[0].stage, 'checkout');
  assert.equal(reports[0].code, 'recursive-pins-command-failed');
  assert.deepEqual(reports.map(({terminalStatus}) => terminalStatus), fixture.stages.map(() => 'failure'));
  assert.ok(reports.every((report) => validateEditorCiReport(report).ok));
  assert.equal(result.matrix.terminalResults.length, fixture.stages.length);
});

test('aggregate rejects capability failure, invalid nested reports, and mismatched identity', async () => {
  const reports = await Promise.all(fixture.platforms.map((platform) => platformArtifact(platform)));
  const capabilityFailure = structuredClone(reports);
  capabilityFailure[1].reports.find(({stage}) => stage === 'capability-probe').terminalStatus = 'failure';
  assert.equal(aggregatePlatformReports(capabilityFailure).error.code, 'platform-report-invalid');

  const nestedInvalid = structuredClone(reports);
  delete nestedInvalid[0].reports[0].capability;
  assert.equal(aggregatePlatformReports(nestedInvalid).error.code, 'platform-report-invalid');

  const nestedBaseInvalid = structuredClone(reports);
  delete nestedBaseInvalid[0].reports[0].attempts;
  delete nestedBaseInvalid[0].reports[0].provenance;
  assert.equal(aggregatePlatformReports(nestedBaseInvalid).error.code, 'platform-report-invalid');

  const identityFailure = aggregatePlatformReports(reports, {workflowRunId: 0, workflowRunAttempt: 1});
  assert.equal(identityFailure.error.code, 'aggregate-report-invalid');

  const toolchainDrift = structuredClone(reports);
  toolchainDrift[2].platform = {
    ...toolchainDrift[2].platform,
    toolchain: {...toolchainDrift[2].platform.toolchain, bun: '1.3.15'},
  };
  assert.equal(aggregatePlatformReports(toolchainDrift).error.code, 'matrix-toolchain-identity-mismatch');
});

test('bounded capability and smoke skips remain an explicitly fact-backed aggregate pass', async () => {
  const reports = await Promise.all(fixture.platforms.map((platform) => platformArtifact(platform, {failureControl: fixture.failureControls['capability-unavailable']})));
  const result = aggregatePlatformReports(reports, {workflowRunId: 801, workflowRunAttempt: 2});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.terminalStatus, 'pass');
  assert.ok(result.value.matrix.terminalResults.some(({stage, terminalStatus}) => stage === 'smoke' && terminalStatus === 'skipped'));
});

test('aggregate artifact handoff writes the contract-indexed report shape', async () => {
  const reports = await Promise.all(fixture.platforms.map((platform) => platformArtifact(platform)));
  const path = join(mkdtempSync('/tmp/forgeax-portability-'), 'editor-portability-aggregate.json');
  const written = writeAggregateReport(reports, path, {workflowRunId: 801, workflowRunAttempt: 2});
  assert.equal(written.ok, true, JSON.stringify(written));
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(artifact.$schema, 'forgeax-editor-ci-report/v1');
  assert.equal(artifact.matrix.workflowRunId, 801);
  assert.equal(artifact.matrix.workflowRunAttempt, 2);
  assert.equal(artifact.matrix.kind, 'aggregate');
});

for (const mutation of [
  'missing-platform',
  'duplicate-platform',
  'source-sha-drift',
  'missing-stage',
  'duplicate-stage',
  'cross-os-cache',
  'tracked-wasm',
]) {
  test(`aggregate rejects ${mutation}`, async () => {
    const reports = await Promise.all(
      fixture.platforms.map((platform) => platformArtifact(platform)),
    );
    const mutated = structuredClone(reports);
    const operation = fixture.aggregateMutations[mutation];
    if (operation === 'missing-platform') mutated.pop();
    if (operation === 'duplicate-platform') mutated.push(structuredClone(mutated[0]));
    if (operation === 'source-sha-drift') mutated[1].sourceSha = fixture.invalidSourceSha;
    if (operation === 'missing-stage') mutated[0].reports.pop();
    if (operation === 'duplicate-stage') mutated[0].reports.push(structuredClone(mutated[0].reports[0]));
    if (operation === 'cross-os-cache') mutated[1].cache = { os: 'linux', architecture: 'x64', toolchain: 'foreign' };
    if (operation === 'tracked-wasm') mutated[2].trackedBinaryFiles = ['packages/engine/packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm'];

    const result = aggregatePlatformReports(mutated);
    assert.equal(result.ok, false, mutation);
    assert.equal(result.error.code, fixture.aggregateExpectedErrors[mutation], mutation);
    assert.notEqual(result.error.expected, undefined, mutation);
    assert.notEqual(result.error.observed, undefined, mutation);
    assert.equal(typeof result.error.hint, 'string', mutation);
  });
}
