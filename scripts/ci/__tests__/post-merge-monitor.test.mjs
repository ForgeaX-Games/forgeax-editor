import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  CLASSIFICATIONS,
  classifyPostMergeAdmission,
  classifyPostMergeSource,
  classifyWorkflowRun,
  deriveFailureEvidence,
  exitCodeForFinding,
  validatePortabilityAggregate,
  validatePostMergeWorkflowRun,
} from '../post-merge-monitor.mjs';
import { LANDED_REQUIRED_CONTEXTS } from '../editor-ci-contract-envelope.mjs';

const targetShaFixture = JSON.parse(readFileSync(resolve('scripts/ci/fixtures/post-merge-target-sha.json'), 'utf8'));
const landedFixture = JSON.parse(readFileSync(resolve('scripts/ci/fixtures/landed-delivery-cases.json'), 'utf8'));

const run = (overrides = {}) => ({
  id: 101,
  run_attempt: 1,
  workflow_id: 7,
  name: 'CI',
  status: 'completed',
  event: 'push',
  head_branch: 'main',
  head_sha: 'abc123',
  html_url: 'https://github.com/ForgeaX-Games/forgeax-editor/actions/runs/101',
  created_at: '2026-08-07T12:00:00Z',
  conclusion: 'success',
  ...overrides,
});

function producerRelease(overrides = {}) {
  return {
    schemaVersion: 'forgeax-prerequisite-release/v1',
    artifactId: 'prerequisite-release-100-1',
    releaseDigest: `sha256:${'1'.repeat(64)}`,
    inventory: [{payloadClass: 'engine-dist', path: 'payload/engine-dist/index.js', sha256: '2'.repeat(64)}],
    producerRunId: '100',
    producerAttempt: 1,
    sourceSha: 'c'.repeat(40),
    recursivePins: [{path: 'packages/engine', pin: 'b'.repeat(40)}],
    producerSuccess: true,
    producerEnvironmentFingerprint: 'linux-x64-standard',
    compatibility: {os: 'linux', architecture: 'x64', capacityPool: ['standard', 'heavy']},
    ...overrides,
  };
}

function landedDelivery(overrides = {}) {
  const landedSha = 'c'.repeat(40);
  return {
    landedSha,
    remoteMain: {
      sha: 'd'.repeat(40),
      ancestorSha: landedSha,
      ancestor: true,
      method: 'git-merge-base-is-ancestor',
      source: 'remote-main',
      repository: 'origin',
    },
    contexts: LANDED_REQUIRED_CONTEXTS.map((context) => ({
      context,
      sha: landedSha,
      conclusion: 'success',
      provenance: {kind: 'cloud', timingDomain: 'workflow-execution'},
    })),
    ...overrides,
  };
}

function portabilityAggregate() {
  const sourceSha = 'a'.repeat(40);
  const platforms = ['linux', 'windows', 'macos'];
  const stages = ['checkout', 'install', 'setup', 'wasm', 'zero-binary', 'type-static', 'capability-probe', 'smoke'];
  const platformReports = platforms.map((os) => {
    const platform = {os, architecture: 'x64', runnerImage: `${os}-runner`, toolchain: {bun: '1.3.14', bunRevision: 'bun-revision', node: '22.13.0', pnpm: '11.7.0', rust: 'rustc 1.93.0', wasmPack: 'wasm-pack 0.14.0', emscripten: 'emcc 4.0.15'}};
    const reports = stages.map((stage) => ({
      $schema: 'forgeax-editor-ci-report/v1',
      contractVersion: 'forgeax-editor-ci-report/v1',
      checkId: 'editor-portability',
      owner: 'editor-ci',
      profile: 'nightly/scheduled',
      executionHome: 'cloud',
      provenance: {kind: 'cloud', timingDomain: 'workflow-execution', recursivePins: [{path: 'packages/engine', pin: 'b'.repeat(40)}]},
      terminalStatus: 'pass', failureClass: null, code: null, expected: null, observed: null, hint: null, firstFailure: null,
      attempts: [{attempt: 1, attemptId: `${os}-${stage}`, status: 'pass'}], sloClaim: null, prerequisiteRelease: null,
      sourceSha, platform, stage,
      capability: {result: 'supported', browserMode: 'headless', browserChannel: 'chromium', navigatorGpu: true, adapter: true, device: true, features: [], backend: 'webgpu'},
      matrix: {kind: 'platform', sourceSha, platforms: [os], terminalResults: stages.map((entry) => ({platform: os, stage: entry, terminalStatus: 'pass', sourceSha}))},
    }));
    return {platform: os, sourceSha, reports};
  });
  return {
    $schema: 'forgeax-editor-ci-report/v1', contractVersion: 'forgeax-editor-ci-report/v1', checkId: 'editor-portability', owner: 'editor-ci', profile: 'nightly/scheduled', executionHome: 'cloud',
    provenance: {kind: 'cloud', timingDomain: 'workflow-execution', recursivePins: [{path: 'packages/engine', pin: 'b'.repeat(40)}]},
    terminalStatus: 'pass', failureClass: null, code: null, expected: null, observed: null, hint: null, firstFailure: null,
    attempts: [{attempt: 2, attemptId: 'workflow-run-801-attempt-2', status: 'pass'}], sloClaim: null, prerequisiteRelease: null, sourceSha,
    matrix: {kind: 'aggregate', sourceSha, workflowRunId: 801, workflowRunAttempt: 2, platforms, terminalResults: platformReports.flatMap(({platform, reports}) => reports.map((report) => ({platform, stage: report.stage, terminalStatus: report.terminalStatus, sourceSha}))), platformReports},
  };
}

