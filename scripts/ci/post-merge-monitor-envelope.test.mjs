import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  POST_MERGE_CONTRACT_VERSION,
  buildPostMergeEnvelope,
  validatePostMergeEnvelope,
} from './post-merge-monitor.mjs';

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
