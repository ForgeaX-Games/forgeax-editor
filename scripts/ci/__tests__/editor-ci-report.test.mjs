import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { projectEditorCiReport, validateEditorCiReport } from '../editor-ci-report.mjs';

const fixturePath = resolve('scripts/ci/fixtures/editor-ci-report.json');

test('report projection keeps stable keys and first failure before attempts', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const report = projectEditorCiReport(fixture.report);
  const validation = validateEditorCiReport(report);

  assert.equal(validation.ok, true);
  for (const key of fixture.requiredKeys) assert.ok(Object.hasOwn(report, key), key);
  assert.equal(report.firstFailure.attempt, 1);
  assert.equal(report.attempts[0].attempt, 1);
  assert.equal(report.sloClaim, null);
  assert.equal(report.provenance.timingDomain, 'post-merge-workflow');
});

test('report exposes an executable hint without requiring log parsing', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const report = projectEditorCiReport(fixture.report);
  assert.equal(report.hint, 'retry once after transport recovery');
  assert.equal(report.observed, 'GitHub API connection reset');
});

test('navigation fixtures require the same contract vocabulary in both README entries', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const english = readFileSync(resolve('README.md'), 'utf8');
  const chinese = readFileSync(resolve('README.zh-CN.md'), 'utf8');
  for (const token of fixture.navigationTokens) {
    assert.ok(english.toLowerCase().includes(token.toLowerCase()), `README.md: ${token}`);
    assert.ok(chinese.toLowerCase().includes(token.toLowerCase()), `README.zh-CN.md: ${token}`);
  }
});

test('report validation rejects missing recovery or first-failure fields', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  for (const field of ['hint', 'firstFailure']) {
    const report = projectEditorCiReport(fixture.report);
    delete report[field];
    const validation = validateEditorCiReport(report);
    assert.equal(validation.ok, false, field);
    assert.equal(validation.error.code, 'report-field-missing', field);
  }
});

test('portability report projects platform, stage, capability, matrix, and source SHA', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const report = projectEditorCiReport(fixture.portabilityReport);
  const validation = validateEditorCiReport(report);

  assert.equal(validation.ok, true, JSON.stringify(validation));
  assert.equal(report.sourceSha, 'a'.repeat(40));
  assert.equal(report.platform.os, 'linux');
  assert.equal(report.stage, 'smoke');
  assert.equal(report.capability.browserMode, 'headless');
  assert.deepEqual(report.matrix.platforms, ['linux']);
  assert.equal(report.matrix.kind, 'platform');
  assert.equal(report.matrix.terminalResults.length, 1);
});

test('portability report requires every projection field with structured errors', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  for (const field of ['sourceSha', 'platform', 'stage', 'capability', 'matrix']) {
    const report = projectEditorCiReport(fixture.portabilityReport);
    delete report[field];
    const validation = validateEditorCiReport(report);
    assert.equal(validation.ok, false, field);
    assert.equal(validation.error.code, 'report-portability-field-missing', field);
    assert.equal(validation.error.expected, field, field);
    assert.equal(typeof validation.error.hint, 'string', field);
  }
});

test('portability matrix rejects duplicate platform-stage terminal results', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const report = projectEditorCiReport(fixture.portabilityReport);
  report.matrix.terminalResults.push({platform: 'linux', stage: 'smoke', terminalStatus: 'pass', sourceSha: report.sourceSha});
  const validation = validateEditorCiReport(report);

  assert.equal(validation.ok, false);
  assert.equal(validation.error.code, 'report-matrix-terminal-duplicate');
  assert.equal(typeof validation.error.hint, 'string');
});

test('portability matrix rejects a null terminal result without throwing', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const report = projectEditorCiReport(fixture.portabilityReport);
  report.matrix.terminalResults[0] = null;

  const validation = validateEditorCiReport(report);

  assert.equal(validation.ok, false);
  assert.equal(validation.error.code, 'report-matrix-terminal-invalid');
});

