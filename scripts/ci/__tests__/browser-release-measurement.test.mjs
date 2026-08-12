import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {test} from 'node:test';
import {
  admissionExpected,
  createMeasurementAttestor,
  validateJourneyTerminal,
  probeHeavyCarrier,
  selectComparableSamplePlan,
  validateComparableProvenance,
  validateRawEvidence,
  attestRawEvidence,
  validateRawAttestation,
  rawArtifactDigest,
} from '../browser-release-measurement.mjs';
import {discoverBrowserReleaseCandidates, validateBrowserReleaseDiscovery} from '../browser-release-portfolio.mjs';
import {createAdmissionEnvelope} from '../editor-ci-contract-envelope.mjs';

const fixture = JSON.parse(readFileSync(resolve('scripts/ci/fixtures/browser-release-measurement-cases.json'), 'utf8'));

const expected = {
  sourceSha: 'a'.repeat(40),
  contractDigest: 'b'.repeat(64),
  workflowDigest: 'd'.repeat(64),
  admissionDigest: 'c'.repeat(64),
  admissionGeneration: 2,
  admitted: {
    editorSha: 'a'.repeat(40),
    engineSha: 'b'.repeat(40),
    interfaceSha: 'c'.repeat(40),
    platformIoSha: 'd'.repeat(40),
    assetsSha: 'e'.repeat(40),
  },
  admittedPins: {
    'forgeax-editor-assets': 'e'.repeat(40),
    'packages/engine': 'b'.repeat(40),
    'packages/interface': 'c'.repeat(40),
    'packages/platform-io': 'd'.repeat(40),
  },
  unitId: 'browser-release-unit-a',
  sampleId: 'sample-1',
};

test('measurement CLI refuses missing admission instead of manufacturing unknown provenance', () => {
  const result = spawnSync('bun', ['scripts/ci/browser-release-measurement.mjs', 'plan', '--admission', '/tmp/forgeax-admission-does-not-exist.json'], {encoding: 'utf8'});
  assert.notEqual(result.status, 0);
  const error = JSON.parse(result.stderr.trim());
  assert.equal(error.code, 'measurement-admission-missing');
  assert.equal(error.observed, 'missing');
  assert.match(error.hint, /immutable|admission/i);
});

function healthyRaw() {
  return {
    schemaVersion: 'forgeax-browser-release-measurement/v1',
    unitId: expected.unitId,
    sample: {id: expected.sampleId, generation: expected.admissionGeneration},
    sourceSha: expected.sourceSha,
    contractDigest: expected.contractDigest,
    workflowDigest: expected.workflowDigest,
    admissionDigest: expected.admissionDigest,
    admissionGeneration: expected.admissionGeneration,
    admitted: structuredClone(expected.admitted),
    admittedPins: structuredClone(expected.admittedPins),
    runner: {os: 'linux', arch: 'x64', class: 'self-hosted-linux-x64-heavy', authorized: true},
    browser: {name: 'chromium', headless: false},
    capability: {xvfb: true, gpuVulkan: true, rhi: true},
    fixture: {id: 'fixture-a', digest: 'd'.repeat(64)},
    argv: ['bun', 'run', 'test:e2e', 'e2e/unit-a.spec.ts'],
    terminalStatus: 'pass',
    expected: 'the canonical unit completes in an admitted heavy carrier',
    observed: 'pass',
    teardown: {complete: true, fixtureRemoved: true, portsReleased: true},
  };
}

test('raw evidence rejects missing terminal/raw/provenance facts with structured recovery fields', () => {
  for (const mutation of fixture.cases) {
    const raw = healthyRaw();
    if (mutation.operation === 'missing-raw') {
      assert.equal(validateRawEvidence(null, expected).errors[0].code, mutation.expectedCode);
      continue;
    }
    if (mutation.operation === 'non-terminal') raw.terminalStatus = 'running';
    if (mutation.operation === 'source-drift') raw.sourceSha = 'e'.repeat(40);
    if (mutation.operation === 'contract-drift') raw.contractDigest = 'f'.repeat(64);
    if (mutation.operation === 'workflow-drift') raw.workflowDigest = 'f'.repeat(64);
    if (mutation.operation === 'admitted-drift') raw.admittedPins['packages/engine'] = 'f'.repeat(40);
    if (mutation.operation === 'generation-drift') raw.admissionGeneration = 1;
    if (mutation.operation === 'cleanup-failure') {
      raw.terminalStatus = 'failure';
      raw.firstFailure = {code: 'measurement-cleanup-failed', expected: 'complete teardown', observed: 'ports still owned', hint: 'Inspect teardown and rerun the same unit.'};
      raw.teardown = {complete: false, fixtureRemoved: false, portsReleased: false};
    }
    const result = validateRawEvidence(raw, expected);
    assert.equal(result.ok, false, mutation.name);
    assert.equal(result.errors[0].code, mutation.expectedCode, mutation.name);
    assert.equal(typeof result.errors[0].hint, 'string', mutation.name);
    assert.notEqual(result.errors[0].expected, undefined, mutation.name);
    assert.notEqual(result.errors[0].observed, undefined, mutation.name);
  }
});

