#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {validateBrowserReleasePortfolio, validateMeasurementIndex} from './browser-release-portfolio.mjs';
import {admissionExpected} from './browser-release-measurement.mjs';

export const TRANSFER_SCHEMA_VERSION = 'forgeax-engine-prior-art-transfer/v1';

const ROOT = resolve(import.meta.dirname, '../..');
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const REQUIRED_ROWS = Object.freeze([
  {
    technique: 'Test-tail distribution before sharding or timeout changes',
    decision: 'adapt',
    report: 'forgeax-engine-harness/solo/fast-robust-ci/experiments/20260721-212706-audit-vitest-browser-hmr-tail/REPORT.md',
    reportCommit: '5dedaabe68f14cccfd12d94d3f388f2aae548acd',
    source: 'forgeax-engine/scripts/ci/check-test-perf-budget.mjs',
    sourceCommit: 'deb77334fbd7ff578c79d526d9dd704c7b054170',
    editorInvariant: 'Every retained editor unit keeps one unique falsification and obtains kind-correct per-unit timing and isolation evidence before topology or timeout decisions.',
    semanticDelta: 'Adapt test and script timing to canonical editor units without copying the engine threshold, reporter, or roster.',
    focusedEditorFalsifier: 'A fixture with one retained unit missing raw timing or isolation must make transfer and topology validation red.',
  },
  {
    technique: 'Evidence-backed no-change',
    decision: 'reuse',
    report: 'forgeax-engine-harness/solo/fast-robust-ci/experiments/20260723-172526-audit-test-tail-distribution-13/REPORT.md',
    reportCommit: 'e2eb2528a2226c11cf69dcd7790aaf34f567db89',
    source: 'ENGINE-PRIOR-ART.md technique map',
    sourceCommit: 'f7c61e28b1f57753f0fbde8d4fbdc002e8274723',
    editorInvariant: 'No duplicate deletion, shard split, or workflow churn is required without an editor falsifier or independent measured seam.',
    semanticDelta: 'The editor decision concerns browser and release units rather than engine coverage jobs.',
    focusedEditorFalsifier: 'A no-change decision without a complete inventory and failed equivalence hypothesis must be rejected.',
  },
  {
    technique: 'Required-check and ruleset drift from one manifest',
    decision: 'adapt',
    report: 'forgeax-engine-harness/solo/fast-robust-ci/experiments/20260722-140409-audit-required-ruleset-admission-guard/REPORT.md',
    reportCommit: 'b08f8c6460227525df3f28907cc0ab4128f89dd1',
    source: 'forgeax-editor PR #557 and scripts/ci/editor-ci-contract.json',
    sourceCommit: 'c3e2338cdc1e724ac12501178bc7b2a855ddd101',
    editorInvariant: 'scripts/ci/editor-ci-contract.json is the sole producer and smoke-play is the only required aggregate parent.',
    semanticDelta: 'The current editor contract projects four required contexts without creating a second required parent.',
    focusedEditorFalsifier: 'Mutating a child or workflow without the producer contract must fail projection binding.',
  },
  {
    technique: 'Engine multi-fleet roster',
    decision: 'reject',
    report: 'forgeax-engine-harness/solo/fast-robust-ci/experiments/20260721-165446-audit-smoke-fleet-contracts/REPORT.md',
    reportCommit: '33f55fe3d5083ba90b9df9539d1bb643934398c6',
    source: 'forgeax-editor/scripts/ci/engine-technique-migration.mjs',
    sourceCommit: 'c3e2338cdc1e724ac12501178bc7b2a855ddd101',
    editorInvariant: 'Only discovered editor-owned browser and release falsifiers may become children of smoke-play.',
    semanticDelta: 'Engine fleet jobs have no automatic editor acceptance meaning.',
    focusedEditorFalsifier: 'A copied engine job or label without an editor candidate, fixture, oracle, and owner must be rejected.',
  },
  {
    technique: 'Exact dependency release and single-work artifact contract',
    decision: 'defer',
    report: 'forgeax-engine-harness/solo/fast-robust-ci/experiments/20260722-160558-audit-shared-input-bundle/REPORT.md',
    reportCommit: '80df389c34d42d9a01bd215ee98c520c03874223',
    source: 'ENGINE-PRIOR-ART.md exact-dependency row',
    sourceCommit: 'f7c61e28b1f57753f0fbde8d4fbdc002e8274723',
    editorInvariant: 'The current measurement records real setup without inventing a shared prerequisite artifact.',
    semanticDelta: 'Build-once prerequisites remain outside this browser release transfer.',
    focusedEditorFalsifier: 'A new shared prerequisite artifact producer changes ownership and remains deferred.',
  },
  {
    technique: 'Comparable critical-path and first-failure measurement',
    decision: 'defer',
    report: 'forgeax-engine-harness/solo/fast-robust-ci/experiments/20260723-003553-audit-comparable-main-slo-window/REPORT.md',
    reportCommit: 'a5a3d452073cf9f786c3d65177a5e97dadfe6b2e',
    source: 'ENGINE-PRIOR-ART.md comparable-critical-path row',
    sourceCommit: 'f7c61e28b1f57753f0fbde8d4fbdc002e8274723',
    editorInvariant: 'This round records per-unit facts without making a long-window SLO, queue, cost, or first-failure claim.',
    semanticDelta: 'Population-level comparable accounting remains outside this one-round transfer.',
    focusedEditorFalsifier: 'Any SLO or cost claim derived from one measurement index must remain deferred.',
  },
]);

