import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  FALSIFIER_CODES,
  REQUIRED_ROWS,
  validateEnginePriorArtTransfer,
  validateTransferReleaseBoundary,
} from '../engine-prior-art-transfer.mjs';

const fixture = JSON.parse(readFileSync(resolve('scripts/ci/fixtures/engine-prior-art-transfer-cases.json'), 'utf8'));
const admitted = {
  editorSha: 'a'.repeat(40),
  engineSha: 'b'.repeat(40),
  interfaceSha: 'c'.repeat(40),
  platformIoSha: 'd'.repeat(40),
  assetsSha: 'e'.repeat(40),
};

function hashJson(value) {
  return createHash('sha256').update(`${JSON.stringify(value)}\n`).digest('hex');
}

function healthyMeasurements() {
  return {
    schemaVersion: 'forgeax-browser-release-measurement-index/v1',
    status: 'pass',
    sourceSha: admitted.editorSha,
    contractDigest: 'c'.repeat(64),
    workflowDigest: 'd'.repeat(64),
    admissionDigest: 'e'.repeat(64),
    admissionGeneration: 2,
    admitted,
    units: REQUIRED_ROWS.slice(0, 6).map((row, index) => ({
      unitId: `browser-release-${index + 1}`,
      terminalStatus: 'pass',
      parentCheckId: 'smoke-play',
    })),
  };
}

function healthyTransfer(measurements = healthyMeasurements()) {
  return {
    schemaVersion: 'forgeax-engine-prior-art-transfer/v1',
    measurementDigest: hashJson(measurements),
    admissionGeneration: measurements.admissionGeneration,
    admitted: structuredClone(admitted),
    rows: REQUIRED_ROWS.map((required) => ({
      ...required,
      mappingAction: 'no-change',
      reachability: {
        reportPath: required.report,
        reportCommit: required.reportCommit,
        sourcePath: required.source,
        sourceCommit: required.sourceCommit,
        immutable: true,
        method: 'git-cat-file-and-ls-tree-at-recorded-commit',
        reportReachable: true,
        sourceReachable: true,
        reportObject: '1'.repeat(40),
        sourceObject: '2'.repeat(40),
        reportRepo: 'harness',
        sourceRepo: 'editor',
        reportObjectPath: required.report,
        sourceObjectPath: required.source,
      },
      falsifierResult: {
        status: 'pass',
        executed: true,
        technique: required.technique,
        mutation: required.focusedEditorFalsifier,
        mutationDigest: '3'.repeat(64),
        code: FALSIFIER_CODES[required.technique],
        observedCode: FALSIFIER_CODES[required.technique],
        observed: 'failed closed',
        event: {
          technique: required.technique,
          mutation: required.focusedEditorFalsifier,
          observedCode: FALSIFIER_CODES[required.technique],
          status: 'failed-closed',
        },
      },
    })),
  };
}

function assertStructuredFailure(result, expectedCode, name) {
  assert.equal(result.ok, false, name);
  assert.equal(result.errors[0].code, expectedCode, name);
  assert.equal(typeof result.errors[0].hint, 'string', name);
  assert.notEqual(result.errors[0].expected, undefined, name);
  assert.notEqual(result.errors[0].observed, undefined, name);
}

test('live prior-art transfer requires six distinct falsifier rows and current measurement', () => {
  const measurements = healthyMeasurements();
  const transfer = healthyTransfer(measurements);
  const result = validateEnginePriorArtTransfer(transfer, {
    measurements,
    admitted,
    resolveRecordedReachability: (reachability) => ({
      reportObject: reachability.reportObject,
      sourceObject: reachability.sourceObject,
      reportReachable: true,
      sourceReachable: true,
    }),
  });

  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(transfer.rows.length, 6);
  assert.equal(new Set(transfer.rows.map((row) => row.falsifierResult.code)).size, 6);
});

test('each transfer falsifier rejects stale or focused-only evidence independently', () => {
  for (const mutation of fixture.cases) {
    const measurements = healthyMeasurements();
    const transfer = healthyTransfer(measurements);
    const options = {
      measurements,
      admitted,
      resolveRecordedReachability: (reachability) => ({
        reportObject: reachability.reportObject,
        sourceObject: reachability.sourceObject,
        reportReachable: true,
        sourceReachable: true,
      }),
    };
    if (mutation.operation === 'reachability') {
      transfer.rows[0].reachability.reportReachable = false;
      options.resolveRecordedReachability = () => ({reportReachable: false, sourceReachable: true});
    }
    if (mutation.operation === 'mutation-digest') transfer.rows[0].falsifierResult.mutationDigest = 'z'.repeat(64);
    if (mutation.operation === 'admission') transfer.admitted.editorSha = 'f'.repeat(40);
    if (mutation.operation === 'measurement-digest') transfer.measurementDigest = 'f'.repeat(64);
    if (mutation.operation === 'focused-only') measurements.status = 'focused';
    if (mutation.operation === 'current-admission') options.admitted = {...admitted, editorSha: 'f'.repeat(40)};

    assertStructuredFailure(
      validateEnginePriorArtTransfer(transfer, options),
      mutation.expectedCode,
      mutation.name,
    );
  }
});