function assertAttribution(finding, expected = run()) {
  assert.equal(finding.head_sha, expected.head_sha);
  assert.equal(finding.html_url, expected.html_url);
  assert.equal(typeof finding.red, 'boolean');
  assert.ok(Array.isArray(finding.evidence));
}

test('classifies a successful run and keeps it green', () => {
  const finding = classifyWorkflowRun({ run: run() });
  assert.equal(finding.classification, 'success');
  assert.equal(finding.red, false);
  assert.equal(finding.actionable, false);
  assertAttribution(finding);
});

test('classifies repository-source failure from the first failed job', () => {
  const current = run({ conclusion: 'failure' });
  const finding = classifyWorkflowRun({
    run: current,
    jobs: [{ name: 'typecheck', conclusion: 'failure', steps: [{ name: 'bun test', conclusion: 'failure' }] }],
  });
  assert.equal(finding.classification, 'repository-source-failure');
  assert.equal(finding.red, true);
  assert.equal(finding.actionable, true);
  assert.deepEqual(finding.evidence.map((item) => item.code), ['failed-job', 'failed-step']);
  assertAttribution(finding, current);
});

test('classifies deterministic environment failure from a bounded signature', () => {
  const current = run({ conclusion: 'failure' });
  const finding = classifyWorkflowRun({
    run: current,
    logText: 'Run setup\nError: No space left on device\n',
  });
  assert.equal(finding.classification, 'deterministic-environment-failure');
  assert.equal(finding.red, true);
  assert.equal(finding.actionable, true);
  assert.ok(finding.evidence.some((item) => item.code === 'workspace-storage-exhausted'));
  assertAttribution(finding, current);
});

test('classifies evidenced external transport failure without masking red', () => {
  const current = run({ conclusion: 'failure' });
  const finding = classifyWorkflowRun({
    run: current,
    logText: 'fetch failed: ECONNRESET while downloading the browser artifact',
  });
  assert.equal(finding.classification, 'external-transport-failure');
  assert.equal(finding.red, true);
  assert.equal(finding.actionable, true);
  assert.ok(finding.evidence.some((item) => item.code === 'connection-reset'));
  assertAttribution(finding, current);
});

test('classifies a genuine cancellation as red and actionable', () => {
  const current = run({ conclusion: 'cancelled' });
  const finding = classifyWorkflowRun({ run: current });
  assert.equal(finding.classification, 'genuine-cancellation');
  assert.equal(finding.red, true);
  assert.equal(finding.actionable, true);
  assertAttribution(finding, current);
});