const FALSIFIER_CODES = Object.freeze({
  'Test-tail distribution before sharding or timeout changes': 'measurement-unit-set-drift',
  'Evidence-backed no-change': 'discovery-exclusion-invalid',
  'Required-check and ruleset drift from one manifest': 'portfolio-parent-invalid',
  'Engine multi-fleet roster': 'portfolio-owner-invalid',
  'Exact dependency release and single-work artifact contract': 'execution-fixture-roots-invalid',
  'Comparable critical-path and first-failure measurement': 'measurement-sample-coverage-invalid',
});

export {FALSIFIER_CODES, REQUIRED_ROWS};

function issue(code, expected, observed, hint) {
  return {code, expected, observed, hint};
}

function result(errors = [], value) {
  return value === undefined ? {ok: errors.length === 0, errors} : {ok: errors.length === 0, errors, value};
}

function hashJson(value) {
  return createHash('sha256').update(`${JSON.stringify(value)}\n`).digest('hex');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function gitObject(repo, commit, path) {
  try {
    const object = execFileSync('git', ['-C', repo, 'rev-parse', `${commit}:${path}`], {encoding: 'utf8'}).trim();
    return HEX40.test(object) ? object : null;
  } catch {
    return null;
  }
}

function currentAdmission() {
  const sha = (path) => {
    try { return execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(); } catch { return 'unknown'; }
  };
  return {
    editorSha: sha(ROOT),
    engineSha: sha(join(ROOT, 'packages/engine')),
    interfaceSha: sha(join(ROOT, 'packages/interface')),
    platformIoSha: sha(join(ROOT, 'packages/platform-io')),
    assetsSha: sha(join(ROOT, 'forgeax-editor-assets')),
  };
}

function resolveRecordedReachability(reachability) {
  if (!isObject(reachability)) return null;
  const reportObject = gitObject(reachability.reportRepo, reachability.reportCommit, reachability.reportObjectPath);
  const sourceObject = gitObject(reachability.sourceRepo, reachability.sourceCommit, reachability.sourceObjectPath);
  return {reportObject, sourceObject, reportReachable: Boolean(reportObject), sourceReachable: Boolean(sourceObject)};
}

function immutableEvidence(required) {
  const harness = resolve(ROOT, '.forgeax-harness');
  const engine = resolve(ROOT, 'packages/engine');
  const reportPath = required.report.replace(/^forgeax-engine-harness\//, '');
  const sourceIsEngine = required.source.startsWith('forgeax-engine/');
  const sourceIsHarness = required.source.includes('ENGINE-PRIOR-ART.md');
  const reportRepo = harness;
  const sourceRepo = sourceIsEngine ? engine : sourceIsHarness ? harness : ROOT;
  const sourcePath = sourceIsEngine ? required.source.replace(/^forgeax-engine\//, '') : sourceIsHarness ? 'solo/fast-robust-ci/ENGINE-PRIOR-ART.md' : 'scripts/ci/editor-ci-contract.json';
  const reportObject = gitObject(reportRepo, required.reportCommit, reportPath);
  const sourceObject = gitObject(sourceRepo, required.sourceCommit, sourcePath);
  if (!reportObject || !sourceObject) return {ok: false, error: issue('prior-art-reachability-invalid', {report: {repo: reportRepo, commit: required.reportCommit, path: reportPath}, source: {repo: sourceRepo, commit: required.sourceCommit, path: sourcePath}}, {reportObject, sourceObject}, 'Re-resolve the immutable report and source objects from their recorded repositories before transfer.')};
  return {ok: true, value: {reportPath: required.report, reportCommit: required.reportCommit, sourcePath: required.source, sourceCommit: required.sourceCommit, reportObjectPath: reportPath, sourceObjectPath: sourcePath, immutable: true, method: 'git-cat-file-and-ls-tree-at-recorded-commit', reportReachable: true, sourceReachable: true, reportObject, sourceObject, reportRepo, sourceRepo}};
}

function validateFalsifier(row, required, resolveReachability) {
  const falsifier = row.falsifierResult;
  const expectedCode = FALSIFIER_CODES[required.technique];
  if (!isObject(falsifier) || falsifier.status !== 'pass' || falsifier.executed !== true || falsifier.technique !== required.technique || falsifier.mutation !== required.focusedEditorFalsifier || falsifier.code !== expectedCode || falsifier.observedCode !== expectedCode || !nonEmpty(falsifier.observed) || !HEX64.test(falsifier.mutationDigest ?? '') || !isObject(falsifier.event) || falsifier.event.status !== 'failed-closed' || falsifier.event.technique !== required.technique || falsifier.event.mutation !== required.focusedEditorFalsifier || falsifier.event.observedCode !== expectedCode) return issue('prior-art-falsifier-invalid', {technique: required.technique, code: expectedCode, mutation: required.focusedEditorFalsifier}, falsifier, 'Record an executed, distinct, digest-bound failed-closed falsifier event.');
  const resolved = resolveReachability(row.reachability);
  if (!isObject(row.reachability) || row.reachability.reportPath !== required.report || row.reachability.reportCommit !== required.reportCommit || row.reachability.sourcePath !== required.source || row.reachability.sourceCommit !== required.sourceCommit || row.reachability.immutable !== true || row.reachability.method !== 'git-cat-file-and-ls-tree-at-recorded-commit' || row.reachability.reportReachable !== true || row.reachability.sourceReachable !== true || !HEX40.test(row.reachability.reportObject ?? '') || !HEX40.test(row.reachability.sourceObject ?? '') || !resolved || resolved.reportObject !== row.reachability.reportObject || resolved.sourceObject !== row.reachability.sourceObject || resolved.reportReachable !== true || resolved.sourceReachable !== true) return issue('prior-art-reachability-invalid', {report: required.report, source: required.source}, row.reachability, 'Re-resolve report and source reachability at the immutable recorded commits; imported booleans are insufficient.');
  return null;
}

export function validateEnginePriorArtTransfer(transfer, {measurements, admitted, resolveRecordedReachability: resolveReachability = resolveRecordedReachability} = {}) {
  if (!isObject(transfer) || transfer.schemaVersion !== TRANSFER_SCHEMA_VERSION) return result([issue('prior-art-schema-invalid', TRANSFER_SCHEMA_VERSION, transfer?.schemaVersion, 'Use one machine-validated live prior-art transfer artifact.')]);
  if (!Array.isArray(transfer.rows) || transfer.rows.length !== REQUIRED_ROWS.length) return result([issue('prior-art-row-set-invalid', REQUIRED_ROWS.length, transfer.rows, 'Transfer exactly the six required prior-art mappings.')]);
  const mutations = new Set();
  const codes = new Set();
  for (const required of REQUIRED_ROWS) {
    const row = transfer.rows.find((candidate) => candidate.technique === required.technique);
    if (!row) return result([issue('prior-art-row-missing', required.technique, transfer.rows.map((candidate) => candidate.technique), 'Add the missing prior-art mapping row.')]);
    for (const field of ['decision', 'report', 'reportCommit', 'source', 'sourceCommit', 'editorInvariant', 'semanticDelta', 'focusedEditorFalsifier', 'mappingAction']) if (!nonEmpty(row[field])) return result([issue('prior-art-field-missing', `${required.technique}.${field}`, row[field], 'Record the complete source-bound mapping row.')]);
    if (row.decision !== required.decision || row.report !== required.report || row.reportCommit !== required.reportCommit || row.source !== required.source || row.sourceCommit !== required.sourceCommit) return result([issue('prior-art-source-drift', required, row, 'Do not replace immutable prior-art evidence with a mutable branch reference.')]);
    if (!['no-change', 'update-required'].includes(row.mappingAction)) return result([issue('prior-art-mapping-action-invalid', ['no-change', 'update-required'], row.mappingAction, 'Use the closed mappingAction union.')]);
    const falsifierIssue = validateFalsifier(row, required, resolveReachability);
    if (falsifierIssue) return result([falsifierIssue]);
    if (mutations.has(row.falsifierResult.mutation) || codes.has(row.falsifierResult.code)) return result([issue('prior-art-falsifier-not-distinct', 'six distinct mutations and codes', row.falsifierResult, 'Execute one independent falsifier per prior-art mapping.')]);
    mutations.add(row.falsifierResult.mutation);
    codes.add(row.falsifierResult.code);
  }
  if (!isObject(transfer.admitted) || Object.values(transfer.admitted).some((value) => !HEX40.test(value))) return result([issue('prior-art-admission-invalid', 'five admitted 40-hex SHAs', transfer.admitted, 'Bind transfer to one editor and four submodule admission SHAs.')]);
  if (!measurements || measurements.status !== 'pass') return result([issue('prior-art-measurement-mismatch', 'status=pass measurement index', measurements?.status, 'Focused structural tests cannot replace a live passing measurement index.')]);
  if (!isObject(measurements.admitted) || JSON.stringify(measurements.admitted) !== JSON.stringify(transfer.admitted)) return result([issue('prior-art-admission-drift', measurements.admitted, transfer.admitted, 'Use the same admitted SHA set in measurements and transfer.')]);
  if (measurements.sourceSha !== transfer.admitted.editorSha) return result([issue('prior-art-measurement-mismatch', transfer.admitted.editorSha, measurements.sourceSha, 'The measurement index source must equal the admitted editor SHA.')]);
  if (transfer.measurementDigest !== hashJson(measurements)) return result([issue('prior-art-measurement-mismatch', hashJson(measurements), transfer.measurementDigest, 'Bind transfer to the canonical digest of the exact passing measurement index.')]);
  if (admitted && JSON.stringify(admitted) !== JSON.stringify(transfer.admitted)) return result([issue('prior-art-current-admission-drift', admitted, transfer.admitted, 'The current admission changed; discard this transfer and rerun from the current index.')]);
  return result();
}

export function validateTransferReleaseBoundary(transfer, measurements, topology) {
  if (!isObject(topology) || topology.phase !== 'projected' || topology.status !== 'final') return result([issue('final-claim-topology-not-final', 'projected final topology', topology, 'Complete topology projection before transfer claim.')]);
  if (!measurements || measurements.status !== 'pass') return result([issue('final-claim-index-not-pass', 'pass', measurements?.status, 'Keep the transfer claim blocked until the current index passes.')]);
  if (transfer.measurementDigest !== hashJson(measurements)) return result([issue('final-claim-digest-drift', hashJson(measurements), transfer.measurementDigest, 'All final claims must use one measurement digest.')]);
  if (transfer.admissionGeneration !== measurements.admissionGeneration) return result([issue('final-claim-provenance-drift', measurements.admissionGeneration, transfer.admissionGeneration, 'Transfer must carry the same immutable admission generation as the passing measurement index.')]);
  if (transfer.topologyDigest !== hashJson(topology)) return result([issue('final-claim-topology-digest-drift', hashJson(topology), transfer.topologyDigest, 'Transfer must carry the digest of the exact final topology artifact it consumed.')]);
  for (const field of ['sourceSha', 'contractDigest', 'workflowDigest', 'admissionDigest', 'admissionGeneration']) {
    if (topology[field] !== measurements[field]) return result([issue('final-claim-provenance-drift', {[field]: measurements[field]}, {[field]: topology[field]}, 'Project final topology from the exact passing measurement index; do not mix admission generations.')]);
  }
  if (topology.measurementDigest !== hashJson(measurements)) return result([issue('final-claim-digest-drift', hashJson(measurements), topology.measurementDigest, 'Final topology must reference the exact passing measurement index digest.')]);
  const missing = (topology.units ?? []).find((unit) => !nonEmpty(unit.executionGroup));
  if (missing) return result([issue('final-claim-execution-group-missing', 'executionGroup for every unit', missing, 'Attach final execution evidence before releasing transfer.')]);
  return result([], transfer);
}

function falsifierFor(required, contract, measurements) {
  const mutated = structuredClone(contract.browserReleasePortfolio);
  let check;
  if (required.technique === 'Test-tail distribution before sharding or timeout changes') check = validateMeasurementIndex({...structuredClone(measurements), units: []}, contract.browserReleasePortfolio);
  else if (required.technique === 'Evidence-backed no-change') { mutated.discovery.exclusions = []; check = validateBrowserReleasePortfolio(mutated); }
  else if (required.technique === 'Required-check and ruleset drift from one manifest') { mutated.parentCheckId = 'mutated-parent'; check = validateBrowserReleasePortfolio(mutated); }
  else if (required.technique === 'Engine multi-fleet roster') { mutated.owner = 'engine-ci'; check = validateBrowserReleasePortfolio(mutated); }
  else if (required.technique === 'Exact dependency release and single-work artifact contract') { mutated.discovery.ownedSources = []; check = validateBrowserReleasePortfolio(mutated); }
  else check = validateMeasurementIndex({...structuredClone(measurements), samples: []}, contract.browserReleasePortfolio);
  const code = check.errors?.[0]?.code ?? 'unexpected-pass';
  return {status: check.ok ? 'fail' : 'pass', executed: true, technique: required.technique, mutation: required.focusedEditorFalsifier, mutationDigest: hashJson({technique: required.technique, mutation: required.focusedEditorFalsifier, code}), code: FALSIFIER_CODES[required.technique], observedCode: code, observed: check.errors?.[0] ? `${code}:${JSON.stringify(check.errors[0].observed ?? null)}` : 'unexpected-pass', event: {technique: required.technique, mutation: required.focusedEditorFalsifier, observedCode: code, status: check.ok ? 'unexpected-pass' : 'failed-closed'}};
}

export function createEnginePriorArtTransfer({contract, measurements, admitted} = {}) {
  const portfolioResult = validateBrowserReleasePortfolio(contract?.browserReleasePortfolio);
  if (!portfolioResult.ok) return result(portfolioResult.errors);
  const measurementResult = validateMeasurementIndex(measurements, contract.browserReleasePortfolio);
  if (!measurementResult.ok) return result(measurementResult.errors);
  const admittedNow = admitted ?? currentAdmission();
  if (measurements.sourceSha !== admittedNow.editorSha || JSON.stringify(measurements.admitted) !== JSON.stringify(admittedNow)) return result([issue('prior-art-current-admission-drift', admittedNow, {sourceSha: measurements.sourceSha, admitted: measurements.admitted}, 'Recompute current editor and submodule facts; do not transfer stale pins.')]);
  const rows = [];
  for (const required of REQUIRED_ROWS) {
    const reachability = immutableEvidence(required);
    if (!reachability.ok) return result([reachability.error]);
    const falsifierResult = falsifierFor(required, contract, measurements);
    if (falsifierResult.status !== 'pass') return result([issue('prior-art-falsifier-invalid', 'failed-closed falsifier', falsifierResult, 'Do not release transfer when a mapping mutation unexpectedly passes.')]);
    rows.push({...required, mappingAction: 'no-change', reachability: reachability.value, falsifierResult});
  }
  return result([], {
    schemaVersion: TRANSFER_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    measurementDigest: hashJson(measurements),
    admitted: structuredClone(measurements.admitted),
    rows,
    mappingCorrection: {status: 'recorded', source: 'current-admission-and-contract', verified: true},
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

async function main(argv = process.argv.slice(2)) {
  const contractPath = argument(argv, '--contract');
  const measurementsPath = argument(argv, '--measurements');
  const topologyPath = argument(argv, '--topology');
  const admissionPath = argument(argv, '--admission');
  const outputPath = argument(argv, '--output');
  if (!contractPath || !measurementsPath || !topologyPath || !admissionPath || !outputPath) throw new Error('usage: bun run ci:engine-prior-art-transfer -- --contract CONTRACT --measurements INDEX --topology TOPOLOGY --admission ADMISSION --output OUTPUT');
  const measurements = readJson(resolve(measurementsPath));
  const topologyArtifact = readJson(resolve(topologyPath));
  const topology = isObject(topologyArtifact?.topology) ? topologyArtifact.topology : topologyArtifact;
  const contract = readJson(resolve(contractPath));
  const admission = admissionExpected(resolve(admissionPath));
  if (!admission.ok) { console.error(JSON.stringify(admission.error)); process.exitCode = 1; return; }
  const measurementValidation = validateMeasurementIndex(measurements, contract.browserReleasePortfolio, {expected: admission.value});
  if (!measurementValidation.ok) { console.error(JSON.stringify(measurementValidation.errors[0])); process.exitCode = 1; return; }
  const validatedMeasurements = measurementValidation.value;
  const generated = createEnginePriorArtTransfer({contract, measurements: validatedMeasurements, admitted: admission.value.admitted});
  if (!generated.ok) { console.error(JSON.stringify(generated.errors[0])); process.exitCode = 1; return; }
  const validation = validateEnginePriorArtTransfer(generated.value, {measurements: validatedMeasurements});
  if (!validation.ok) { console.error(JSON.stringify(validation.errors[0])); process.exitCode = 1; return; }
  const transfer = {...generated.value, admissionGeneration: validatedMeasurements.admissionGeneration, topologyDigest: hashJson(topology)};
  const boundary = validateTransferReleaseBoundary(transfer, validatedMeasurements, topology);
  if (!boundary.ok) { console.error(JSON.stringify(boundary.errors[0])); process.exitCode = 1; return; }
  writeFileSync(resolve(outputPath), `${JSON.stringify(transfer, null, 2)}\n`);
}

if (import.meta.main) main().catch((error) => { console.error(`[engine-prior-art] ${error.message ?? error}`); process.exitCode = 1; });
