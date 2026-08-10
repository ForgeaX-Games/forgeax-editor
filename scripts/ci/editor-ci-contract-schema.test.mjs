import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { validateContract } from './editor-ci-contract.mjs';

const contractPath = resolve('ci/editor-ci-contract.json');
const fixturePath = resolve('scripts/ci/fixtures/editor-ci-contract-invalid-schema.json');

function clone(value) {
  return structuredClone(value);
}

function mutate(value, path, operation, replacement) {
  const result = clone(value);
  const parent = path.slice(0, -1).reduce((current, key) => current[key], result);
  const key = path.at(-1);
  if (operation === 'delete') delete parent[key];
  else parent[key] = replacement;
  return result;
}

test('schema mutations return stable structured failures', () => {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

  for (const mutation of fixture.cases) {
    const result = validateContract(
      mutate(contract, mutation.path, mutation.operation, mutation.value),
    );
    assert.equal(result.ok, false, mutation.name);
    assert.equal(result.errors[0].code, mutation.expectedCode, mutation.name);
    assert.equal(typeof result.errors[0].expected, 'string', mutation.name);
    assert.notEqual(result.errors[0].observed, undefined, mutation.name);
    assert.equal(typeof result.errors[0].hint, 'string', mutation.name);
  }
});

test('valid contract passes schema validation without throwing', () => {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  assert.doesNotThrow(() => {
    const result = validateContract(contract);
    assert.equal(result.ok, true);
  });
});
