import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  canonicalCandidateId,
  discoverBrowserReleaseCandidates,
  validateMeasurementIndex,
  aggregateUnitResults,
  projectPortfolioTopology,
  validateFinalProjection,
  validateBrowserReleaseDiscovery,
  validateEvidenceEnvelope,
} from '../browser-release-portfolio.mjs';
import { validateContract } from '../editor-ci-contract.mjs';
import { createAdmissionEnvelope } from '../editor-ci-contract-envelope.mjs';
import { attestRawEvidence, createMeasurementAttestor, rawArtifactDigest } from '../browser-release-measurement.mjs';

const root = resolve('.');
const contract = JSON.parse(readFileSync(resolve('scripts/ci/editor-ci-contract.json'), 'utf8'));
const portfolio = contract.browserReleasePortfolio;
const fixture = JSON.parse(
  readFileSync(resolve('scripts/ci/fixtures/browser-release-discovery-cases.json'), 'utf8'),
);
const indexFixture = JSON.parse(
  readFileSync(resolve('scripts/ci/fixtures/browser-release-index-cases.json'), 'utf8'),
);
const topologyFixture = JSON.parse(
  readFileSync(resolve('scripts/ci/fixtures/browser-release-topology-cases.json'), 'utf8'),
);
const finalClaimFixture = JSON.parse(
  readFileSync(resolve('scripts/ci/fixtures/browser-release-final-claim-cases.json'), 'utf8'),
);
for (const field of ['contractDigest', 'workflowDigest', 'admissionDigest']) indexFixture.provenance[field] = indexFixture.provenance[field].slice(0, 64);
const admissionFixture = createAdmissionEnvelope({
  generation: indexFixture.provenance.admissionGeneration,
  remoteMainSha: '9'.repeat(40),
  candidateSourceSha: indexFixture.provenance.sourceSha,
  sourceSha: indexFixture.provenance.sourceSha,
  submodulePins: [
    {path: 'forgeax-editor-assets', sha: 'e'.repeat(40)},
    {path: 'packages/engine', sha: 'b'.repeat(40)},
    {path: 'packages/interface', sha: 'c'.repeat(40)},
    {path: 'packages/platform-io', sha: 'd'.repeat(40)},
  ],
  contractDigest: indexFixture.provenance.contractDigest,
  workflowDigest: indexFixture.provenance.workflowDigest,
  sourceBaseline: {status: 'approved', owner: 'human', decisionId: 'test-source-baseline', selectedSha: indexFixture.provenance.sourceSha, requiredEvidence: ['test source evidence']},
  producerOwnership: {status: 'approved', owner: 'human', decisionId: 'test-producer-ownership', contractPath: 'scripts/ci/editor-ci-contract.json', validatorPath: 'scripts/ci/editor-ci-contract.mjs', requiredEvidence: ['test producer evidence']},
  provenance: {historicalBranches: [{ref: 'test-history', sha: 'f'.repeat(40), role: 'provenance-only'}]},
});
assert.equal(admissionFixture.ok, true);
indexFixture.provenance.admissionDigest = admissionFixture.envelope.admissionDigest;

function assertStructuredFailure(result, expectedCode, name) {
  assert.equal(result.ok, false, name);
  assert.equal(result.errors[0].code, expectedCode, name);
  assert.equal(typeof result.errors[0].hint, 'string', name);
  assert.notEqual(result.errors[0].expected, undefined, name);
  assert.notEqual(result.errors[0].observed, undefined, name);
}

