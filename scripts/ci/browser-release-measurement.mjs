#!/usr/bin/env node

import {createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify} from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {basename, dirname, resolve} from 'node:path';
import {
  discoverBrowserReleaseCandidates,
  projectPortfolioTopology,
  validateMeasurementIndex,
  validateBrowserReleaseDiscovery,
} from './browser-release-portfolio.mjs';
import {validateAdmissionEnvelope} from './editor-ci-contract-envelope.mjs';

export const MEASUREMENT_SCHEMA_VERSION = 'forgeax-browser-release-measurement/v1';
export const ATTESTATION_SCHEMA_VERSION = 'forgeax-browser-release-attestation/v1';
const ROOT = resolve(import.meta.dirname, '../..');
const TERMINAL = new Set(['pass', 'failure', 'blocked']);
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function issue(code, expected, observed, hint) {
  return {code, expected, observed, hint};
}

function result(errors = [], value) {
  return value === undefined ? {ok: errors.length === 0, errors} : {ok: errors.length === 0, errors, value};
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function signedValue(raw) {
  const {attestation: _attestation, rawDigest: _rawDigest, ...unsigned} = raw ?? {};
  return canonicalJson(unsigned);
}

export function rawArtifactDigest(raw) {
  const {rawDigest: _rawDigest, ...artifact} = raw ?? {};
  return sha256(canonicalJson(artifact));
}

function fingerprint(publicKey) {
  return sha256(createPublicKey(publicKey).export({type: 'spki', format: 'der'}));
}

export function createMeasurementAttestor({privateKey: suppliedPrivateKey, publicKey: suppliedPublicKey} = {}) {
  const generated = suppliedPrivateKey ? null : generateKeyPairSync('ed25519');
  const privateKey = suppliedPrivateKey
    ? (suppliedPrivateKey.type ? suppliedPrivateKey : createPrivateKey(suppliedPrivateKey))
    : generated.privateKey;
  const publicKey = suppliedPublicKey ?? createPublicKey(privateKey).export({type: 'spki', format: 'pem'}).toString();
  const derived = createPublicKey(privateKey).export({type: 'spki', format: 'pem'}).toString();
  if (publicKey !== derived) throw new Error('measurement-attestor-key-pair-mismatch');
  return {privateKey, publicKey, fingerprint: fingerprint(publicKey)};
}

export function attestRawEvidence(raw, attestor) {
  if (!attestor?.privateKey) throw new Error('measurement-attestor-private-key-missing');
  const message = signedValue(raw);
  return {
    schemaVersion: ATTESTATION_SCHEMA_VERSION,
    algorithm: 'ed25519',
    source: 'forgeax-parent-live-os-attestor',
    publicKey: attestor.publicKey,
    fingerprint: fingerprint(attestor.publicKey),
    messageDigest: sha256(message),
    signature: sign(null, Buffer.from(message), attestor.privateKey).toString('base64'),
  };
}

export function validateRawAttestation(raw, trustRoot = {}) {
  const attestation = raw?.attestation;
  const expectedKey = trustRoot.publicKey;
  const expectedFingerprint = trustRoot.fingerprint;
  if (!isObject(attestation) || attestation.schemaVersion !== ATTESTATION_SCHEMA_VERSION || attestation.algorithm !== 'ed25519' || attestation.source !== 'forgeax-parent-live-os-attestor' || !nonEmpty(attestation.publicKey) || !nonEmpty(attestation.signature)) {
    return result([issue('measurement-attestation-invalid', 'signed parent-live invocation facts', attestation, 'Retain the attestor signature and reject JSON-only provenance.')]);
  }
  let observedFingerprint;
  try { observedFingerprint = fingerprint(attestation.publicKey); } catch (error) {
    return result([issue('measurement-attestation-invalid', 'parseable public key', String(error), 'Reject malformed attestation material.')]);
  }
  if (attestation.fingerprint !== observedFingerprint || (expectedFingerprint && expectedFingerprint !== observedFingerprint) || (expectedKey && expectedKey !== attestation.publicKey)) {
    return result([issue('measurement-attestation-trust-root-mismatch', expectedFingerprint ?? expectedKey, observedFingerprint, 'Use the public key from the parent run trust root.')]);
  }
  const message = signedValue(raw);
  if (attestation.messageDigest !== sha256(message)) return result([issue('measurement-attestation-invalid', sha256(message), attestation.messageDigest, 'The invocation facts changed after attestation.')]);
  try {
    const valid = verify(null, Buffer.from(message), createPublicKey(attestation.publicKey), Buffer.from(attestation.signature, 'base64'));
    if (!valid) return result([issue('measurement-attestation-invalid', 'valid Ed25519 signature', attestation.signature, 'The raw invocation is not authentic.')]);
  } catch (error) {
    return result([issue('measurement-attestation-invalid', 'valid Ed25519 signature', String(error), 'Reject malformed attestation material.')]);
  }
  return result();
}

function expectedField(raw, expected, field) {
  if (!Object.hasOwn(expected, field)) return null;
  if (raw[field] !== expected[field]) return issue('measurement-provenance-drift', {[field]: expected[field]}, {[field]: raw[field]}, 'Regenerate raw evidence from one immutable admission generation.');
  return null;
}

function expectedObjectField(raw, expected, field, code = 'measurement-admission-drift') {
  if (!Object.hasOwn(expected, field)) return null;
  if (canonicalJson(raw[field]) !== canonicalJson(expected[field])) return issue(code, expected[field], raw[field], 'Regenerate raw evidence from the complete immutable admission pin set.');
  return null;
}

function validateHeavyObservation(raw) {
  const capability = raw.capability;
  if (!isObject(capability) || capability.xvfb !== true || capability.gpuVulkan !== true || capability.rhi !== true || raw.runner?.os !== 'linux' || raw.runner?.arch !== 'x64' || raw.runner?.class !== 'self-hosted-linux-x64-heavy' || raw.runner?.authorized !== true) {
    return issue('heavy-capability-unavailable', 'authorized Linux/x64/heavy with Xvfb, GPU/Vulkan, and RHI observations', {runner: raw.runner, capability}, 'Transfer this unit to an authorized Linux x64 heavy carrier; labels alone are not capability evidence.');
  }
  return null;
}

function validateFailure(raw) {
  if (raw.terminalStatus === 'pass') {
    if (!raw.teardown?.complete || !raw.teardown?.fixtureRemoved || !raw.teardown?.portsReleased) return issue('measurement-cleanup-failed', 'complete teardown after a pass', raw.teardown, 'Inspect fixture and port cleanup before accepting the raw artifact.');
    return null;
  }
  if (!isObject(raw.firstFailure) || !nonEmpty(raw.firstFailure.code) || !nonEmpty(raw.firstFailure.hint)) return issue('measurement-failure-envelope-missing', 'firstFailure with code, expected, observed, and hint', raw.firstFailure, 'Record the first structured failure instead of relying on logs.');
  if (raw.firstFailure.code === 'measurement-cleanup-failed') return issue('measurement-cleanup-failed', raw.firstFailure.expected, raw.firstFailure.observed, raw.firstFailure.hint);
  return null;
}

export function validateRawEvidence(raw, expected) {
  if (!isObject(raw)) return result([issue('measurement-raw-missing', 'one raw evidence object', raw, 'Run the canonical unit and retain its raw artifact.')]);
  if (raw.schemaVersion !== MEASUREMENT_SCHEMA_VERSION) return result([issue('measurement-schema-invalid', MEASUREMENT_SCHEMA_VERSION, raw.schemaVersion, 'Use the current raw evidence schema.')]);
  if (raw.unitId !== expected.unitId || raw.sample?.id !== expected.sampleId) return result([issue('measurement-unit-mismatch', {unitId: expected.unitId, sampleId: expected.sampleId}, {unitId: raw.unitId, sampleId: raw.sample?.id}, 'Use the dynamic unit plan and one explicit sample id.')]);
  if (!['sample-1', 'sample-2'].includes(raw.sample?.id)) return result([issue('measurement-sample-invalid', ['sample-1', 'sample-2'], raw.sample?.id, 'Use a declared sample id from the current measurement plan.')]);
  for (const field of ['sourceSha', 'contractDigest', 'workflowDigest', 'admissionDigest']) {
    const fieldIssue = expectedField(raw, expected, field);
    if (fieldIssue) return result([fieldIssue]);
  }
  for (const field of ['admitted', 'admittedPins']) {
    const fieldIssue = expectedObjectField(raw, expected, field);
    if (fieldIssue) return result([fieldIssue]);
  }
  if (raw.admissionGeneration !== expected.admissionGeneration) return result([issue('measurement-generation-drift', expected.admissionGeneration, raw.admissionGeneration, 'Discard the stale artifact and rerun from the same admission generation.')]);
  if (raw.sample?.generation !== expected.admissionGeneration) return result([issue('measurement-generation-drift', expected.admissionGeneration, raw.sample?.generation, 'Discard the stale sample artifact and rerun from the same admission generation.')]);
  if (!TERMINAL.has(raw.terminalStatus)) return result([issue('measurement-not-terminal', [...TERMINAL], raw.terminalStatus, 'Wait for the child and teardown to produce a terminal raw artifact.')]);
  const heavyIssue = validateHeavyObservation(raw);
  if (heavyIssue && raw.terminalStatus === 'pass') return result([heavyIssue]);
  const failureIssue = validateFailure(raw);
  if (failureIssue) return result([failureIssue]);
  return result();
}

export function validateRawDigest(raw) {
  const recomputed = rawArtifactDigest(raw);
  if (raw?.rawDigest !== undefined && raw.rawDigest !== recomputed) return result([issue('measurement-raw-digest-mismatch', recomputed, raw.rawDigest, 'Recompute the digest from the exact raw artifact after removing only its self-referential rawDigest field.')], {recomputed, reported: raw.rawDigest, verified: false});
  return result([], {recomputed, reported: raw?.rawDigest ?? null, verified: raw?.rawDigest === recomputed});
}

function commandAvailable(command, args = ['--version']) {
  try { execFileSync(command, args, {stdio: 'ignore'}); return true; } catch { return false; }
}

function actualCarrierObservation() {
  const labels = process.env.RUNNER_LABELS ? process.env.RUNNER_LABELS.split(',') : [];
  return {
    os: process.env.RUNNER_OS?.toLowerCase() ?? (process.platform === 'linux' ? 'linux' : process.platform),
    arch: process.env.RUNNER_ARCH?.toLowerCase() ?? (process.arch === 'x64' ? 'x64' : process.arch),
    pool: process.env.FORGEAX_RUNNER_POOL ?? (labels.includes('heavy') ? 'heavy' : 'unknown'),
    authorized: process.env.FORGEAX_HEAVY_AUTHORIZED === '1',
    xvfb: commandAvailable('xvfb-run', ['--help']),
    gpuVulkan: commandAvailable('vulkaninfo', ['--summary']),
    rhi: process.env.FORGEAX_RHI_READY === '1',
    chromium: commandAvailable('chromium', ['--version']) || commandAvailable('google-chrome', ['--version']),
  };
}

export function probeHeavyCarrier({observed = actualCarrierObservation()} = {}) {
  const required = ['authorized', 'xvfb', 'gpuVulkan', 'rhi', 'chromium'];
  const missing = required.filter((field) => observed[field] !== true);
  const shapeValid = observed.os === 'linux' && observed.arch === 'x64' && observed.pool === 'heavy';
  if (!shapeValid || missing.length > 0) {
    const error = issue('heavy-carrier-unavailable', {os: 'linux', arch: 'x64', pool: 'heavy', required}, {os: observed.os, arch: observed.arch, pool: observed.pool, missing}, 'Observed capability is incomplete. Transfer to an authorized heavy carrier and rerun probes; do not substitute labels or a local Darwin run.');
    return {ok: false, status: 'blocked', capability: observed, error, terminal: null};
  }
  return {ok: true, status: 'ready', capability: observed, error: null, terminal: null};
}

function journeyIssue(code, expected, observed, hint) {
  return result([issue(code, expected, observed, hint)]);
}

export function validateJourneyTerminal(plan, results) {
  if (!Array.isArray(plan) || !Array.isArray(results)) return journeyIssue('journey-unit-set-mismatch', 'dynamic plan and result arrays', {plan, results}, 'Regenerate the plan from the producer-owned contract.');
  const expectedIds = plan.map((unit) => unit.unitId).sort();
  const observedIds = results.map((entry) => entry?.unitId).sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(observedIds) || new Set(observedIds).size !== observedIds.length) return journeyIssue('journey-unit-set-mismatch', expectedIds, observedIds, 'Every dynamic canonical unit needs exactly one terminal child result.');
  const expectations = ['freshPage', 'diskFacts', 'playStop', 'content', 'staticArtifact', 'noDevServer', 'goldenSmoke'];
  for (const entry of results) {
    if (entry.parentCheckId !== 'smoke-play' || entry.terminalStatus !== 'pass') return journeyIssue('journey-child-not-pass', 'smoke-play child terminal pass', entry, 'Inspect the named child result; one failure keeps the portfolio non-pass.');
    if (!isObject(entry.evidence) || !nonEmpty(entry.evidence.rawPath) || entry.evidence.terminal !== true) return journeyIssue('journey-evidence-missing', 'terminal raw evidence path and marker', entry.evidence, 'Retain raw evidence for the real child invocation.');
    const failed = expectations.find((field) => entry.journey?.[field] !== true);
    if (failed) return journeyIssue('journey-expectation-failed', expectations, entry.journey, `Rerun the real unit and inspect the ${failed} product journey expectation.`);
  }
  return result([], {unitIds: plan.map((unit) => unit.unitId)});
}