test('classifies cancellation superseded by a newer main-push run', () => {
  const current = run({ conclusion: 'cancelled' });
  const newer = run({ id: 102, head_sha: 'def456', created_at: '2026-08-07T12:01:00Z', conclusion: 'success' });
  const finding = classifyWorkflowRun({ run: current, relatedRuns: [newer] });
  assert.equal(finding.classification, 'cancellation-superseded-by-newer-run');
  assert.equal(finding.red, true);
  assert.equal(finding.actionable, false);
  assertAttribution(finding, current);
});

test('classifies an older same-SHA delivery as duplicate while preserving red', () => {
  const current = run({ conclusion: 'failure' });
  const earlier = run({ id: 100, created_at: '2026-08-07T11:59:00Z', conclusion: 'failure' });
  const finding = classifyWorkflowRun({ run: current, relatedRuns: [earlier] });
  assert.equal(finding.classification, 'duplicate-same-sha-delivery');
  assert.equal(finding.red, true);
  assert.equal(finding.actionable, false);
  assertAttribution(finding, current);
});

test('red findings exit 1 while success exits 0', () => {
  const green = classifyWorkflowRun({ run: run() });
  const red = classifyWorkflowRun({ run: run({ conclusion: 'failure' }) });
  assert.equal(exitCodeForFinding(green), 0);
  assert.equal(exitCodeForFinding(red), 1);
});

test('all required classifications are represented by deterministic fixtures', () => {
  const observed = new Set([
    classifyWorkflowRun({ run: run() }).classification,
    classifyWorkflowRun({ run: run({ conclusion: 'failure' }) }).classification,
    classifyWorkflowRun({ run: run({ conclusion: 'failure' }), logText: 'command not found' }).classification,
    classifyWorkflowRun({ run: run({ conclusion: 'failure' }), logText: 'ECONNRESET' }).classification,
    classifyWorkflowRun({ run: run({ conclusion: 'cancelled' }) }).classification,
    classifyWorkflowRun({
      run: run({ conclusion: 'cancelled' }),
      relatedRuns: [run({ id: 102, head_sha: 'new', created_at: '2026-08-07T12:01:00Z' })],
    }).classification,
    classifyWorkflowRun({ run: run({ conclusion: 'failure' }), relatedRuns: [run({ id: 100, created_at: '2026-08-07T11:59:00Z' })] }).classification,
  ]);
  assert.deepEqual([...observed].sort(), [...CLASSIFICATIONS].sort());
});

test('evidence is bounded and raw log content does not escape the classifier', () => {
  const secret = 'TOP-SECRET-DO-NOT-EMIT';
  const derived = deriveFailureEvidence({
    jobs: [{ name: 'typecheck', conclusion: 'failure' }],
    logText: `${secret}\n${'x'.repeat(50000)}\nECONNRESET`,
  });
  assert.ok(derived.evidence.length <= 4);
  assert.ok(derived.evidence.every((item) => item.detail.length <= 220));
  assert.ok(!JSON.stringify(derived).includes(secret));
});

test('workflow is main-push scoped, writes deduplicated issues, and never attributes to monitor SHA', () => {
  const workflow = readFileSync(resolve('.github/workflows/post-merge-ci-monitor.yml'), 'utf8');
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /types:\s*\[completed\]/);
  assert.match(workflow, /branches:\s*\[main\]/);
  assert.match(workflow, /workflow_run\.event == 'push'/);
  assert.match(workflow, /actions:\s*read/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /issues:\s*write/);
  assert.match(workflow, /issues\.create/);
  assert.match(workflow, /issues\.createComment/);
  assert.match(workflow, /issues\.update/);
  assert.match(workflow, /retry-exempt-status-codes:\s*400,401,403,404,422/);
  assert.match(workflow, /\*\*merge sha\*\*/);
  assert.match(workflow, /sha-rerun-green/);
  assert.match(workflow, /sha-progressed/);
  assert.doesNotMatch(workflow, /FORGEAX_HARNESS_DELIVERY_JSON/);
  assert.doesNotMatch(workflow, /HARNESS_DELIVERY_INPUT_PATH/);
  assert.doesNotMatch(workflow, /harness[-_]delivery|harness remote delivery/i);
  assert.doesNotMatch(workflow, /Download same-run portability aggregate/);
  assert.doesNotMatch(workflow, /PORTABILITY_AGGREGATE_PATH/);
  assert.doesNotMatch(workflow, /github\.event\.workflow_run\.head_sha\s*==\s*github\.sha/);
  assert.doesNotMatch(workflow, /github\.sha(?![a-z_])/);
});

