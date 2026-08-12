import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { projectContract, validateContract, validateProjection } from '../editor-ci-contract.mjs';

const contractPath = resolve('scripts/ci/editor-ci-contract.json');
const fixturePath = resolve('scripts/ci/fixtures/editor-ci-contract-projection-cases.json');

function mutatedProjection(projection, operation) {
  const result = structuredClone(projection);
  if (operation === 'remove-owner') delete result.checks[0].owner;
  else if (operation === 'remove-home') delete result.checks[0].executionHome;
  else if (operation === 'remove-first-failure') delete result.resultEnvelope.firstFailure;
  else if (operation === 'duplicate-roster-entry') result.roster.push(structuredClone(result.roster[0]));
  else if (operation === 'change-failure-class') result.resultEnvelope.failureClass = 'environment';
  else if (operation === 'empty-roster') result.roster = [];
  else throw new Error(`unknown mutation ${operation}`);
  return result;
}

test('projection falsifier detects deterministic contract drift without live APIs', () => {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  assert.equal(validateContract(contract).ok, true);
  const projection = projectContract(contract);
  const cases = JSON.parse(readFileSync(fixturePath, 'utf8')).cases;

  for (const mutation of cases) {
    const result = validateProjection(contract, mutatedProjection(projection, mutation.operation));
    assert.equal(result.ok, false, mutation.name);
    assert.equal(result.errors[0].code, mutation.expectedCode, mutation.name);
    assert.equal(typeof result.errors[0].expected, 'string', mutation.name);
    assert.notEqual(result.errors[0].observed, undefined, mutation.name);
    assert.equal(typeof result.errors[0].hint, 'string', mutation.name);
  }
});

test('a valid static projection has a stable roster and first failure shape', () => {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const projection = projectContract(contract);
  const result = validateProjection(contract, projection);
  assert.equal(result.ok, true);
  assert.ok(projection.roster.length > 0);
  assert.equal(typeof projection.resultEnvelope.firstFailure.code, 'string');
});
