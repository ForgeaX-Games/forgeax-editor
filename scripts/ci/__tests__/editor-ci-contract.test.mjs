import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { validateContract } from '../editor-ci-contract.mjs';

const contract = JSON.parse(readFileSync(resolve('scripts/ci/editor-ci-contract.json'), 'utf8'));

test('contract failures expose code, hint, expected, and observed properties', () => {
  const candidate = structuredClone(contract);
  delete candidate.browserReleasePortfolio?.owner;
  const result = validateContract(candidate);

  assert.equal(result.ok, false);
  const error = result.errors[0];
  assert.equal(error.code, 'portfolio-owner-missing');
  assert.equal(typeof error.hint, 'string');
  assert.notEqual(error.expected, undefined);
  assert.notEqual(error.observed, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(error, 'message'), false);
});

test('unresolved ownership remains a blocked handoff instead of a partial pass', () => {
  const candidate = structuredClone(contract);
  delete candidate.browserReleasePortfolio?.owner;
  const result = validateContract(candidate);
  assert.equal(result.ok, false);
  assert.notEqual(result.errors[0].code, 'partial-pass');
  assert.match(result.errors[0].hint, /owner|producer/i);
});
