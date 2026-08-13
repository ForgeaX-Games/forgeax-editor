import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { validate } from '../prerequisite-release.mjs';

const fixturePath = resolve('scripts/ci/fixtures/prerequisite-release-cases.json');

test('prerequisite rejection cases expose structured recovery fields before use', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  for (const mutation of fixture.rejectionCases) {
    let entered = false;
    const result = validate({
      ...mutation.input,
      onValidated() {
        entered = true;
      },
    });

    assert.equal(result.ok, false, mutation.name);
    assert.equal(result.error.code, mutation.expected.code, mutation.name);
    assert.equal(
      result.error.failedField ?? result.error.payloadClass,
      mutation.expected.failedField ?? mutation.expected.payloadClass,
      mutation.name,
    );
    assert.deepEqual(result.error.expected, mutation.expected.expected, mutation.name);
    assert.deepEqual(result.error.observed, mutation.expected.observed, mutation.name);
    assert.equal(result.error.affectedConsumer, mutation.input.consumer, mutation.name);
    assert.equal(result.error.artifactId, mutation.input.manifest.artifactId, mutation.name);
    assert.equal(typeof result.error.hint, 'string', mutation.name);
    assert.ok(result.error.hint.length > 0, mutation.name);
    assert.equal(entered, false, mutation.name);
  }
});

test('producer and attempt failures remain terminal structured errors', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const cases = fixture.rejectionCases.filter(({expected}) => (
    ['producer-failure', 'attempt-mismatch'].includes(expected.code)
  ));

  for (const mutation of cases) {
    const result = validate(mutation.input);
    assert.equal(result.ok, false, mutation.name);
    assert.equal(result.error.code, mutation.expected.code, mutation.name);
    assert.equal(result.error.affectedConsumer, mutation.input.consumer, mutation.name);
    assert.equal(result.error.artifactId, mutation.input.manifest.artifactId, mutation.name);
    assert.notEqual(result.error.expected, undefined, mutation.name);
    assert.notEqual(result.error.observed, undefined, mutation.name);
    assert.equal(typeof result.error.hint, 'string', mutation.name);
  }
});
