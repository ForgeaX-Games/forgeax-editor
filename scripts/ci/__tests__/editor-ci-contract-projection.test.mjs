import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { projectContract, validateContract, validateProjection, validateRuntimeProjection } from '../editor-ci-contract.mjs';

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

test('contract projection exposes baseline schema and shared fact reference only', () => {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const projection = projectContract(contract);
  const result = validateProjection(contract, projection);

  assert.equal(result.ok, true);
  assert.deepEqual(projection.baselineEvidence, contract.baselineEvidence);
  assert.equal(projection.baselineEvidence.topIndex.rawPacket, 'raw packet reference');
  assert.equal(projection.baselineEvidence.sharedFactReference.source, 'baseline attempt facts');
  assert.equal(Object.hasOwn(projection.baselineEvidence, 'facts'), false);
  assert.equal(Object.hasOwn(projection.baselineEvidence, 'packets'), false);
});

test('projection exposes one integration index without changing portfolio ownership', () => {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const projection = projectContract(contract);
  const result = validateProjection(contract, projection);

  assert.equal(result.ok, true);
  assert.deepEqual(
    projection.baselineEvidence.topIndex.integrationIndex,
    contract.baselineEvidence.topIndex.integrationIndex,
  );
  assert.equal(
    projection.baselineEvidence.topIndex.integrationIndex.browser.command,
    'bun run ci:browser-release -- project-topology',
  );
  assert.deepEqual(
    projection.baselineEvidence.topIndex.integrationIndex.browser.claimBoundary,
    ['admission', 'parentCheck', 'population', 'claim'],
  );
  assert.equal(projection.baselineEvidence.topIndex.integrationIndex.portability.required, false);
  assert.equal(projection.baselineEvidence.topIndex.integrationIndex.portability.status, 'disabled');
  assert.equal(projection.browserReleasePortfolio.parentCheckId, 'smoke-play');
  assert.equal(projection.browserReleasePortfolio.measurement.required, false);
  const smokeCheck = contract.checks.find((check) => check.checkId === 'smoke-play');
  assert.equal(smokeCheck?.owner, 'editor-ci');
  assert.match(smokeCheck?.command ?? '', /scripts\/ddc-packaging-parity\.mjs --game games\/sample --json/);
  assert.match(smokeCheck?.command ?? '', /apps\/standalone\/e2e\/__tests__\/ddc-lifecycle\.spec\.ts/);
  assert.deepEqual(
    projection.requiredContexts.map((entry) => entry.context),
    ['b2-self-boot', 'typecheck', 'submodule-pin', 'smoke-play'],
  );
});

test('M5 DDC consumer commands remain projected under the smoke-play required owner', () => {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const projection = projectContract(contract);
  const smokeCheck = contract.checks.find((check) => check.checkId === 'smoke-play');

  assert.equal(smokeCheck?.owner, 'editor-ci');
  assert.equal(projection.requiredContexts.find((entry) => entry.context === 'smoke-play')?.checkId, 'smoke-play');
  assert.match(smokeCheck?.command ?? '', /ddc-packaging-parity\.mjs/);
  assert.match(smokeCheck?.command ?? '', /ddc-lifecycle\.spec\.ts/);
});

test('portfolio projection has one smoke-play parent and four required contexts', () => {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const projection = projectContract(contract);
  const portfolio = projection.browserReleasePortfolio;

  assert.ok(portfolio, 'projection must include the nested portfolio');
  assert.equal(portfolio.parentCheckId, 'smoke-play');
  assert.equal(portfolio.requiredContextsRef, 'requiredContexts');
  assert.equal(portfolio.measurement.required, false);
  assert.equal(new Set(contract.requiredContexts.map((entry) => entry.context)).size, 4);
});

test('parent projection mutations are structured and fail closed', () => {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const cases = [
    ['parent-drift', 'portfolio-parent-invalid'],
    ['measurement-required', 'portfolio-measurement-required'],
    ['missing-required-context', 'required-context-missing'],
    ['measurement-promoted-context', 'required-context-invalid'],
  ];

  for (const [operation, expectedCode] of cases) {
    const candidate = structuredClone(contract);
    candidate.browserReleasePortfolio ??= {
      parentCheckId: 'smoke-play',
      requiredContextsRef: 'requiredContexts',
      measurement: { required: false },
    };
    if (operation === 'parent-drift') candidate.browserReleasePortfolio.parentCheckId = 'other-parent';
    if (operation === 'measurement-required') candidate.browserReleasePortfolio.measurement.required = true;
    if (operation === 'missing-required-context') candidate.requiredContexts = candidate.requiredContexts.slice(1);
    if (operation === 'measurement-promoted-context') candidate.requiredContexts.push({ context: 'measurement', checkId: 'smoke-play' });

    const result = validateContract(candidate);
    assert.equal(result.ok, false, operation);
    assert.equal(result.errors[0].code, expectedCode, operation);
    assert.equal(typeof result.errors[0].hint, 'string', operation);
  }
});

