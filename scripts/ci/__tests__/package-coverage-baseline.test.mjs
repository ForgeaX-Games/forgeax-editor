import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { buildCoverageBaseline } from '../package-coverage.mjs';

const fixturePath = resolve('scripts/ci/fixtures/package-coverage-lcov/baseline-cases.json');
const fixtureRoot = dirname(fixturePath);

function readEvidence(path) {
  return readFileSync(resolve(fixtureRoot, path), 'utf8');
}

test('clean baseline produces traceable package evidence', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  for (const mutation of fixture.cases) {
    const result = buildCoverageBaseline(mutation.input, { readEvidence });
    if (mutation.expectedError) {
      assert.equal(result.ok, false, mutation.name);
      assert.equal(result.error.code, mutation.expectedError, mutation.name);
      assert.notEqual(result.error.observed, undefined, mutation.name);
      continue;
    }
    assert.equal(result.ok, true, mutation.name);
    assert.equal(result.baseline.packages.length, mutation.expected.packageCount, mutation.name);
    assert.ok(result.baseline.packages.every((entry) => entry.packageName && entry.lcovPath), mutation.name);
    assert.ok(result.baseline.packages.every((entry) => Number.isFinite(entry.lines) && Number.isFinite(entry.functions)), mutation.name);
    if (mutation.repeat) {
      assert.deepEqual(result, buildCoverageBaseline(mutation.input, { readEvidence }), mutation.name);
    }
  }
});
