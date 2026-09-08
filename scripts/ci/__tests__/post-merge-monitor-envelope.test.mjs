import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  POST_MERGE_CONTRACT_VERSION,
  buildPostMergeEnvelope,
  buildPostMergeSourceEvidence,
  buildPostMergeSourceEnvelope,
  validatePostMergeEnvelope,
} from '../post-merge-monitor.mjs';
import { LANDED_REQUIRED_CONTEXTS } from '../editor-ci-contract-envelope.mjs';

const fixturePath = resolve('scripts/ci/fixtures/post-merge-target-sha.json');

function inputFor(mutation) {
  const targetSha = mutation.targetSha;
  const workflowRun = {
    id: mutation.runId,
    run_attempt: mutation.attempt,
    head_sha: mutation.headSha ?? targetSha,
    html_url: mutation.htmlUrl,
  };
  const job = {
    id: mutation.jobId,
    name: mutation.jobName,
    head_sha: targetSha,
    run_id: mutation.runId,
    run_attempt: mutation.attempt,
  };
  return {
    workflowRun,
    job,
    targetSha,
    contractVersion: mutation.contractVersion,
    monitorSha: mutation.monitorSha,
    envelopeOverrides: {
      runId: mutation.envelopeRunId,
      attempt: mutation.envelopeAttempt,
      jobId: mutation.envelopeJobId,
      targetSha: mutation.envelopeTargetSha,
    },
  };
}

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

function sourceEvidenceFixture() {
  const targetSha = 'a'.repeat(40);
  const workflowRun = {
    id: 801,
    run_attempt: 2,
    name: 'CI',
    status: 'completed',
    conclusion: 'success',
    event: 'push',
    head_branch: 'main',
    head_sha: targetSha,
    html_url: 'https://github.com/ForgeaX-Games/forgeax-editor/actions/runs/801',
  };
  const producer = producerRelease();
  producer.sourceSha = targetSha;
  const landed = landedDelivery({
    landedSha: targetSha,
    remoteMain: {
      sha: 'd'.repeat(40),
      ancestorSha: targetSha,
      ancestor: true,
      method: 'git-merge-base-is-ancestor',
      source: 'remote-main',
      repository: 'origin',
    },
    contexts: LANDED_REQUIRED_CONTEXTS.map((context) => ({
      context,
      sha: targetSha,
      conclusion: 'success',
      provenance: {kind: 'cloud', timingDomain: 'workflow-execution'},
    })),
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
    jobs,
    producer,
    landed,
    admission: {envelope: {terminalStatus: 'pass', requiredContexts: [...LANDED_REQUIRED_CONTEXTS]}},
    liveRuleset: {id: 17, name: 'main-required-checks', requiredContexts: [...LANDED_REQUIRED_CONTEXTS]},
    workflowAdmission: {ok: true},
    monitorSha: 'e'.repeat(40),
  };
}

test('target-SHA fixture builds a complete provenance envelope', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const valid = fixture.cases.find((mutation) => mutation.valid);
  const result = buildPostMergeEnvelope(inputFor(valid));

  assert.equal(result.ok, true);
  assert.equal(result.envelope.provenance.targetSha, valid.targetSha);
  assert.equal(result.envelope.provenance.runId, valid.runId);
  assert.equal(result.envelope.provenance.attempt, valid.attempt);
  assert.equal(result.envelope.provenance.htmlUrl, valid.htmlUrl);
  assert.equal(result.envelope.provenance.jobId, valid.jobId);
  assert.equal(result.envelope.contractVersion, POST_MERGE_CONTRACT_VERSION);
  assert.equal(validatePostMergeEnvelope(result.envelope, { targetSha: valid.targetSha }).ok, true);
});

test('target-SHA fixture rejects every provenance identity mismatch', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  for (const mutation of fixture.cases.filter((entry) => !entry.valid)) {
    const result = buildPostMergeEnvelope(inputFor(mutation));
    assert.equal(result.ok, false, mutation.name);
    assert.equal(result.error.code, mutation.expectedCode, mutation.name);
    assert.equal(typeof result.error.expected, 'string', mutation.name);
    assert.notEqual(result.error.observed, undefined, mutation.name);
    assert.equal(typeof result.error.hint, 'string', mutation.name);
  }
});

test('monitor checkout SHA is never accepted as target provenance', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const mutation = fixture.cases.find((entry) => entry.name.includes('monitor checkout'));
  const result = buildPostMergeEnvelope(inputFor(mutation));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'target-sha-mismatch');
});