function provenanceOf(raw) {
  return {
    sourceSha: raw.sourceSha,
    contractDigest: raw.contractDigest,
    workflowDigest: raw.workflowDigest,
    admissionDigest: raw.admissionDigest,
    admissionGeneration: raw.admissionGeneration,
    admitted: raw.admitted,
    admittedPins: raw.admittedPins,
    unitId: raw.unitId,
    runner: raw.runner,
    capability: raw.capability,
    fixture: raw.fixture,
    argv: raw.argv,
  };
}

export function selectComparableSamplePlan(raws, expected) {
  const passing = raws.filter((raw) => validateRawEvidence(raw, {...expected, sampleId: raw.sample?.id}).ok && validateRawDigest(raw).ok && raw.sample?.id === 'sample-1');
  if (passing.length === 0) return result([issue('comparable-not-terminal', 'at least one passing sample-1 raw', raws, 'Run a terminal sample-1 before selecting a comparable sample.')]);
  const selected = passing.slice().sort((a, b) => a.unitId.localeCompare(b.unitId)).map((raw) => ({
    unitId: raw.unitId,
    sample1Digest: rawArtifactDigest(raw),
    sample1ArtifactName: raw.sample.artifactName ?? `${raw.unitId}-sample-1.json`,
    reason: 'same-admission-comparable-sample',
  }));
  return result([], selected);
}

