import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  CLASSIFICATIONS,
  classifyPostMergeDelivery,
  classifyWorkflowRun,
  deriveFailureEvidence,
  exitCodeForFinding,
} from '../post-merge-monitor.mjs';
import { LANDED_REQUIRED_CONTEXTS } from '../editor-ci-contract-envelope.mjs';

const run = (overrides = {}) => ({
  id: 101,
  run_attempt: 1,
  workflow_id: 7,
  event: 'push',
  head_branch: 'main',
  head_sha: 'abc123',
  html_url: 'https://github.com/ForgeaX-Games/forgeax-editor/actions/runs/101',
  created_at: '2026-08-07T12:00:00Z',
  conclusion: 'success',
  ...overrides,
});

function producerRelease() {
  return {
    schemaVersion: 'forgeax-prerequisite-release/v1',
    artifactId: 'prerequisite-release-100-1',
    releaseDigest: `sha256:${'1'.repeat(64)}`,
    inventory: [{payloadClass: 'engine-dist', path: 'payload/engine-dist/index.js', sha256: '2'.repeat(64)}],
    producerRunId: '100',
    producerAttempt: 1,
    sourceSha: 'a'.repeat(40),
    recursivePins: [{path: 'packages/engine', pin: 'b'.repeat(40)}],
    producerSuccess: true,
    producerEnvironmentFingerprint: 'linux-x64-standard',
    compatibility: {os: 'linux', architecture: 'x64', capacityPool: ['standard', 'heavy']},
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

test('workflow is read-only, main-push scoped, and never attributes to monitor SHA', () => {
  const workflow = readFileSync(resolve('.github/workflows/post-merge-ci-monitor.yml'), 'utf8');
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /types:\s*\[completed\]/);
  assert.match(workflow, /branches:\s*\[main\]/);
  assert.match(workflow, /workflow_run\.event == 'push'/);
  assert.match(workflow, /actions:\s*read/);
  assert.match(workflow, /contents:\s*read/);
  assert.doesNotMatch(workflow, /(?:issues|contents|actions):\s*write/);
  assert.doesNotMatch(workflow, /rerun|issues\.create|issues:\s*write/i);
  assert.doesNotMatch(workflow, /github\.sha(?![a-z_])/);
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

test('post-merge classifier requires producer join and exact landed delivery', () => {
  const landed = landedDelivery();
  const result = classifyPostMergeDelivery({
    workflowRun: run({id: 801, head_sha: landed.landedSha}),
    producer: producerRelease(),
    landed,
    monitorSha: 'e'.repeat(40),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'pass');
  assert.equal(result.classification, 'landed-delivery-success');
  assert.equal(result.envelope.provenance.targetSha, landed.landedSha);
  assert.equal(result.envelope.producer.releaseDigest, producerRelease().releaseDigest);
});

test('post-merge classifier returns structured pending or nonpass for every join mismatch', () => {
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
      input: {workflowRun: run({head_sha: landed.landedSha})},
      status: 'pending',
      code: 'producer-identity-missing',
    },
  ];
  for (const candidate of cases) {
    const result = classifyPostMergeDelivery(candidate.input);
    assert.equal(result.status, candidate.status, candidate.name);
    assert.equal(result.ok, candidate.status === 'pass', candidate.name);
    if (candidate.code) assert.equal(result.error.code, candidate.code, candidate.name);
  }
});