test('source evidence projects one workflow run without harness delivery input', () => {
  const previous = process.env.FORGEAX_HARNESS_DELIVERY_JSON;
  delete process.env.FORGEAX_HARNESS_DELIVERY_JSON;
  try {
    const input = sourceEvidenceFixture();
    const result = buildPostMergeSourceEvidence(input);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.sourceEvidence.targetSha, input.workflowRun.head_sha);
    assert.equal(result.sourceEvidence.workflowRun.id, input.workflowRun.id);
    assert.equal(result.sourceEvidence.workflowRun.attempt, input.workflowRun.run_attempt);
    assert.equal(result.sourceEvidence.remoteMain.sha, input.landed.remoteMain.sha);
    assert.equal(result.sourceEvidence.remoteMain.ancestorSha, input.workflowRun.head_sha);
    assert.equal(result.sourceEvidence.remoteMain.ancestor, true);
    assert.deepEqual(result.sourceEvidence.requiredContexts.expected, LANDED_REQUIRED_CONTEXTS);
    assert.deepEqual(result.sourceEvidence.admission.requiredContexts, LANDED_REQUIRED_CONTEXTS);
    assert.equal(result.sourceEvidence.admission.liveRuleset.id, 17);
    assert.equal(result.sourceEvidence.producer.sourceSha, input.workflowRun.head_sha);
    assert.doesNotMatch(JSON.stringify(result), /harness|overall[-_ ]?delivery|terminal verdict/i);
  } finally {
    if (previous === undefined) delete process.env.FORGEAX_HARNESS_DELIVERY_JSON;
    else process.env.FORGEAX_HARNESS_DELIVERY_JSON = previous;
  }
});

test('source evidence fails closed for remote main, context, and producer drift', () => {
  const cases = [
    {
      name: 'remote main ancestry missing',
      mutate: (input) => { input.landed.remoteMain = null; },
      code: 'landed-remote-main-evidence-missing',
    },
    {
      name: 'remote main ancestry false',
      mutate: (input) => { input.landed.remoteMain.ancestor = false; },
      code: 'landed-remote-main-ancestry-invalid',
    },
    {
      name: 'required context missing',
      mutate: (input) => { input.landed.contexts = input.landed.contexts.slice(0, -1); },
      code: 'landed-required-contexts-missing',
    },
    {
      name: 'producer missing',
      mutate: (input) => { delete input.producer; },
      code: 'producer-identity-missing',
    },
    {
      name: 'producer source SHA drift',
      mutate: (input) => { input.producer.sourceSha = 'f'.repeat(40); },
      code: 'producer-source-sha-mismatch',
    },
  ];
  for (const candidate of cases) {
    const input = sourceEvidenceFixture();
    candidate.mutate(input);
    const result = buildPostMergeSourceEvidence(input);
    assert.equal(result.ok, false, candidate.name);
    assert.equal(result.error.code, candidate.code, candidate.name);
    assert.notEqual(result.error.expected, undefined, candidate.name);
    assert.notEqual(result.error.observed, undefined, candidate.name);
    assert.equal(typeof result.error.hint, 'string', candidate.name);
    assert.doesNotMatch(JSON.stringify(result), /harness|overall[-_ ]?delivery|terminal verdict/i, candidate.name);
  }
});

test('source envelope binds workflow target SHA to exact landed evidence', () => {
  const landed = landedDelivery();
  const result = buildPostMergeSourceEnvelope({
    workflowRun: {
      id: 801,
      run_attempt: 2,
      head_sha: landed.landedSha,
      html_url: 'https://github.com/ForgeaX-Games/forgeax-editor/actions/runs/801',
    },
    producer: producerRelease(),
    landed,
    monitorSha: 'e'.repeat(40),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.envelope.producer.artifactId, 'prerequisite-release-100-1');
  assert.equal(result.envelope.landed.landedSha, landed.landedSha);
  assert.equal(result.envelope.provenance.targetSha, landed.landedSha);
  assert.equal(result.envelope.provenance.monitorSha, 'e'.repeat(40));
});

test('source envelope rejects target, context, and producer drift before pass', () => {
  const landed = landedDelivery();
  const cases = [
    {
      name: 'workflow target SHA differs from landed SHA',
      mutate: (input) => { input.workflowRun.head_sha = 'f'.repeat(40); },
      code: 'post-merge-target-sha-mismatch',
    },
    {
      name: 'required landed context is missing',
      mutate: (input) => { input.landed.contexts = input.landed.contexts.slice(0, -1); },
      code: 'landed-required-contexts-missing',
    },
    {
      name: 'producer identity is missing',
      mutate: (input) => { delete input.producer; },
      code: 'producer-identity-missing',
    },
    {
      name: 'producer identity cannot alias landed SHA',
      mutate: (input) => { input.producer.landedSha = input.landed.landedSha; },
      code: 'producer-landed-sha-alias',
    },
  ];
  for (const candidate of cases) {
    const input = {
      workflowRun: {
        id: 801,
        run_attempt: 2,
        head_sha: landed.landedSha,
        html_url: 'https://github.com/ForgeaX-Games/forgeax-editor/actions/runs/801',
      },
      producer: producerRelease(),
      landed: structuredClone(landed),
      monitorSha: 'e'.repeat(40),
    };
    candidate.mutate(input);
    const result = buildPostMergeSourceEnvelope(input);
    assert.equal(result.ok, false, candidate.name);
    assert.equal(result.error.code, candidate.code, candidate.name);
    assert.notEqual(result.handoff, undefined, candidate.name);
  }
});
