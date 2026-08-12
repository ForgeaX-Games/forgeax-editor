import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { validateContract } from '../editor-ci-contract.mjs';

const contractPath = resolve('scripts/ci/editor-ci-contract.json');
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

test('portfolio schema mutations return structured failures', () => {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

  for (const mutation of fixture.portfolioCases) {
    const candidate = structuredClone(contract);
    candidate.browserReleasePortfolio ??= { discovery: { ownedSources: [] }, measurement: {} };
    if (mutation.operation === 'missing-owner') delete candidate.browserReleasePortfolio.owner;
    else if (mutation.operation === 'duplicate-source') {
      candidate.browserReleasePortfolio.discovery.ownedSources.push(
        candidate.browserReleasePortfolio.discovery.ownedSources[0],
      );
    } else if (mutation.operation === 'parent-drift') {
      candidate.browserReleasePortfolio.parentCheckId = 'other-parent';
    } else if (mutation.operation === 'measurement-required') {
      candidate.browserReleasePortfolio.measurement.required = true;
    } else if (mutation.operation === 'schema-drift') {
      candidate.browserReleasePortfolio.schemaVersion = 'forgeax-browser-release-portfolio/v2';
    } else throw new Error(`unknown portfolio mutation ${mutation.operation}`);

    const result = validateContract(candidate);
    assert.equal(result.ok, false, mutation.name);
    assert.equal(result.errors[0].code, mutation.expectedCode, mutation.name);
    assert.equal(typeof result.errors[0].hint, 'string', mutation.name);
    assert.notEqual(result.errors[0].observed, undefined, mutation.name);
  }
});

test('valid contract passes schema validation without throwing', () => {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  assert.doesNotThrow(() => {
    const result = validateContract(contract);
    assert.equal(result.ok, true);
  });
});

test('browser release portfolio is a nested producer-owned contract', () => {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const result = validateContract(contract);
  assert.equal(result.ok, true);

  const portfolio = contract.browserReleasePortfolio;
  assert.ok(portfolio, 'the current producer contract must expose the nested portfolio');
  assert.equal(portfolio.owner, 'editor-ci');
  assert.equal(portfolio.schemaVersion, 'forgeax-browser-release-portfolio/v1');
  assert.equal(portfolio.parentCheckId, 'smoke-play');
  assert.equal(portfolio.discovery.ownedSources.length, 6);
  assert.equal(new Set(portfolio.discovery.ownedSources).size, 6);
  assert.ok(portfolio.discovery.ownedSources.every((source) => /^[a-z0-9./-]+$/.test(source)));
  assert.deepEqual(portfolio.evidence.requiredFields, [
    'sourceSha',
    'contractDigest',
    'admissionGeneration',
    'terminalStatus',
    'expected',
    'observed',
  ]);
  assert.equal(portfolio.requiredContextsRef, 'requiredContexts');
  assert.equal(portfolio.measurement.required, false);
});