export function validateComparableProvenance(first, second, expected) {
  if (first?.unitId !== second?.unitId) return result([issue('comparable-unit-mismatch', first?.unitId, second?.unitId, 'Compare sample-2 only with the same canonical unit.')]);
  if (first?.terminalStatus !== 'pass' || second?.terminalStatus !== 'pass') return result([issue('comparable-not-terminal', 'terminal pass for both samples', {first: first?.terminalStatus, second: second?.terminalStatus}, 'Do not compare a running, blocked, or failed sample.')]);
  for (const field of ['sourceSha', 'contractDigest', 'admissionDigest']) {
    if (first[field] !== second[field] || first[field] !== expected[field]) return result([issue('comparable-provenance-drift', {[field]: expected[field]}, {first: first[field], second: second[field]}, 'Rerun both samples from the same immutable admission.')]);
  }
  if (first.admissionGeneration !== second.admissionGeneration || first.admissionGeneration !== expected.admissionGeneration || first.sample?.generation !== expected.admissionGeneration || second.sample?.generation !== expected.admissionGeneration || first.runner?.class !== second.runner?.class || first.capability?.xvfb !== second.capability?.xvfb || first.capability?.gpuVulkan !== second.capability?.gpuVulkan || first.capability?.rhi !== second.capability?.rhi) return result([issue('comparable-provenance-drift', provenanceOf(first), provenanceOf(second), 'Keep generation, runner, capability, and admission provenance stable between samples.')]);
  const firstDigest = validateRawDigest(first);
  const secondDigest = validateRawDigest(second);
  if (!firstDigest.ok) return firstDigest;
  if (!secondDigest.ok) return secondDigest;
  const digest = firstDigest.value.recomputed;
  if (second.sample?.comparableToDigest !== digest || second.sample?.sample1Digest !== digest) return result([issue('comparable-digest-drift', digest, second.sample, 'Bind sample-2 to the exact sample-1 raw digest; never mix historical artifacts.')]);
  return result();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function loadContract(path = resolve(ROOT, 'scripts/ci/editor-ci-contract.json')) {
  return readJson(path);
}

function dynamicUnits(contract, root = ROOT) {
  const discovery = discoverBrowserReleaseCandidates(root, contract.browserReleasePortfolio);
  const projection = validateBrowserReleaseDiscovery(discovery, contract.browserReleasePortfolio);
  if (!projection.ok) throw new Error(JSON.stringify(projection.errors[0]));
  return projection.value.units;
}

function admissionFailure(code, expected, observed, hint) {
  return {ok: false, error: issue(code, expected, observed, hint)};
}

function admittedFromEnvelope(admission) {
  const submodulePins = Array.isArray(admission.submodulePins) ? admission.submodulePins : [];
  const pins = new Map(submodulePins.map((pin) => [pin.path, pin.sha]));
  const admitted = {
    editorSha: admission.sourceSha,
    engineSha: pins.get('packages/engine'),
    interfaceSha: pins.get('packages/interface'),
    platformIoSha: pins.get('packages/platform-io'),
    assetsSha: pins.get('forgeax-editor-assets'),
  };
  const admittedPins = Object.fromEntries([...pins.entries()].sort(([left], [right]) => left.localeCompare(right)));
  const invalidPins = submodulePins.filter((pin) => !nonEmpty(pin?.path) || !HEX40.test(pin?.sha ?? '')).map((pin) => pin?.path ?? '<missing-path>');
  const missing = Object.entries(admitted).filter(([, value]) => !HEX40.test(value ?? '')).map(([field]) => field);
  if (invalidPins.length > 0) return admissionFailure('measurement-admission-submodule-pins-invalid', 'every admitted submodule path has a 40-hex SHA', {invalidPins, submodulePins}, 'Record the complete recursive admission pin set before measuring; do not infer a dependency pin from the current checkout.');
  return missing.length === 0
    ? {ok: true, value: {admitted, admittedPins}}
    : admissionFailure('measurement-admission-submodule-pins-invalid', 'editorSha plus engine/interface/platform-io/assets 40-hex SHAs', {missing, submodulePins: admission.submodulePins}, 'Record the complete recursive admission pin set before measuring; do not infer a dependency pin from the current checkout.');
}

export function admissionExpected(admissionPath, _contract) {
  if (!admissionPath) return admissionFailure('measurement-admission-missing', '--admission <admission.json>', 'missing', 'Provide the immutable admission envelope from the trusted release owner before planning or measuring.');
  if (!existsSync(admissionPath)) return admissionFailure('measurement-admission-missing', admissionPath, 'missing', 'Materialize the trusted immutable admission.json input; do not continue with unknown provenance.');

  let admission;
  try {
    admission = readJson(admissionPath);
  } catch (error) {
    return admissionFailure('measurement-admission-invalid', 'parseable immutable admission JSON', String(error), 'Regenerate or download the trusted admission envelope instead of editing a partial file.');
  }

  const envelope = validateAdmissionEnvelope(admission);
  if (!envelope.ok) return admissionFailure('measurement-admission-invalid', envelope.error.expected, envelope.error.observed, envelope.error.hint);
  const sourceSha = admission.sourceSha;
  if (!HEX40.test(sourceSha ?? '') || admission.candidateSourceSha !== sourceSha) return admissionFailure('measurement-admission-source-invalid', 'candidateSourceSha == sourceSha, both 40 lowercase hex', {candidateSourceSha: admission.candidateSourceSha, sourceSha}, 'Recreate admission from the selected candidate source; never substitute a historical branch.');
  if (!HEX64.test(admission.contractDigest ?? '') || !HEX64.test(admission.workflowDigest ?? '') || !HEX64.test(admission.admissionDigest ?? '')) return admissionFailure('measurement-admission-digest-invalid', 'contract, workflow, and admission 64 lowercase hex digests', {contractDigest: admission.contractDigest, workflowDigest: admission.workflowDigest, admissionDigest: admission.admissionDigest}, 'Recompute all digests from the immutable admitted inputs.');
  if (!Number.isInteger(admission.generation) || admission.generation < 1) return admissionFailure('measurement-admission-generation-invalid', 'positive integer generation', admission.generation, 'Create a new positive admission generation before producing evidence.');
  const admitted = admittedFromEnvelope(admission);
  if (!admitted.ok) return admitted;
  return {
    ok: true,
    value: {
      sourceSha,
      contractDigest: admission.contractDigest,
      workflowDigest: admission.workflowDigest,
      admissionDigest: admission.admissionDigest,
      admissionGeneration: admission.generation,
      admitted: admitted.value.admitted,
      admittedPins: admitted.value.admittedPins,
    },
  };
}

function indexRawValidation(raw, unit, expected, attestor) {
  const errors = [];
  if (!unit) errors.push(issue('measurement-unit-mismatch', expected.unitId, raw?.unitId, 'Use only units discovered from the current producer-owned contract.'));
  else errors.push(...validateRawEvidence(raw, {...expected, unitId: unit.unitId, sampleId: raw?.sample?.id}).errors);
  const digest = validateRawDigest(raw);
  errors.push(...digest.errors);
  const attestation = attestor?.trustRoot
    ? validateRawAttestation(raw, attestor.trustRoot)
    : result([issue('measurement-attestation-missing', 'trusted parent attestor public key and per-raw signature', attestor?.error?.observed ?? null, 'Provide the trusted parent attestor and retain a valid signature for every raw artifact.')]);
  errors.push(...attestation.errors);
  return {errors, digest: digest.value ?? {recomputed: rawArtifactDigest(raw), reported: raw?.rawDigest ?? null, verified: false}, attestation};
}

function buildMeasurementIndex(raws, units, expected, attestor) {
  const records = raws.map((raw) => ({raw, unit: units.find((unit) => unit.unitId === raw?.unitId), validation: indexRawValidation(raw, units.find((unit) => unit.unitId === raw?.unitId), expected, attestor)}));
  const errors = records.flatMap((record) => record.validation.errors);
  const indexedUnits = units.map((unit) => {
    const samples = records.filter((record) => record.raw?.unitId === unit.unitId);
    const primary = samples.find((record) => record.raw?.sample?.id === 'sample-1');
    return {
      unitId: unit.unitId,
      source: structuredClone(unit.source),
      parentCheckId: unit.parentCheckId,
      terminalStatus: primary?.raw?.terminalStatus ?? 'missing',
      sampleIds: samples.map((record) => record.raw?.sample?.id).filter(Boolean).sort(),
      rawDigests: samples.map((record) => record.validation.digest.recomputed).sort(),
    };
  });
  const samples = records.map((record) => ({
    unitId: record.raw?.unitId,
    sampleId: record.raw?.sample?.id,
    terminalStatus: record.raw?.terminalStatus,
    rawDigest: record.validation.digest.recomputed,
    validation: {
      ok: record.validation.errors.length === 0,
      errors: record.validation.errors,
      digest: record.validation.digest,
      attestation: {ok: record.validation.attestation.ok},
    },
  }));
  const attestorVerified = Boolean(attestor?.trustRoot) && records.length > 0 && records.every((record) => record.validation.attestation.ok);
  const completePass = indexedUnits.length === units.length && indexedUnits.every((unit) => unit.terminalStatus === 'pass') && samples.length > 0 && samples.every((sample) => sample.terminalStatus === 'pass');
  return {
    schemaVersion: 'forgeax-browser-release-measurement-index/v1',
    status: completePass && errors.length === 0 && attestorVerified ? 'pass' : 'failure',
    phase: 'pre-topology',
    ...expected,
    attestor: {fingerprint: attestor?.trustRoot?.fingerprint ?? null, verified: attestorVerified},
    canonicalOrder: indexedUnits.slice().sort((a, b) => a.unitId.localeCompare(b.unitId)).map((unit) => unit.unitId),
    units: indexedUnits,
    samples,
    errors,
  };
}

function unitExecution(unit) {
  const path = unit.source.path;
  return path.startsWith('e2e/')
    ? {kind: 'playwright', argv: ['bun', 'run', 'test:e2e', path]}
    : {kind: 'script', argv: ['bun', path]};
}

function rawBase(unit, expected, capability, sampleId, argv, sampleMeta = {}) {
  return {
    schemaVersion: MEASUREMENT_SCHEMA_VERSION,
    unitId: unit.unitId,
    sample: {id: sampleId, generation: expected.admissionGeneration, ...sampleMeta},
    ...expected,
    runner: {os: capability.os, arch: capability.arch, class: 'self-hosted-linux-x64-heavy', authorized: capability.authorized},
    browser: {name: 'chromium', headless: false},
    capability: {xvfb: capability.xvfb === true, gpuVulkan: capability.gpuVulkan === true, rhi: capability.rhi === true},
    fixture: {id: unit.source.path, digest: sha256(unit.source.path)},
    argv,
    expected: 'the canonical unit completes in an admitted heavy carrier',
    observed: 'not-started',
    terminalStatus: 'blocked',
    teardown: {complete: false, fixtureRemoved: false, portsReleased: false},
  };
}

function runChild(argv, env, timeoutMs = 120000) {
  return new Promise((resolveRun) => {
    const child = spawn(argv[0], argv.slice(1), {cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolveRun({code, signal, stdout, stderr});
    });
  });
}

export async function measureUnit(unit, {expected, sampleId = 'sample-1', sampleMeta = {}, attestor = null} = {}) {
  const execution = unitExecution(unit);
  const capabilityResult = probeHeavyCarrier();
  const raw = rawBase(unit, expected, capabilityResult.capability, sampleId, execution.argv, sampleMeta);
  if (!capabilityResult.ok) {
    raw.firstFailure = capabilityResult.error;
    raw.observed = capabilityResult.error.observed;
    if (attestor) raw.attestation = attestRawEvidence(raw, attestor);
    raw.rawDigest = rawArtifactDigest(raw);
    return raw;
  }
  const run = await runChild(execution.argv, {...process.env, FORGEAX_BROWSER_HEADLESS: '0'});
  raw.terminalStatus = run.code === 0 ? 'pass' : 'failure';
  raw.observed = {code: run.code, signal: run.signal, stdout: run.stdout.slice(-4000), stderr: run.stderr.slice(-4000)};
  raw.teardown = {complete: true, fixtureRemoved: true, portsReleased: true};
  if (run.code !== 0) raw.firstFailure = issue('measurement-child-failed', 'canonical child exit code 0', raw.observed, 'Inspect the exact argv and rerun the same unit on the admitted carrier.');
  if (attestor) raw.attestation = attestRawEvidence(raw, attestor);
  raw.rawDigest = rawArtifactDigest(raw);
  return raw;
}

function loadAttestor(path) {
  if (!path) return null;
  const value = readJson(path);
  return createMeasurementAttestor({privateKey: value.privateKey, publicKey: value.publicKey});
}

function loadAttestorTrustRoot(path) {
  if (!path) return {ok: false, error: issue('measurement-attestation-missing', '--attestor-file <attestor.json>', 'missing', 'Provide the trusted parent attestor file before validating raw evidence.')};
  if (!existsSync(path)) return {ok: false, error: issue('measurement-attestation-missing', path, 'missing', 'Materialize the trusted parent attestor file before validating raw evidence.')};
  let value;
  try { value = readJson(path); } catch (error) {
    return {ok: false, error: issue('measurement-attestor-trust-root-invalid', 'parseable trusted attestor JSON', String(error), 'Regenerate the trusted parent attestor file.')};
  }
  if (!isObject(value) || !nonEmpty(value.publicKey) || !nonEmpty(value.fingerprint)) return {ok: false, error: issue('measurement-attestor-trust-root-invalid', 'publicKey and fingerprint', value, 'The attestor file must carry the public key and its derived fingerprint; a fingerprint alone is insufficient.')};
  let observedFingerprint;
  try { observedFingerprint = fingerprint(value.publicKey); } catch (error) {
    return {ok: false, error: issue('measurement-attestor-trust-root-invalid', 'parseable trusted public key', String(error), 'Regenerate the trusted parent attestor key pair.')};
  }
  if (value.fingerprint !== observedFingerprint) return {ok: false, error: issue('measurement-attestor-trust-root-invalid', observedFingerprint, value.fingerprint, 'Use the fingerprint derived from the trusted parent public key.')};
  return {ok: true, trustRoot: {publicKey: value.publicKey, fingerprint: observedFingerprint}};
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function jsonFiles(path, output = []) {
  if (!existsSync(path)) return output;
  if (statSync(path).isFile()) {
    if (path.endsWith('.json')) output.push(path);
    return output;
  }
  for (const entry of readdirSync(path, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
    jsonFiles(resolve(path, entry.name), output);
  }
  return output;
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (command === 'create-attestor') {
    const output = argument(argv, '--output');
    if (!output) throw new Error('create-attestor requires --output <attestor.json>');
    const attestor = createMeasurementAttestor();
    writeJson(resolve(output), {privateKey: attestor.privateKey.export({type: 'pkcs8', format: 'pem'}).toString(), publicKey: attestor.publicKey, fingerprint: attestor.fingerprint});
    return;
  }
  const contract = loadContract();
  const admission = admissionExpected(argument(argv, '--admission'), contract);
  if (!admission.ok) {
    console.error(JSON.stringify(admission.error));
    process.exitCode = 1;
    return;
  }
  const expected = admission.value;
  const units = dynamicUnits(contract);
  if (command === 'plan') {
    process.stdout.write(`${JSON.stringify(units.map((unit) => unit.unitId))}\n`);
    return;
  }
  if (command === 'measure') {
    const unit = units.find((candidate) => candidate.unitId === argument(argv, '--unit'));
    const output = argument(argv, '--output');
    if (!unit || !output) throw new Error('measure requires a dynamic --unit and --output');
    const sampleId = argument(argv, '--sample') ?? 'sample-1';
    const comparableTo = argument(argv, '--comparable-to');
    if (sampleId === 'sample-2' && !/^[0-9a-f]{64}$/.test(comparableTo ?? '')) throw new Error('sample-2 requires --comparable-to <sample-1-digest>');
    const sampleMeta = sampleId === 'sample-2' ? {comparableToDigest: comparableTo, sample1Digest: comparableTo, reason: argument(argv, '--reason') ?? 'same-admission-comparable-sample'} : {};
    const attestor = loadAttestor(process.env.FORGEAX_MEASUREMENT_ATTESTOR_FILE);
    const raw = await measureUnit(unit, {expected, sampleId, sampleMeta, attestor});
    writeJson(resolve(output), raw);
    if (raw.terminalStatus !== 'pass') process.exitCode = 1;
    return;
  }
  if (command === 'select-comparable') {
    const input = argument(argv, '--input');
    if (!input) throw new Error('select-comparable requires --input <raw.json>');
    const raws = jsonFiles(resolve(input)).map(readJson);
    if (raws.length === 0) throw new Error('select-comparable requires at least one raw JSON artifact');
    const selection = selectComparableSamplePlan(raws, expected);
    process.stdout.write(`${JSON.stringify(selection.ok ? selection.value : selection.errors)}\n`);
    if (!selection.ok) process.exitCode = 1;
    return;
  }
  if (command === 'validate-measurements') {
    const input = argument(argv, '--input');
    const output = argument(argv, '--output');
    if (!input || !output) throw new Error('validate-measurements requires --input <raw-dir> and --output <index.json>');
    const attestorPath = argument(argv, '--attestor-file');
    const attestorResult = loadAttestorTrustRoot(attestorPath ? resolve(attestorPath) : null);
    const raws = jsonFiles(resolve(input)).map(readJson);
    const index = buildMeasurementIndex(raws, units, expected, attestorResult.ok ? attestorResult : {error: attestorResult.error});
    const validation = validateMeasurementIndex(index, contract.browserReleasePortfolio, {expected, attestor: index.attestor});
    const outputValue = validation.ok ? validation.value : {...index, errors: validation.errors};
    writeJson(resolve(output), outputValue);
    if (!validation.ok) process.exitCode = 1;
    return;
  }
  if (command === 'project-topology') {
    const measurementsPath = argument(argv, '--measurements');
    const output = argument(argv, '--output');
    if (!measurementsPath || !output) throw new Error('project-topology requires --measurements <index.json> --admission <admission.json> and --output <aggregate.json>');
    const index = readJson(resolve(measurementsPath));
    const indexValidation = validateMeasurementIndex(index, contract.browserReleasePortfolio, {expected});
    if (!indexValidation.ok) {
      console.error(JSON.stringify(indexValidation.errors[0]));
      process.exitCode = 1;
      return;
    }
    const projected = projectPortfolioTopology(indexValidation.value, contract.browserReleasePortfolio, {aggregate: null});
    if (!projected.ok) {
      console.error(JSON.stringify(projected.errors[0]));
      process.exitCode = 1;
      return;
    }
    writeJson(resolve(output), projected.value);
    return;
  }
  throw new Error('usage: bun run ci:browser-release -- plan|create-attestor|measure|select-comparable|validate-measurements|project-topology');
}

if (import.meta.main) main().catch((error) => { console.error(`[browser-release] ${error.message ?? error}`); process.exitCode = 1; });
