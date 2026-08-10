import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  ENVELOPE_FIELDS,
  normalizeEnvelope,
  planRetry,
  validateEnvelope,
} from './editor-ci-contract-envelope.mjs';

const fixturePath = resolve('scripts/ci/fixtures/editor-ci-contract-envelope-cases.json');

function failureInput(failureClass, transient) {
  const firstFailure = {
    attempt: 1,
    attemptId: 'attempt-local-1',
    code: `${failureClass}-failure`,
    expected: 'check passes',
    observed: 'check failed',
  };
  return {
    checkId: 'b2-self-boot',
    owner: 'editor-ci',
    profile: 'local-fast',
    executionHome: 'local-fast',
    provenance: {
      kind: 'local',
      revision: 'a'.repeat(40),
      timingDomain: 'local-execution',
    },
    terminalStatus: 'failure',
    failureClass,
    code: firstFailure.code,
    expected: firstFailure.expected,
    observed: firstFailure.observed,
    hint: `inspect ${failureClass}`,
    firstFailure,
    attempts: [
      {
        attempt: 1,
        attemptId: firstFailure.attemptId,
        transient,
        status: 'failure',
      },
    ],
    sloClaim: null,
  };
}

test('all terminal results normalize to the same machine-readable envelope', () => {
  const cases = JSON.parse(readFileSync(fixturePath, 'utf8')).cases;
  for (const mutation of cases) {
    const envelope = normalizeEnvelope(failureInput(mutation.failureClass, mutation.transient));
    const validation = validateEnvelope(envelope);
    assert.equal(validation.ok, true, mutation.name);
    assert.deepEqual(Object.keys(envelope).sort(), [...ENVELOPE_FIELDS].sort(), mutation.name);
    assert.equal(envelope.firstFailure.attemptId, 'attempt-local-1', mutation.name);
    assert.equal(envelope.attempts.length, 1, mutation.name);
  }
});

test('retry policy is bounded by failure class and transient evidence', () => {
  const cases = JSON.parse(readFileSync(fixturePath, 'utf8')).cases;
  for (const mutation of cases) {
    const envelope = normalizeEnvelope(failureInput(mutation.failureClass, mutation.transient));
    const retry = planRetry(envelope);
    assert.equal(retry.retry, mutation.expectedRetry, mutation.name);
    assert.equal(retry.maxAttempts, mutation.expectedMaxAttempts, mutation.name);
  }
});

test('missing envelope fields are structured failures rather than thrown strings', () => {
  const envelope = normalizeEnvelope(failureInput('source', false));
  delete envelope.hint;
  const result = validateEnvelope(envelope);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'envelope-field-missing');
  assert.equal(result.error.expected, 'hint');
  assert.notEqual(result.error.observed, undefined);
  assert.equal(typeof result.error.hint, 'string');
});
