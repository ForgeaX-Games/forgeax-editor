import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { validateContract } from './editor-ci-contract.mjs';

const contractPath = resolve('ci/editor-ci-contract.json');
const fixturePath = resolve('scripts/ci/fixtures/editor-ci-contract-invalid-identity.json');

function mutatedContract(contract, operation) {
  const result = structuredClone(contract);
  if (operation === 'duplicate-check-id') {
    result.checks[1].checkId = result.checks[0].checkId;
  } else if (operation === 'add-unknown-home') {
    result.checks[0].executionHome.experimental = true;
  } else if (operation === 'fast-not-subset') {
    result.profiles['local-full'] = result.profiles['local-full'].filter(
      (checkId) => checkId !== 'typecheck',
    );
    result.checks.find((check) => check.checkId === 'typecheck').executionHome['local-full'] = false;
  } else if (operation === 'profile-home-drift') {
    result.profiles.PR.push('r0-sample-vfx-skill');
  } else if (operation === 'remove-context-mapping') {
    result.requiredContexts = result.requiredContexts.filter(
      (entry) => entry.context !== 'b2-self-boot',
    );
  } else if (operation === 'duplicate-context-mapping') {
    result.requiredContexts.push({ context: 'typecheck', checkId: 'smoke-play' });
  } else if (operation === 'required-context-home-drift') {
    result.requiredContexts[0].checkId = 'r0-sample-vfx-skill';
  } else {
    throw new Error(`unknown mutation ${operation}`);
  }
  return result;
}

test('identity and execution-home mutations fail with stable codes', () => {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

  for (const mutation of fixture.cases) {
    const result = validateContract(mutatedContract(contract, mutation.operation));
    assert.equal(result.ok, false, mutation.name);
    assert.equal(result.errors[0].code, mutation.expectedCode, mutation.name);
    assert.equal(typeof result.errors[0].expected, 'string', mutation.name);
    assert.notEqual(result.errors[0].observed, undefined, mutation.name);
    assert.equal(typeof result.errors[0].hint, 'string', mutation.name);
  }
});

test('valid identity matrix is lower-kebab-case and has six homes', () => {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const result = validateContract(contract);
  assert.equal(result.ok, true);
  assert.ok(contract.checks.every((check) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(check.checkId)));
  assert.deepEqual(Object.keys(contract.checks[0].executionHome).sort(), [
    'PR',
    'local-fast',
    'local-full',
    'main',
    'nightly/scheduled',
    'post-merge',
  ].sort());
  assert.deepEqual(
    contract.requiredContexts.map((entry) => entry.checkId).sort(),
    contract.profiles.PR.slice().sort(),
  );
});