test('post-merge monitor owns source evidence only and never joins harness delivery', () => {
  const source = readFileSync(resolve('scripts/ci/post-merge-monitor.mjs'), 'utf8');
  assert.doesNotMatch(source, /FORGEAX_HARNESS_DELIVERY_JSON/);
  assert.doesNotMatch(source, /HARNESS_DELIVERY_INPUT_PATH/);
  assert.doesNotMatch(source, /harness[-_]delivery|harness remote delivery/i);
  assert.doesNotMatch(source, /validateDeliveryJoin|deliveryInputFromWorkflow|hasConfiguredHarnessDeliveryInput/);
});

test('CI documentation declares the external harness delivery boundary', () => {
  const readme = readFileSync(resolve('scripts/ci/README.md'), 'utf8');
  assert.match(readme, /Editor CI only proves Editor source evidence/i);
  assert.match(readme, /harness commit, push, and reachability are owned by the harness/i);
  assert.match(readme, /external delivery authority/i);
  assert.match(readme, /not a post-merge monitor input or terminal state/i);
});

function admissionFixture(overrides = {}) {
  const targetSha = 'a'.repeat(40);
  const workflowRun = run({
    id: 801,
    run_attempt: 2,
    name: 'CI',
    status: 'completed',
    conclusion: 'success',
    event: 'push',
    head_branch: 'main',
    head_sha: targetSha,
    html_url: 'https://github.com/ForgeaX-Games/forgeax-editor/actions/runs/801',
  });
  const jobs = LANDED_REQUIRED_CONTEXTS.map((name, index) => ({
    id: 900 + index,
    name,
    run_id: workflowRun.id,
    run_attempt: workflowRun.run_attempt,
    head_sha: targetSha,
    conclusion: 'success',
  }));
  return {
    workflowRun,
    targetSha,
    jobs,
    liveRuleset: {id: 17, name: 'main-required-checks', requiredContexts: [...LANDED_REQUIRED_CONTEXTS]},
    requiredContexts: [...LANDED_REQUIRED_CONTEXTS],
    workflowAdmission: {ok: true},
    ...overrides,
  };
}

test('source-only admission succeeds without harness configuration and preserves exact run identity', () => {
  const previous = process.env.FORGEAX_HARNESS_DELIVERY_JSON;
  delete process.env.FORGEAX_HARNESS_DELIVERY_JSON;
  try {
    const result = classifyPostMergeAdmission(admissionFixture());
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.envelope.requiredContexts, LANDED_REQUIRED_CONTEXTS);
    assert.equal(result.envelope.attempts[0].run_id, 801);
    assert.equal(result.envelope.attempts[0].run_attempt, 2);
    assert.doesNotMatch(JSON.stringify(result), /harness|overall[-_ ]?delivery|terminal verdict/i);
  } finally {
    if (previous === undefined) delete process.env.FORGEAX_HARNESS_DELIVERY_JSON;
    else process.env.FORGEAX_HARNESS_DELIVERY_JSON = previous;
  }
});

test('admission fails closed for missing or drifted live source policy evidence', () => {
  const cases = [
    {
      name: 'live ruleset missing',
      mutate: (input) => { delete input.liveRuleset; },
      code: 'live-ruleset-unavailable',
    },
    {
      name: 'required contexts drift',
      mutate: (input) => { input.liveRuleset.requiredContexts = ['b2-self-boot']; },
      code: 'required-context-drift',
    },
    {
      name: 'workflow admission missing',
      mutate: (input) => { input.workflowAdmission = {ok: false, errors: [{code: 'workflow-admission-invalid', hint: 'repair admission'}]}; },
      code: 'workflow-admission-invalid',
    },
    {
      name: 'required context job missing',
      mutate: (input) => { input.jobs = input.jobs.slice(0, -1); },
      code: 'required-context-job-missing',
    },
    {
      name: 'run attempt drift',
      mutate: (input) => { input.jobs[0].run_attempt = 1; },
      code: 'run-attempt-mismatch',
    },
  ];
  for (const candidate of cases) {
    const input = admissionFixture();
    candidate.mutate(input);
    const result = classifyPostMergeAdmission(input);
    assert.equal(result.ok, false, candidate.name);
    assert.equal(result.envelope.firstFailure.code, candidate.code, candidate.name);
    assert.notEqual(result.envelope.expected, undefined, candidate.name);
    assert.notEqual(result.envelope.observed, undefined, candidate.name);
    assert.equal(typeof result.envelope.hint, 'string', candidate.name);
  }
});