test('raw pass requires an observed heavy carrier and complete teardown', () => {
  const raw = healthyRaw();
  assert.equal(validateRawEvidence(raw, expected).ok, true);
  for (const field of ['xvfb', 'gpuVulkan', 'rhi']) {
    const mutated = healthyRaw();
    mutated.capability[field] = false;
    const result = validateRawEvidence(mutated, expected);
    assert.equal(result.ok, false, field);
    assert.equal(result.errors[0].code, 'heavy-capability-unavailable', field);
  }
  const incomplete = healthyRaw();
  incomplete.teardown.portsReleased = false;
  incomplete.terminalStatus = 'failure';
  incomplete.firstFailure = {code: 'measurement-cleanup-failed', expected: 'complete teardown', observed: 'port lease retained', hint: 'Inspect the teardown record.'};
  assert.equal(validateRawEvidence(incomplete, expected).errors[0].code, 'measurement-cleanup-failed');
});

test('attestor binds raw evidence to the exact signed invocation', () => {
  const attestor = createMeasurementAttestor();
  const raw = healthyRaw();
  raw.attestation = attestRawEvidence(raw, attestor);
  assert.equal(validateRawAttestation(raw, {publicKey: attestor.publicKey, fingerprint: attestor.fingerprint}).ok, true);
  const rewritten = structuredClone(raw);
  rewritten.argv.push('--rewritten');
  assert.equal(validateRawAttestation(rewritten, {publicKey: attestor.publicKey, fingerprint: attestor.fingerprint}).errors[0].code, 'measurement-attestation-invalid');
});

function createTestAdmission(directory) {
  const input = JSON.parse(readFileSync(resolve('scripts/ci/fixtures/editor-ci-contract-envelope-cases.json'), 'utf8')).approvedInput;
  input.submodulePins.push(
    {path: 'forgeax-editor-assets', sha: 'e'.repeat(40)},
    {path: 'packages/platform-io', sha: 'd'.repeat(40)},
  );
  const created = createAdmissionEnvelope(input);
  assert.equal(created.ok, true, JSON.stringify(created));
  const path = resolve(directory, 'admission.json');
  writeFileSync(path, `${JSON.stringify(created.envelope)}\n`);
  return {path, expected: admissionExpected(path, {}) .value};
}

function createTestAttestor(directory) {
  const attestor = createMeasurementAttestor();
  const path = resolve(directory, 'attestor.json');
  writeFileSync(path, `${JSON.stringify({
    privateKey: attestor.privateKey.export({type: 'pkcs8', format: 'pem'}).toString(),
    publicKey: attestor.publicKey,
    fingerprint: attestor.fingerprint,
  })}\n`);
  return {path, attestor};
}

function signedRawForUnit(unit, expectedValue, attestor) {
  const raw = {
    schemaVersion: 'forgeax-browser-release-measurement/v1',
    unitId: unit.unitId,
    sample: {id: 'sample-1', generation: expectedValue.admissionGeneration},
    sourceSha: expectedValue.sourceSha,
    contractDigest: expectedValue.contractDigest,
    workflowDigest: expectedValue.workflowDigest,
    admissionDigest: expectedValue.admissionDigest,
    admissionGeneration: expectedValue.admissionGeneration,
    admitted: structuredClone(expectedValue.admitted),
    admittedPins: structuredClone(expectedValue.admittedPins),
    runner: {os: 'linux', arch: 'x64', class: 'self-hosted-linux-x64-heavy', authorized: true},
    browser: {name: 'chromium', headless: false},
    capability: {xvfb: true, gpuVulkan: true, rhi: true},
    fixture: {id: unit.source.path, digest: 'd'.repeat(64)},
    argv: ['bun', 'run', unit.source.path],
    terminalStatus: 'pass',
    expected: 'the canonical unit completes in an admitted heavy carrier',
    observed: 'pass',
    teardown: {complete: true, fixtureRemoved: true, portsReleased: true},
  };
  raw.attestation = attestRawEvidence(raw, attestor);
  raw.rawDigest = rawArtifactDigest(raw);
  return raw;
}