test('portability skipped is bounded to capability-probe or smoke', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const report = projectEditorCiReport({
    ...fixture.portabilityReport,
    terminalStatus: 'skipped',
    stage: 'smoke',
    capability: {
      result: 'bounded-non-applicable',
      browserMode: 'unavailable',
      browserChannel: 'chromium',
      navigatorGpu: false,
      adapter: false,
      device: false,
      features: [],
      backend: null,
      boundary: 'no supported headed or headless browser path',
      hint: 'install a supported browser capability and rerun smoke',
    },
  });
  assert.equal(validateEditorCiReport(report).ok, true);

  const requiredStage = projectEditorCiReport({...fixture.portabilityReport, terminalStatus: 'skipped', stage: 'install'});
  const validation = validateEditorCiReport(requiredStage);
  assert.equal(validation.ok, false);
  assert.equal(validation.error.code, 'report-skipped-stage-invalid');
});

test('required-stage failure capability projection is a discriminated declaration shape', () => {
  const declaration = readFileSync(resolve('scripts/ci/editor-ci-report.d.mts'), 'utf8');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const report = projectEditorCiReport({
    ...fixture.portabilityReport,
    terminalStatus: 'failure',
    stage: 'setup',
    capability: {result: 'not-applicable', stage: 'setup'},
    failureClass: 'environment',
    code: 'required-toolchain-missing',
    expected: 'wasm-pack is installed',
    observed: 'missing',
    hint: 'Install the pinned native toolchain before retrying setup.',
    firstFailure: {stage: 'setup', code: 'required-toolchain-missing'},
  });

  assert.equal(validateEditorCiReport(report).ok, true);
  assert.match(declaration, /export type EditorCiRequiredPortabilityStage = Exclude/);
  assert.match(declaration, /export declare const EDITOR_CI_ORDINARY_CHECK_IDS/);
  assert.match(declaration, /readonly result: 'not-applicable';/);
  assert.match(declaration, /readonly stage: EditorCiRequiredPortabilityStage;/);

  const pass = structuredClone(report);
  pass.terminalStatus = 'pass';
  pass.failureClass = null;
  pass.code = null;
  pass.expected = null;
  pass.observed = null;
  pass.hint = null;
  pass.firstFailure = null;
  assert.equal(validateEditorCiReport(pass).ok, false);

  const mismatched = structuredClone(report);
  mismatched.capability.stage = 'install';
  assert.equal(validateEditorCiReport(mismatched).ok, false);
});

test('ordinary report validation rejects an unknown check discriminator', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const report = projectEditorCiReport({...fixture.report, checkId: 'unknown-ordinary-check'});
  const validation = validateEditorCiReport(report);

  assert.equal(validation.ok, false);
  assert.equal(validation.error.code, 'report-check-id-invalid');
  assert.ok(validation.error.expected.includes('typecheck'));
  assert.ok(validation.error.expected.includes('editor-portability'));
});

test('local aggregate reports accept only the matching profile discriminator', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const report = projectEditorCiReport({
    ...fixture.report,
    checkId: 'ci-profile',
    profile: 'fast',
    executionHome: 'local-fast',
    terminalStatus: 'pass',
    failureClass: null,
    code: null,
    expected: null,
    observed: null,
    hint: 'No recovery action is required.',
    firstFailure: null,
    attempts: [{attempt: 1, attemptId: 'local-fast', status: 'pass'}],
    provenance: {kind: 'local', timingDomain: 'local-execution', editorCommit: 'a'.repeat(40)},
  });
  const validation = validateEditorCiReport(report);

  assert.equal(validation.ok, true, JSON.stringify(validation));

  const mismatched = projectEditorCiReport({...report, executionHome: 'local-full'});
  const mismatchValidation = validateEditorCiReport(mismatched);
  assert.equal(mismatchValidation.ok, false);
  assert.equal(mismatchValidation.error.code, 'report-check-id-invalid');
});

test('bounded capability skips require an explicit boundary and recovery hint', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const report = projectEditorCiReport({
    ...fixture.portabilityReport,
    terminalStatus: 'skipped',
    stage: 'smoke',
    capability: {
      result: 'bounded-non-applicable',
      browserMode: 'unavailable',
      browserChannel: 'chromium',
      navigatorGpu: false,
      adapter: false,
      device: false,
      features: [],
      backend: null,
    },
  });
  const validation = validateEditorCiReport(report);
  assert.equal(validation.ok, false);
  assert.equal(validation.error.code, 'report-portability-capability-invalid');
});