test('post-merge monitor admits the live policy before classifying success', () => {
  const source = readFileSync(resolve('scripts/ci/post-merge-monitor.mjs'), 'utf8');
  assert.match(source, /discoverLiveRuleset/);
  assert.match(source, /validateRuntimeProjection/);
  assert.match(source, /classifyPostMergeAdmission/);
  assert.ok(source.indexOf('const admission = classifyPostMergeAdmission') < source.indexOf('const finding = admission.ok'));
  assert.match(source, /liveAdmissionError/);
});

test('run attribution is mandatory', () => {
  assert.throws(() => classifyWorkflowRun({ run: run({ head_sha: '' }) }), /head_sha/);
  assert.throws(() => classifyWorkflowRun({ run: run({ html_url: '' }) }), /html_url/);
});

test('workflow_run eligibility is fail-closed and keeps the explicit target separate from monitor checkout', () => {
  const eligible = targetShaFixture.workflowCases.find((candidate) => candidate.valid);
  const valid = validatePostMergeWorkflowRun({
    workflowRun: eligible.workflowRun,
    targetSha: eligible.targetSha,
    monitorSha: eligible.monitorSha,
  });
  assert.equal(valid.ok, true, JSON.stringify(valid));

  for (const candidate of targetShaFixture.workflowCases.filter((entry) => !entry.valid)) {
    const workflowRun = structuredClone(eligible.workflowRun);
    Object.assign(workflowRun, candidate.mutate ?? {});
    const result = validatePostMergeWorkflowRun({
      workflowRun,
      targetSha: candidate.targetSha ?? eligible.targetSha,
      monitorSha: candidate.monitorSha ?? eligible.monitorSha,
    });
    assert.equal(result.ok, false, candidate.name);
    assert.equal(result.status, candidate.expectedStatus, candidate.name);
    assert.equal(result.error.code, candidate.expectedCode === 'portability-source-sha-mismatch' ? 'portability-aggregate-invalid' : candidate.expectedCode, candidate.name);
    assert.equal(typeof result.error.hint, 'string', candidate.name);
    assert.notEqual(result.error.expected, undefined, candidate.name);
    assert.notEqual(result.error.observed, undefined, candidate.name);
  }
});