test('projection exposes the prerequisite release discovery index separately', () => {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const projection = projectContract(contract);
  const result = validateProjection(contract, projection);

  assert.equal(result.ok, true);
  assert.deepEqual(
    projection.requiredContexts.map((entry) => entry.context).sort(),
    ['b2-self-boot', 'smoke-play', 'submodule-pin', 'typecheck'],
  );
  assert.ok(projection.prerequisiteRelease);
  assert.deepEqual(
    Object.keys(projection.prerequisiteRelease.payloadClasses).sort(),
    ['bun-install-facts', 'editor-generated-inputs', 'engine-dist', 'fbx-wasm', 'wgpu-wasm'],
  );
  assert.deepEqual(projection.prerequisiteRelease.consumers.typecheck, [
    'engine-dist',
    'wgpu-wasm',
    'bun-install-facts',
  ]);
  assert.deepEqual(projection.prerequisiteRelease.identity.fields, [
    'artifactId',
    'releaseDigest',
    'schemaVersion',
    'inventory',
    'producerRunId',
    'producerAttempt',
    'sourceSha',
    'recursivePins',
    'producerSuccess',
  ]);
  assert.deepEqual(projection.prerequisiteRelease.compatibility.fields, [
    'os',
    'architecture',
    'bunVersion',
    'nodeVersion',
    'pnpmVersion',
    'rustVersion',
    'wasmPackVersion',
    'capacityPool',
  ]);
});

test('projection rejects missing or repeated prerequisite declarations', () => {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const projection = projectContract(contract);
  const cases = [
    {
      name: 'missing prerequisite release projection',
      mutate(candidate) {
        delete candidate.prerequisiteRelease;
      },
      expectedCode: 'projection-prerequisite-release-missing',
    },
    {
      name: 'repeated payload declaration',
      mutate(candidate) {
        candidate.prerequisiteRelease.consumers.typecheck.push('engine-dist');
      },
      expectedCode: 'projection-prerequisite-release-duplicate-payload',
    },
  ];

  for (const mutation of cases) {
    const candidate = structuredClone(projection);
    mutation.mutate(candidate);
    const result = validateProjection(contract, candidate);
    assert.equal(result.ok, false, mutation.name);
    assert.equal(result.errors[0].code, mutation.expectedCode, mutation.name);
    assert.notEqual(result.errors[0].expected, undefined, mutation.name);
    assert.notEqual(result.errors[0].observed, undefined, mutation.name);
    assert.equal(typeof result.errors[0].hint, 'string', mutation.name);
  }
});

test('M4 red controls keep binding, live-context, local-report, and budget boundaries', () => {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const ruleset = JSON.parse(readFileSync(resolve('scripts/ci/fixtures/ruleset.json'), 'utf8'));

  const contractResult = validateContract(contract);
  assert.equal(contractResult.ok, true);
  assert.deepEqual(contract.requiredContexts.map((entry) => entry.context), [
    'b2-self-boot', 'typecheck', 'submodule-pin', 'smoke-play',
  ]);
  assert.equal(contract.failurePolicy.sloClaim, null);
  assert.equal(contract.browserReleasePortfolio.parentCheckId, 'smoke-play');
  assert.equal(contract.browserReleasePortfolio.measurement.required, false);

  const runtime = validateRuntimeProjection(contract, '.github/workflows', ruleset, {includePortfolio: false});
  assert.equal(runtime.ok, true, JSON.stringify(runtime.errors));

  const driftedRuleset = structuredClone(ruleset);
  driftedRuleset.rules[0].parameters.required_status_checks = driftedRuleset.rules[0].parameters.required_status_checks.slice(1);
  const drift = validateRuntimeProjection(contract, '.github/workflows', driftedRuleset, {includePortfolio: false});
  assert.equal(drift.ok, false);
  assert.equal(drift.errors[0].code, 'required-context-drift');
  assert.equal(typeof drift.errors[0].hint, 'string');
});