test('transfer CLI consumes the projected measurement artifact, not a focused suite', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-m4-transfer-'));
  const measurementPath = join(directory, 'index.json');
  const topologyPath = join(directory, 'topology.json');
  const outputPath = join(directory, 'transfer.json');
  const measurements = healthyMeasurements();
  writeFileSync(measurementPath, JSON.stringify(measurements));
  writeFileSync(topologyPath, JSON.stringify({}));
  const result = spawnSync('bun', ['scripts/ci/engine-prior-art-transfer.mjs', '--contract', 'scripts/ci/editor-ci-contract.json', '--measurements', measurementPath, '--output', outputPath], {encoding: 'utf8'});
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /--topology TOPOLOGY --admission ADMISSION/);

  const missingAdmission = spawnSync('bun', ['scripts/ci/engine-prior-art-transfer.mjs', '--contract', 'scripts/ci/editor-ci-contract.json', '--measurements', measurementPath, '--topology', topologyPath, '--admission', join(directory, 'missing-admission.json'), '--output', outputPath], {encoding: 'utf8'});
  assert.notEqual(missingAdmission.status, 0);
  assert.equal(JSON.parse(missingAdmission.stderr.trim()).code, 'measurement-admission-missing');

  const focusedPath = join(directory, 'focused.json');
  writeFileSync(focusedPath, JSON.stringify({...measurements, status: 'focused'}));
  const focused = spawnSync('bun', ['scripts/ci/engine-prior-art-transfer.mjs', '--contract', 'scripts/ci/editor-ci-contract.json', '--measurements', focusedPath, '--output', join(directory, 'focused-transfer.json')], {encoding: 'utf8'});
  assert.notEqual(focused.status, 0);
  assert.match(`${focused.stdout}\n${focused.stderr}`, /pass|focused|measurement|index/i);
  assert.equal(readFileSync(measurementPath, 'utf8'), JSON.stringify(measurements));
});

test('transfer claim remains blocked when final projection evidence is falsified', () => {
  const measurements = healthyMeasurements();
  const topology = {
    phase: 'projected',
    status: 'final',
    measurementDigest: hashJson(measurements),
    sourceSha: measurements.sourceSha,
    contractDigest: measurements.contractDigest,
    workflowDigest: measurements.workflowDigest,
    admissionDigest: measurements.admissionDigest,
    admissionGeneration: measurements.admissionGeneration,
    transferDigest: '4'.repeat(64),
    units: REQUIRED_ROWS.map((row, index) => ({
      unitId: `browser-release-${index + 1}`,
      executionGroup: `group-${index + 1}`,
    })),
  };
  const transfer = healthyTransfer(measurements);
  transfer.topologyDigest = hashJson(topology);
  const healthy = validateTransferReleaseBoundary(transfer, measurements, topology);
  assert.equal(healthy.ok, true, JSON.stringify(healthy.errors));

  const mutations = [
    ['mixed digest', (candidate) => { candidate.measurementDigest = 'f'.repeat(64); }, 'final-claim-digest-drift'],
    ['focused only', (_candidate, candidateMeasurements) => { candidateMeasurements.status = 'focused'; }, 'final-claim-index-not-pass'],
    ['missing execution group', (_candidate, _candidateMeasurements, candidateTopology) => { delete candidateTopology.units[0].executionGroup; }, 'final-claim-execution-group-missing'],
  ];
  for (const [name, mutate, expectedCode] of mutations) {
    const candidate = structuredClone(transfer);
    const candidateMeasurements = structuredClone(measurements);
    const candidateTopology = structuredClone(topology);
    mutate(candidate, candidateMeasurements, candidateTopology);
    candidate.topologyDigest = hashJson(candidateTopology);
    assertStructuredFailure(
      validateTransferReleaseBoundary(candidate, candidateMeasurements, candidateTopology),
      expectedCode,
      name,
    );
  }
});