function writeSignedRawSet(directory, expectedValue, attestor, mutate) {
  const contract = JSON.parse(readFileSync(resolve('scripts/ci/editor-ci-contract.json'), 'utf8'));
  const discovery = validateBrowserReleaseDiscovery(
    discoverBrowserReleaseCandidates(resolve('.'), contract.browserReleasePortfolio),
    contract.browserReleasePortfolio,
  );
  assert.equal(discovery.ok, true, JSON.stringify(discovery.errors));
  for (const unit of discovery.value.units) {
    const raw = signedRawForUnit(unit, expectedValue, attestor);
    mutate?.(raw, unit);
    writeFileSync(resolve(directory, `${unit.unitId}.json`), `${JSON.stringify(raw)}\n`);
  }
}

function runIndexValidation({mutateRaw, mutateAttestor} = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), 'forgeax-raw-attestor-'));
  const rawDirectory = resolve(directory, 'raw');
  mkdirSync(rawDirectory);
  const admission = createTestAdmission(directory);
  const attestor = createTestAttestor(directory);
  if (mutateAttestor) mutateAttestor(attestor);
  writeSignedRawSet(rawDirectory, admission.expected, attestor.attestor, mutateRaw);
  const output = resolve(directory, 'index.json');
  const command = spawnSync('bun', [
    'scripts/ci/browser-release-measurement.mjs', 'validate-measurements',
    '--contract', 'scripts/ci/editor-ci-contract.json', '--input', rawDirectory,
    '--admission', admission.path, '--attestor-file', attestor.path, '--output', output,
  ], {encoding: 'utf8'});
  return {command, index: JSON.parse(readFileSync(output, 'utf8'))};
}

test('validate-measurements only builds a pass index from current signed raw artifacts', {timeout: 30000}, () => {
  const healthy = runIndexValidation();
  assert.equal(healthy.command.status, 0, `${healthy.command.stdout}\n${healthy.command.stderr}`);
  assert.equal(healthy.index.status, 'pass');
  assert.equal(healthy.index.attestor.verified, true);
  assert.equal(healthy.index.samples.every((sample) => sample.validation.ok), true);
  assert.equal(healthy.index.samples.every((sample) => sample.validation.digest.recomputed === sample.rawDigest), true);

  const cases = [
    {
      name: 'workflow provenance drift',
      mutateRaw: (raw) => { raw.workflowDigest = 'f'.repeat(64); },
      code: 'measurement-provenance-drift',
    },
    {
      name: 'admitted pin drift',
      mutateRaw: (raw) => { raw.admittedPins['packages/engine'] = 'f'.repeat(40); },
      code: 'measurement-admission-drift',
    },
    {
      name: 'missing attestation',
      mutateRaw: (raw) => { delete raw.attestation; raw.rawDigest = rawArtifactDigest(raw); },
      code: 'measurement-attestation-invalid',
    },
    {
      name: 'invalid attestation',
      mutateRaw: (raw) => { raw.attestation.signature = `${raw.attestation.signature.slice(0, -2)}aa`; },
      code: 'measurement-attestation-invalid',
    },
    {
      name: 'forged raw digest',
      mutateRaw: (raw) => { raw.rawDigest = '0'.repeat(64); },
      code: 'measurement-raw-digest-mismatch',
    },
  ];
  for (const candidate of cases) {
    const result = runIndexValidation({mutateRaw: candidate.mutateRaw});
    assert.notEqual(result.command.status, 0, candidate.name);
    assert.equal(result.index.status, 'failure', candidate.name);
    assert.equal(result.index.samples.some((sample) => sample.validation.errors.some((error) => error.code === candidate.code)), true, candidate.name);
  }
});

test('raw digest canonicalization excludes only the self-referential digest field', () => {
  const raw = healthyRaw();
  raw.attestation = {schemaVersion: 'test-attestation', signature: 'signed'};
  const digest = rawArtifactDigest(raw);
  raw.rawDigest = digest;
  assert.equal(rawArtifactDigest(raw), digest);
  raw.rawDigest = 'f'.repeat(64);
  assert.equal(rawArtifactDigest(raw), digest);
  const reordered = Object.fromEntries(Object.entries(raw).reverse());
  assert.equal(rawArtifactDigest(reordered), digest);
});

test('heavy carrier capability is observed field by field and fails closed', () => {
  const runnerCases = JSON.parse(readFileSync(resolve('scripts/ci/fixtures/browser-release-runner-cases.json'), 'utf8'));
  const healthy = {
    os: 'linux',
    arch: 'x64',
    pool: 'heavy',
    authorized: true,
    xvfb: true,
    gpuVulkan: true,
    rhi: true,
    chromium: true,
  };
  const ready = probeHeavyCarrier({observed: healthy});
  assert.equal(ready.ok, true);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.capability.os, 'linux');
  assert.equal(ready.capability.arch, 'x64');
  assert.equal(ready.capability.pool, 'heavy');
  for (const mutation of runnerCases.cases) {
    const observed = {...healthy, ...mutation.capability};
    const result = probeHeavyCarrier({observed});
    assert.equal(result.ok, false, mutation.name);
    assert.equal(result.status, 'blocked', mutation.name);
    assert.equal(result.error.code, mutation.expectedCode, mutation.name);
    assert.equal(typeof result.error.hint, 'string', mutation.name);
    assert.notEqual(result.error.expected, undefined, mutation.name);
    assert.notEqual(result.error.observed, undefined, mutation.name);
    assert.equal(result.terminal, null, mutation.name);
  }
});

