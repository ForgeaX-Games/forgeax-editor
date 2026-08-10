import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  appendPostMergeAttempt,
  decidePostMergeRetry,
} from './post-merge-monitor.mjs';

const fixturePath = resolve('scripts/ci/fixtures/post-merge-retry-cases.json');

function envelopeFor(mutation) {
  return {
    terminalStatus: 'failure',
    failureClass: mutation.failureClass,
    firstFailure: {
      attempt: 1,
      attemptId: 'attempt-1',
      code: 'first-failure',
      expected: 'success',
      observed: 'failure',
    },
    attempts: Array.from({ length: mutation.attemptCount }, (_, index) => ({
      attempt: index + 1,
      attemptId: `attempt-${index + 1}`,
      status: 'failure',
      transient: mutation.transient,
    })),
  };
}

test('retry policy is bounded by class, evidence, and attempt count', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  for (const mutation of fixture.cases) {
    const decision = decidePostMergeRetry(envelopeFor(mutation));
    assert.equal(decision.retry, mutation.retry, mutation.name);
    assert.equal(decision.maxAttempts, mutation.maxAttempts, mutation.name);
  }
});

test('appending a retry preserves both attempts and the first failure', () => {
  const initial = envelopeFor({ failureClass: 'external-transport', transient: true, attemptCount: 1 });
  const updated = appendPostMergeAttempt(initial, {
    attempt: 2,
    attemptId: 'attempt-2',
    status: 'failure',
    transient: true,
    code: 'second-failure',
  });

  assert.equal(updated.attempts.length, 2);
  assert.equal(updated.attempts[0].attemptId, 'attempt-1');
  assert.equal(updated.attempts[1].attemptId, 'attempt-2');
  assert.equal(updated.firstFailure.attemptId, 'attempt-1');
  assert.equal(updated.firstFailure.code, 'first-failure');
  assert.equal(decidePostMergeRetry(updated).retry, false);
});

test('non-external failures cannot be made retryable by transient text', () => {
  for (const failureClass of ['source', 'environment', 'admission']) {
    const envelope = envelopeFor({ failureClass, transient: true, attemptCount: 1 });
    assert.equal(decidePostMergeRetry(envelope).retry, false, failureClass);
  }
});