function healthyMeasurementIndex() {
  const units = portfolio.discovery.ownedSources.slice().sort().map((source, index) => ({
    unitId: `browser-release-${index + 1}`,
    source: {path: source, entryPoint: `census:${source}`},
    parentCheckId: 'smoke-play',
    terminalStatus: 'pass',
    sampleIds: ['sample-1', 'sample-2'],
    rawDigests: ['e'.repeat(64), 'f'.repeat(64)],
    executionGroup: null,
  }));
  return {
    schemaVersion: 'forgeax-browser-release-measurement-index/v1',
    status: 'pass',
    phase: 'measured',
    sourceSha: indexFixture.provenance.sourceSha,
    contractDigest: indexFixture.provenance.contractDigest,
    workflowDigest: indexFixture.provenance.workflowDigest,
    admissionDigest: indexFixture.provenance.admissionDigest,
    admissionGeneration: indexFixture.provenance.admissionGeneration,
    admitted: {
      editorSha: indexFixture.provenance.sourceSha,
      engineSha: 'b'.repeat(40),
      interfaceSha: 'c'.repeat(40),
      platformIoSha: 'd'.repeat(40),
      assetsSha: 'e'.repeat(40),
    },
    runner: indexFixture.provenance.runner,
    attestor: {fingerprint: '1'.repeat(64), verified: true},
    canonicalOrder: units.map((unit) => unit.unitId),
    units,
    samples: units.flatMap((unit) => unit.sampleIds.map((sampleId) => ({
      unitId: unit.unitId,
      sampleId,
      terminalStatus: 'pass',
      rawDigest: unit.rawDigests[sampleId === 'sample-1' ? 0 : 1],
    }))),
  };
}

test('dynamic census produces a bijective six-unit projection', () => {
  const discovery = discoverBrowserReleaseCandidates(root, portfolio);
  const result = validateBrowserReleaseDiscovery(discovery, portfolio);

  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.value.units.length, 6);
  assert.deepEqual(
    result.value.units.map((unit) => unit.source.path).sort(),
    portfolio.discovery.ownedSources.slice().sort(),
  );
  assert.equal(new Set(result.value.units.map((unit) => unit.unitId)).size, 6);
  assert.ok(result.value.units.every((unit) => /^[a-z0-9-]+$/.test(unit.unitId)));
  assert.ok(result.value.units.every((unit) => unit.parentCheckId === 'smoke-play'));
  assert.ok(result.value.candidates.every((candidate) => {
    return candidate.candidateId === canonicalCandidateId(candidate.path);
  }));
  assert.ok(result.value.candidates.every((candidate) => {
    return ['retained', 'structured-exclusion'].includes(candidate.disposition);
  }));
  for (const channel of Object.values(result.value.channels)) {
    assert.ok(Array.isArray(channel.files));
    assert.ok(Array.isArray(channel.matchedFiles));
  }
});

test('dynamic census keeps each declared discovery root isolated', () => {
  const discovery = discoverBrowserReleaseCandidates(root, portfolio);

  assert.ok(discovery.specs.every((path) => path.startsWith('apps/standalone/e2e/') || path.startsWith('e2e/')));
  assert.ok(discovery.scripts.every((path) => path.startsWith('scripts/')));
  assert.ok(discovery.workflows.every((entry) => entry.path.startsWith('.github/workflows/')));
});

test('discovery mutations fail closed with structured dispositions', () => {
  const discovery = discoverBrowserReleaseCandidates(root, portfolio);

  for (const mutation of fixture.cases) {
    const candidate = structuredClone(discovery);
    if (mutation.operation === 'missing-unit') {
      const source = portfolio.discovery.ownedSources[0];
      candidate.candidates = candidate.candidates.filter((entry) => entry.path !== source);
    } else if (mutation.operation === 'duplicate-candidate') {
      candidate.candidates.push(structuredClone(candidate.candidates[0]));
    } else if (mutation.operation === 'stale-exclusion') {
      candidate.exclusions.push({
        candidateId: canonicalCandidateId('e2e/stale-release-candidate.spec.ts'),
        path: 'e2e/stale-release-candidate.spec.ts',
        owner: 'editor-ci',
        exclusionClass: 'not-release-owned',
        rationale: 'fixture-only stale exclusion',
      });
    } else if (mutation.operation === 'candidate-id-drift') {
      candidate.candidates[0].candidateId = 'candidate-drifted';
    } else if (mutation.operation === 'channel-record-missing') {
      delete candidate.channels.typeScript;
    } else if (mutation.operation === 'source-disposition-drift') {
      candidate.candidates.find((entry) => entry.path === portfolio.discovery.ownedSources[0]).disposition = 'structured-exclusion';
    } else throw new Error(`unknown discovery mutation ${mutation.operation}`);

    assertStructuredFailure(
      validateBrowserReleaseDiscovery(candidate, portfolio),
      mutation.expectedCode,
      mutation.name,
    );
  }
});