test('public declaration and runtime use the same portability field names', () => {
  const declaration = readFileSync(resolve('scripts/ci/editor-ci-report.d.mts'), 'utf8');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const report = projectEditorCiReport(fixture.portabilityReport);
  assert.equal(validateEditorCiReport(report).ok, true);
  assert.equal(typeof report.capability.backend, 'string');
  assert.equal(Object.hasOwn(report.capability, 'gpuBackend'), false);
  assert.match(declaration, /readonly backend: string \| null/);
  assert.doesNotMatch(declaration, /gpuBackend/);
  assert.match(declaration, /readonly kind: 'platform';/);
  assert.match(declaration, /readonly kind: 'aggregate';/);
  assert.doesNotMatch(declaration, /requiredStages/);
  for (const field of ['sourceSha', 'platform', 'stage', 'capability', 'matrix']) {
    assert.match(declaration, new RegExp(`readonly ${field}[^?]`), field);
    assert.ok(Object.hasOwn(report, field), field);
  }
});

test('ordinary and portability runtime shapes match the conditional declaration union', () => {
  const declaration = readFileSync(resolve('scripts/ci/editor-ci-report.d.mts'), 'utf8');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const ordinary = projectEditorCiReport(fixture.report);
  const portability = projectEditorCiReport(fixture.portabilityReport);
  const portabilityFields = ['sourceSha', 'platform', 'stage', 'capability', 'matrix'];

  for (const field of portabilityFields) {
    assert.equal(Object.hasOwn(ordinary, field), false, `ordinary:${field}`);
    assert.equal(Object.hasOwn(portability, field), true, `portability:${field}`);
  }
  assert.match(declaration, /export type EditorCiReportBase =/);
  assert.match(declaration, /readonly checkId: EditorCiReportCheckId;/);
  assert.match(declaration, /EDITOR_CI_LOCAL_PROFILE_CHECK_ID: 'ci-profile'/);
  assert.match(declaration, /export type EditorCiPortabilityStageReport =/);
  assert.match(declaration, /readonly checkId: 'editor-portability';/);
  assert.match(declaration, /export type EditorCiReport = EditorCiReportBase \| EditorCiPortabilityReport;/);
});

function prerequisiteReleaseEnvelope(validation) {
  return {
    artifactId: 'prerequisite-release-100-1',
    releaseDigest: 'sha256:release-digest-100-1',
    schemaVersion: 'forgeax-prerequisite-release/v1',
    producerRunId: '100',
    producerAttempt: 1,
    sourceSha: 'a'.repeat(40),
    recursivePins: [{path: 'packages/engine', pin: 'b'.repeat(40)}],
    producerSuccess: validation.status === 'pass',
    compatibility: {
      status: validation.status === 'pass' ? 'compatible' : 'rejected',
      expected: validation.expected ?? null,
      observed: validation.observed ?? null,
    },
    validation,
  };
}

test('report projects prerequisite producer identity and compatibility outcome', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const prerequisiteRelease = prerequisiteReleaseEnvelope({
    status: 'pass',
    consumer: 'typecheck',
    payloadClasses: ['engine-dist', 'wgpu-wasm', 'bun-install-facts'],
  });
  const report = projectEditorCiReport({...fixture.report, prerequisiteRelease});
  const validation = validateEditorCiReport(report);

  assert.equal(validation.ok, true);
  assert.deepEqual(report.prerequisiteRelease, prerequisiteRelease);
  assert.equal(report.prerequisiteRelease.artifactId, 'prerequisite-release-100-1');
  assert.equal(report.prerequisiteRelease.releaseDigest, 'sha256:release-digest-100-1');
  assert.equal(report.prerequisiteRelease.producerRunId, '100');
  assert.equal(report.prerequisiteRelease.producerAttempt, 1);
  assert.equal(report.prerequisiteRelease.sourceSha, 'a'.repeat(40));
  assert.deepEqual(report.prerequisiteRelease.recursivePins, [
    {path: 'packages/engine', pin: 'b'.repeat(40)},
  ]);
  assert.notEqual(report.prerequisiteRelease.artifactId, report.provenance.targetSha);
  assert.equal(report.prerequisiteRelease.compatibility.status, 'compatible');
  assert.equal(report.prerequisiteRelease.validation.status, 'pass');
});

