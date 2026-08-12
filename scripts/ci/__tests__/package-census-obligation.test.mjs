import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { validatePackageQuality } from '../package-census-ownership.mjs';

const fixturePath = resolve('scripts/ci/fixtures/package-quality-obligations.json');

test('package quality metadata fails closed for missing or invalid obligations', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  for (const mutation of fixture.cases) {
    const result = validatePackageQuality(mutation.packageJson, mutation.testFiles ?? []);
    if (mutation.expectedError) {
      assert.equal(result.ok, false, mutation.name);
      assert.equal(result.error.code, mutation.expectedError, mutation.name);
      assert.equal(typeof result.error.expected, 'string', mutation.name);
      assert.notEqual(result.error.observed, undefined, mutation.name);
      assert.match(result.error.hint, /(?:declare|add|set|keep)/i, mutation.name);
    } else {
      assert.equal(result.ok, true, mutation.name);
    }
  }
});