test('runner labels cannot substitute for observed heavy capabilities', () => {
  const result = probeHeavyCarrier({observed: {
    os: 'linux', arch: 'x64', pool: 'heavy', authorized: true,
    labels: ['self-hosted', 'Linux', 'X64', 'heavy'],
    xvfb: false, gpuVulkan: false, rhi: false, chromium: false,
  }});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'heavy-carrier-unavailable');
  assert.match(result.error.hint, /observ/i);
});

test('journey terminal validation covers every dynamic unit and the real product expectations', () => {
  const cases = JSON.parse(readFileSync(resolve('scripts/ci/fixtures/browser-release-journey-cases.json'), 'utf8'));
  const contract = JSON.parse(readFileSync(resolve('scripts/ci/editor-ci-contract.json'), 'utf8'));
  const discovery = validateBrowserReleaseDiscovery(
    discoverBrowserReleaseCandidates(resolve('.'), contract.browserReleasePortfolio),
    contract.browserReleasePortfolio,
  );
  assert.equal(discovery.ok, true, JSON.stringify(discovery.errors));
  const plan = discovery.value.units;
  const results = plan.map((unit) => ({
    unitId: unit.unitId,
    parentCheckId: unit.parentCheckId,
    terminalStatus: 'pass',
    fixture: {path: unit.source.path, digest: 'a'.repeat(64)},
    argv: ['bun', 'run', unit.source.path],
    journey: {...cases.expectations},
    evidence: {rawPath: `raw/${unit.unitId}.json`, terminal: true},
  }));
  const valid = validateJourneyTerminal(plan, results);
  assert.equal(valid.ok, true, JSON.stringify(valid.errors));
  assert.deepEqual(valid.value.unitIds, plan.map((unit) => unit.unitId));
  for (const mutation of cases.cases) {
    const candidate = structuredClone(results);
    if (mutation.operation === 'missing-unit') candidate.pop();
    if (mutation.operation === 'failed-unit') candidate[0].terminalStatus = 'failure';
    if (mutation.operation === 'missing-evidence') delete candidate[0].evidence;
    if (mutation.operation === 'expectation-drift') candidate[0].journey.playStop = false;
    const result = validateJourneyTerminal(plan, candidate);
    assert.equal(result.ok, false, mutation.name);
    assert.equal(result.errors[0].code, mutation.expectedCode, mutation.name);
    assert.equal(typeof result.errors[0].hint, 'string', mutation.name);
  }
});

test('comparable samples require same unit, generation, runner, and admission provenance', () => {
  const cases = JSON.parse(readFileSync(resolve('scripts/ci/fixtures/browser-release-comparable-cases.json'), 'utf8'));
  const first = healthyRaw();
  first.sample = {id: 'sample-1', generation: expected.admissionGeneration, artifactName: 'sample-1.json'};
  first.timing = {totalMs: 100};
  const plan = selectComparableSamplePlan([first], expected);
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.equal(plan.value.length, 1);
  const second = structuredClone(first);
  second.sample = {
    id: 'sample-2',
    generation: expected.admissionGeneration,
    artifactName: 'sample-2.json',
    comparableToDigest: plan.value[0].sample1Digest,
    sample1Digest: plan.value[0].sample1Digest,
  };
  const valid = validateComparableProvenance(first, second, expected);
  assert.equal(valid.ok, true, JSON.stringify(valid.errors));
  for (const mutation of cases.cases) {
    const candidate = structuredClone(second);
    if (mutation.operation === 'generation-drift') candidate.sample.generation = 1;
    if (mutation.operation === 'runner-drift') candidate.runner.class = 'self-hosted-linux-x64-standard';
    if (mutation.operation === 'source-drift') candidate.sourceSha = 'e'.repeat(40);
    if (mutation.operation === 'unit-drift') candidate.unitId = 'browser-release-unit-b';
    if (mutation.operation === 'non-terminal') candidate.terminalStatus = 'running';
    if (mutation.operation === 'digest-drift') candidate.sample.comparableToDigest = 'f'.repeat(64);
    const result = validateComparableProvenance(first, candidate, expected);
    assert.equal(result.ok, false, mutation.name);
    assert.equal(result.errors[0].code, mutation.expectedCode, mutation.name);
    assert.equal(typeof result.errors[0].hint, 'string', mutation.name);
  }
});