test('evidence mutations expose structured recovery fields', () => {
  const expected = {
    sourceSha: 'a'.repeat(40),
    contractDigest: 'b'.repeat(64),
    admissionGeneration: 2,
    terminalStatus: 'pass',
  };
  const cases = [
    {
      name: 'admission drift',
      observed: { ...expected, admissionGeneration: 1 },
      code: 'admission-drift',
    },
    {
      name: 'stale artifact',
      observed: { ...expected, contractDigest: 'c'.repeat(64) },
      code: 'stale-artifact',
    },
  ];

  for (const failure of cases) {
    const result = validateEvidenceEnvelope(failure.observed, expected);
    assertStructuredFailure(result, failure.code, failure.name);
    assert.match(result.errors[0].hint, /admission|artifact|generation/i, failure.name);
  }
});

test('producer ownership and parent failures remain property-addressable', () => {
  const ownerMissing = structuredClone(contract);
  delete ownerMissing.browserReleasePortfolio?.owner;
  const ownerResult = validateContract(ownerMissing);
  assertStructuredFailure(ownerResult, 'portfolio-owner-missing', 'producer ownership unresolved');

  const parentDrift = structuredClone(contract);
  if (parentDrift.browserReleasePortfolio) parentDrift.browserReleasePortfolio.parentCheckId = 'other-parent';
  const parentResult = validateContract(parentDrift);
  assertStructuredFailure(parentResult, 'portfolio-parent-invalid', 'required parent drift');
});

test('measurement index accepts one current terminal bijection only', () => {
  const index = healthyMeasurementIndex();
  const result = validateMeasurementIndex(index, portfolio, {
    expected: indexFixture.provenance,
    attestor: index.attestor,
  });

  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.value.status, 'pass');
  assert.deepEqual(result.value.canonicalOrder, index.canonicalOrder);
  assert.equal(result.value.units.length, 6);
  assert.equal(result.value.samples.length, 12);
});

test('measurement index mutations fail closed before projection', () => {
  for (const mutation of indexFixture.cases) {
    const index = healthyMeasurementIndex();
    if (mutation.operation === 'missing-raw') index.samples = index.samples.slice(1);
    if (mutation.operation === 'duplicate-unit') index.units.push(structuredClone(index.units[0]));
    if (mutation.operation === 'nonterminal') index.units[0].terminalStatus = 'running';
    if (mutation.operation === 'mixed-generation') index.admissionGeneration = 1;
    if (mutation.operation === 'missing-attestor') delete index.attestor;
    if (mutation.operation === 'source-drift') index.sourceSha = 'z'.repeat(40);
    if (mutation.operation === 'order-drift') index.canonicalOrder.reverse();

    assertStructuredFailure(
      validateMeasurementIndex(index, portfolio, {
        expected: indexFixture.provenance,
        attestor: index.attestor,
      }),
      mutation.expectedCode,
      mutation.name,
    );
  }
});