test('workflow_run target remains valid when monitor checkout is the same commit', () => {
  const eligible = targetShaFixture.workflowCases.find((candidate) => candidate.valid);
  const result = validatePostMergeWorkflowRun({
    workflowRun: eligible.workflowRun,
    targetSha: eligible.targetSha,
    monitorSha: eligible.targetSha,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.targetSha, eligible.workflowRun.head_sha);
  assert.equal(result.monitorSha, eligible.targetSha);
});

test('portability aggregate must prove the same workflow run, source SHA, platforms, and terminal stages', () => {
  const artifactFixture = portabilityAggregate();
  const workflowRun = {id: artifactFixture.matrix.workflowRunId, run_attempt: artifactFixture.matrix.workflowRunAttempt, head_sha: artifactFixture.sourceSha};
  const valid = validatePortabilityAggregate({
    artifact: artifactFixture,
    workflowRun,
  });
  assert.equal(valid.ok, true, JSON.stringify(valid));

  for (const candidate of landedFixture.portabilityCases) {
    const artifact = candidate.artifact === null
      ? null
      : structuredClone(artifactFixture);
    if (artifact && candidate.mutation) {
      for (const [field, value] of Object.entries(candidate.mutation)) {
        if (field === 'failureStage') {
          const [platform, stage] = value.split(':');
          const terminal = artifact.matrix.terminalResults.find((entry) => entry.platform === platform && entry.stage === stage);
          terminal.terminalStatus = 'failure';
          const platformReport = artifact.matrix.platformReports.find((entry) => entry.platform === platform);
          const report = platformReport.reports.find((entry) => entry.stage === stage);
          report.terminalStatus = 'failure';
          report.failureClass = 'environment'; report.code = 'native-stage-failed'; report.expected = 'stage passes'; report.observed = 'failure'; report.hint = 'repair stage'; report.firstFailure = {attempt: 1, attemptId: 'failure', code: 'native-stage-failed', expected: 'stage passes', observed: 'failure'};
        } else {
          if (['workflowRunId', 'workflowRunAttempt', 'platforms', 'terminalResults'].includes(field)) artifact.matrix[field] = value;
          else artifact[field] = value;
        }
      }
    }
    const result = validatePortabilityAggregate({artifact, workflowRun});
    assert.equal(result.ok, false, candidate.name);
    assert.equal(result.status, candidate.expectedStatus, candidate.name);
    assert.equal(result.error.code, candidate.expectedCode === 'portability-source-sha-mismatch' ? 'portability-aggregate-invalid' : candidate.expectedCode, candidate.name);
    assert.equal(typeof result.error.hint, 'string', candidate.name);
    assert.notEqual(result.error.expected, undefined, candidate.name);
    assert.notEqual(result.error.observed, undefined, candidate.name);
  }
});

test('portability aggregate rejects a nested stage missing the shared base envelope', () => {
  const artifact = portabilityAggregate();
  delete artifact.matrix.platformReports[0].reports[0].attempts;
  delete artifact.matrix.platformReports[0].reports[0].provenance;
  const workflowRun = {id: artifact.matrix.workflowRunId, run_attempt: artifact.matrix.workflowRunAttempt, head_sha: artifact.sourceSha};

  const result = validatePortabilityAggregate({artifact, workflowRun});

  assert.equal(result.ok, false);
  assert.equal(result.status, 'nonpass');
  assert.equal(result.error.code, 'portability-aggregate-invalid');
});

test('post-merge classifier requires producer and exact source evidence', () => {
  const landed = landedDelivery();
  const result = classifyPostMergeSource({
    workflowRun: run({id: 801, head_sha: landed.landedSha}),
    producer: producerRelease(),
    landed,
    monitorSha: 'e'.repeat(40),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'pass');
  assert.equal(result.classification, 'source-evidence-success');
  assert.equal(result.envelope.provenance.targetSha, landed.landedSha);
  assert.equal(result.envelope.producer.releaseDigest, producerRelease().releaseDigest);
});

test('post-merge classifier returns structured pending or nonpass for every source mismatch', () => {
  const landed = landedDelivery();
  const cases = [
    {
      name: 'wrong target SHA',
      input: {workflowRun: run({head_sha: 'f'.repeat(40)}), producer: producerRelease(), landed},
      status: 'nonpass',
      code: 'post-merge-target-sha-mismatch',
    },
    {
      name: 'missing landed context',
      input: {
        workflowRun: run({head_sha: landed.landedSha}),
        producer: producerRelease(),
        landed: landedDelivery({contexts: landed.contexts.slice(0, -1)}),
      },
      status: 'pending',
      code: 'landed-required-contexts-missing',
    },
    {
      name: 'duplicate target run',
      input: {
        workflowRun: run({id: 801, head_sha: landed.landedSha}),
        relatedRuns: [run({id: 800, head_sha: landed.landedSha, created_at: '2026-08-07T11:59:00Z'})],
        producer: producerRelease(),
        landed,
      },
      status: 'nonpass',
      code: 'duplicate-same-sha-delivery',
    },
    {
      name: 'monitor checkout cannot replace target',
      input: {
        workflowRun: run({head_sha: landed.landedSha}),
        monitorSha: 'e'.repeat(40),
        producer: producerRelease(),
        landed,
      },
      status: 'pass',
      code: null,
    },
    {
      name: 'unclassified delivery without evidence',
      input: {workflowRun: run({head_sha: landed.landedSha}), landed},
      status: 'pending',
      code: 'producer-identity-missing',
    },
  ];
  for (const candidate of cases) {
    const result = classifyPostMergeSource(candidate.input);
    assert.equal(result.status, candidate.status, candidate.name);
    assert.equal(result.ok, candidate.status === 'pass', candidate.name);
    if (candidate.code) assert.equal(result.error.code, candidate.code, candidate.name);
  }
});