test('report keeps structured prerequisite recovery fields on failure', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const validationFailure = {
    status: 'failure',
    consumer: 'typecheck',
    code: 'source-mismatch',
    failedField: 'sourceSha',
    expected: 'a'.repeat(40),
    observed: 'c'.repeat(40),
    affectedConsumer: 'typecheck',
    artifactId: 'prerequisite-release-100-1',
    hint: 'produce a release for the requested source SHA',
  };
  const report = projectEditorCiReport({
    ...fixture.report,
    prerequisiteRelease: prerequisiteReleaseEnvelope(validationFailure),
  });
  const result = validateEditorCiReport(report);

  assert.equal(result.ok, true);
  assert.equal(report.prerequisiteRelease.validation.code, 'source-mismatch');
  assert.equal(report.prerequisiteRelease.validation.failedField, 'sourceSha');
  assert.equal(report.prerequisiteRelease.validation.expected, 'a'.repeat(40));
  assert.equal(report.prerequisiteRelease.validation.observed, 'c'.repeat(40));
  assert.equal(report.prerequisiteRelease.validation.affectedConsumer, 'typecheck');
  assert.equal(report.prerequisiteRelease.validation.artifactId, 'prerequisite-release-100-1');
  assert.equal(typeof report.prerequisiteRelease.validation.hint, 'string');
});

test('report validation rejects a missing prerequisite producer join', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const report = projectEditorCiReport({
    ...fixture.report,
    prerequisiteRelease: prerequisiteReleaseEnvelope({status: 'pass'}),
  });
  delete report.prerequisiteRelease;
  const result = validateEditorCiReport(report);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'report-prerequisite-release-missing');
  assert.notEqual(result.error.expected, undefined);
  assert.notEqual(result.error.observed, undefined);
  assert.equal(typeof result.error.hint, 'string');
});

test('all scoped cloud consumers retain the same producer join fields', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const producerFields = ['artifactId', 'releaseDigest', 'producerRunId', 'producerAttempt', 'sourceSha', 'recursivePins'];
  for (const consumer of ['b2-self-boot', 'typecheck', 'smoke-play']) {
    const report = projectEditorCiReport({
      ...fixture.report,
      checkId: consumer,
      prerequisiteRelease: prerequisiteReleaseEnvelope({
        status: 'pass',
        consumer,
        payloadClasses: consumer === 'smoke-play'
          ? ['engine-dist', 'wgpu-wasm', 'fbx-wasm', 'bun-install-facts']
          : ['engine-dist', 'wgpu-wasm', 'bun-install-facts'],
      }),
    });
    assert.equal(validateEditorCiReport(report).ok, true, consumer);
    for (const field of producerFields) assert.ok(Object.hasOwn(report.prerequisiteRelease, field), `${consumer}:${field}`);
    assert.equal(report.prerequisiteRelease.validation.consumer, consumer);
    assert.equal(report.prerequisiteRelease.validation.status, 'pass');
  }

  const failed = projectEditorCiReport({
    ...fixture.report,
    checkId: 'smoke-play',
    prerequisiteRelease: prerequisiteReleaseEnvelope({
      status: 'failure',
      consumer: 'smoke-play',
      code: 'missing-payload',
      failedField: 'fbx-wasm',
      expected: 'payload class fbx-wasm is present',
      observed: 'missing',
      affectedConsumer: 'smoke-play',
      artifactId: 'prerequisite-release-100-1',
      hint: 'produce the requested payload',
    }),
  });
  assert.equal(validateEditorCiReport(failed).ok, true);
  assert.equal(failed.prerequisiteRelease.validation.code, 'missing-payload');
  assert.equal(failed.prerequisiteRelease.validation.affectedConsumer, 'smoke-play');
  assert.equal(failed.prerequisiteRelease.producerSuccess, false);
});