test('aggregate keeps the six-unit lifecycle measured until projection is proven', () => {
  const index = healthyMeasurementIndex();
  const aggregate = aggregateUnitResults(index, portfolio);

  assert.equal(aggregate.ok, true, JSON.stringify(aggregate.errors));
  assert.equal(aggregate.value.status, 'pass');
  assert.equal(aggregate.value.phase, 'measured');
  assert.equal(aggregate.value.units.length, 6);
  assert.equal(aggregate.value.topology.phase, 'pre-topology');

  const projected = projectPortfolioTopology(index, portfolio, {aggregate: aggregate.value});
  assert.equal(projected.ok, true, JSON.stringify(projected.errors));
  assert.equal(projected.value.phase, 'projected');
  assert.equal(projected.value.topology.status, 'final');
  assert.equal(projected.value.topology.units.length, 6);
  assert.equal(projected.value.topology.provisionalHome, null);
});

test('aggregate and topology mutations fail closed without a final claim', () => {
  for (const mutation of topologyFixture.cases) {
    const index = healthyMeasurementIndex();
    let aggregateOptions = {};
    if (mutation.operation === 'unit-failure') index.units[0].terminalStatus = 'failure';
    if (mutation.operation === 'unknown-unit') index.units.push({...index.units[0], unitId: 'unknown-unit', source: {path: 'scripts/unknown-unit.mjs'}});
    if (mutation.operation === 'duplicate-unit') index.units.push(structuredClone(index.units[0]));
    if (mutation.operation === 'missing-unit') index.units = index.units.slice(1);
    if (mutation.operation === 'premature-final-home') aggregateOptions = {phase: 'pre-topology', finalHome: 'nightly/current'};
    if (mutation.operation === 'old-snapshot') aggregateOptions = {snapshot: {sourceSha: 'old-source', phase: 'projected'}};
    if (mutation.operation === 'index-not-pass') index.status = 'failure';

    const aggregate = aggregateUnitResults(index, portfolio);
    if (mutation.operation === 'unit-failure' || mutation.operation === 'unknown-unit' || mutation.operation === 'duplicate-unit' || mutation.operation === 'missing-unit') {
      assertStructuredFailure(aggregate, mutation.expectedCode, mutation.name);
      continue;
    }

    const projected = projectPortfolioTopology(index, portfolio, {aggregate: aggregate.value, ...aggregateOptions});
    assertStructuredFailure(projected, mutation.expectedCode, mutation.name);
    assert.notEqual(projected.value?.topology?.status, 'final', mutation.name);
  }
});

function writeIntegrationRawSet(directory, attestor, terminalStatus = 'pass') {
  const discovery = discoverBrowserReleaseCandidates(root, portfolio);
  const projection = validateBrowserReleaseDiscovery(discovery, portfolio);
  for (const unit of projection.value.units) {
    const raw = {
      schemaVersion: 'forgeax-browser-release-measurement/v1',
      unitId: unit.unitId,
      sourceSha: indexFixture.provenance.sourceSha,
      contractDigest: indexFixture.provenance.contractDigest,
      workflowDigest: indexFixture.provenance.workflowDigest,
      admissionDigest: indexFixture.provenance.admissionDigest,
      admissionGeneration: indexFixture.provenance.admissionGeneration,
      admitted: {
        editorSha: indexFixture.provenance.sourceSha,
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
      sample: {id: 'sample-1', generation: indexFixture.provenance.admissionGeneration},
      terminalStatus,
      runner: {...indexFixture.provenance.runner, authorized: true},
      capability: {xvfb: true, gpuVulkan: true, rhi: true},
      teardown: {complete: true, fixtureRemoved: true, portsReleased: true},
    };
    raw.attestation = attestRawEvidence(raw, attestor);
    raw.rawDigest = rawArtifactDigest(raw);
    writeFileSync(join(directory, `${unit.unitId}.json`), JSON.stringify(raw));
  }
}

test('CLI projection order gates aggregate and transfer on the same index', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-m4-projection-'));
  const rawDirectory = join(directory, 'raw');
  const indexPath = join(directory, 'index.json');
  const aggregatePath = join(directory, 'aggregate.json');
  const admissionPath = join(directory, 'admission.json');
  const attestorPath = join(directory, 'attestor.json');
  const attestor = createMeasurementAttestor();
  writeFileSync(admissionPath, JSON.stringify(admissionFixture.envelope));
  writeFileSync(attestorPath, JSON.stringify({
    privateKey: attestor.privateKey.export({type: 'pkcs8', format: 'pem'}).toString(),
    publicKey: attestor.publicKey,
    fingerprint: attestor.fingerprint,
  }));
  mkdirSync(rawDirectory);
  writeIntegrationRawSet(rawDirectory, attestor);

  const validate = spawnSync('bun', ['scripts/ci/browser-release-measurement.mjs', 'validate-measurements', '--contract', 'scripts/ci/editor-ci-contract.json', '--input', rawDirectory, '--admission', admissionPath, '--attestor-file', attestorPath, '--output', indexPath], {encoding: 'utf8'});
  assert.equal(validate.status, 0, `${validate.stdout}\n${validate.stderr}`);
  assert.equal(JSON.parse(readFileSync(indexPath, 'utf8')).status, 'pass');

  const project = spawnSync('bun', ['scripts/ci/browser-release-measurement.mjs', 'project-topology', '--measurements', indexPath, '--contract', 'scripts/ci/editor-ci-contract.json', '--admission', admissionPath, '--output', aggregatePath], {encoding: 'utf8'});
  assert.equal(project.status, 0, `${project.stdout}\n${project.stderr}`);
  const aggregate = JSON.parse(readFileSync(aggregatePath, 'utf8'));
  assert.equal(aggregate.phase, 'projected');
  assert.equal(aggregate.topology.measurementDigest, JSON.parse(readFileSync(indexPath, 'utf8')).measurementDigest);

  const failedDirectory = join(directory, 'failed-raw');
  mkdirSync(failedDirectory);
  writeIntegrationRawSet(failedDirectory, attestor, 'failure');
  const failedIndexPath = join(directory, 'failed-index.json');
  const failed = spawnSync('bun', ['scripts/ci/browser-release-measurement.mjs', 'validate-measurements', '--contract', 'scripts/ci/editor-ci-contract.json', '--input', failedDirectory, '--admission', admissionPath, '--attestor-file', attestorPath, '--output', failedIndexPath], {encoding: 'utf8'});
  assert.notEqual(failed.status, 0);
  const failedProject = spawnSync('bun', ['scripts/ci/browser-release-measurement.mjs', 'project-topology', '--measurements', failedIndexPath, '--contract', 'scripts/ci/editor-ci-contract.json', '--admission', admissionPath, '--output', join(directory, 'failed-aggregate.json')], {encoding: 'utf8'});
  assert.notEqual(failedProject.status, 0);
  assert.equal(existsSync(join(directory, 'failed-aggregate.json')), false);
});

test('final topology claim rejects stale, provisional, mixed, or incomplete evidence', () => {
  const index = healthyMeasurementIndex();
  const aggregate = aggregateUnitResults(index, portfolio);
  const projected = projectPortfolioTopology(index, portfolio, {aggregate: aggregate.value});
  assert.equal(projected.ok, true, JSON.stringify(projected.errors));

  for (const mutation of finalClaimFixture.cases) {
    const candidate = structuredClone(projected.value);
    const candidateIndex = structuredClone(index);
    if (mutation.operation === 'old-snapshot') candidate.topology.sourceSha = 'old-source';
    if (mutation.operation === 'provisional-home') candidate.topology.provisionalHome = 'feature-pr-measurement';
    if (mutation.operation === 'mixed-digest') candidate.topology.transferDigest = 'f'.repeat(64);
    if (mutation.operation === 'missing-execution-group') delete candidate.topology.units[0].executionGroup;
    if (mutation.operation === 'focused-only' || mutation.operation === 'index-not-pass') candidateIndex.status = 'focused';

    assertStructuredFailure(
      validateFinalProjection(candidate, candidateIndex, portfolio),
      mutation.expectedCode,
      mutation.name,
    );
  }
});
