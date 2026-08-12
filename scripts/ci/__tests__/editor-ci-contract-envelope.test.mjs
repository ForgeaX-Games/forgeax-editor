import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  ENVELOPE_FIELDS,
  ADMISSION_ENVELOPE_FIELDS,
  createAdmissionEnvelope,
  normalizeEnvelope,
  planRetry,
  validateEnvelope,
  validateLandedDelivery,
  validateAdmissionEnvelope,
} from '../editor-ci-contract-envelope.mjs';
import {
  DEFAULT_ADMISSION_ALLOWLIST,
  projectAdmissionChanges,
  selectHarnessDelivery,
  validateDeliveryState,
} from '../editor-ci-contract.mjs';

const fixturePath = resolve('scripts/ci/fixtures/editor-ci-contract-envelope-cases.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const landedFixture = JSON.parse(readFileSync(resolve('scripts/ci/fixtures/landed-delivery-cases.json'), 'utf8'));
const harnessFixture = JSON.parse(readFileSync(resolve('scripts/ci/fixtures/harness-delivery-cases.json'), 'utf8'));

function clone(value) {
  return structuredClone(value);
}

function approvedInput() {
  return clone(fixture.approvedInput);
}

function makeEnvelope() {
  const result = createAdmissionEnvelope(approvedInput());
  assert.equal(result.ok, true);
  assert.equal(result.status, 'pass');
  return result.envelope;
}

function mutate(value, path, replacement) {
  const result = clone(value);
  const parts = path.split('.');
  const last = parts.pop();
  const parent = parts.reduce((current, part) => current[part], result);
  parent[last] = replacement;
  return result;
}

function mutateNested(value, mutations) {
  const result = clone(value);
  for (const [path, replacement] of Object.entries(mutations)) {
    const parts = path.split('.');
    const last = parts.pop();
    const parent = parts.reduce((current, part) => current[part], result);
    parent[last] = replacement;
  }
  return result;
}

function failureInput(failureClass, transient) {
  const firstFailure = {
    attempt: 1,
    attemptId: 'attempt-local-1',
    code: `${failureClass}-failure`,
    expected: 'check passes',
    observed: 'check failed',
  };
  return {
    checkId: 'b2-self-boot',
    owner: 'editor-ci',
    profile: 'local-fast',
    executionHome: 'local-fast',
    provenance: {
      kind: 'local',
      revision: 'a'.repeat(40),
      timingDomain: 'local-execution',
    },
    terminalStatus: 'failure',
    failureClass,
    code: firstFailure.code,
    expected: firstFailure.expected,
    observed: firstFailure.observed,
    hint: `inspect ${failureClass}`,
    firstFailure,
    attempts: [
      {
        attempt: 1,
        attemptId: firstFailure.attemptId,
        transient,
        status: 'failure',
      },
    ],
    sloClaim: null,
  };
}

test('all terminal results normalize to the same machine-readable envelope', () => {
  for (const mutation of fixture.cases) {
    const envelope = normalizeEnvelope(failureInput(mutation.failureClass, mutation.transient));
    const validation = validateEnvelope(envelope);
    assert.equal(validation.ok, true, mutation.name);
    assert.deepEqual(Object.keys(envelope).sort(), [...ENVELOPE_FIELDS].sort(), mutation.name);
    assert.equal(envelope.firstFailure.attemptId, 'attempt-local-1', mutation.name);
    assert.equal(envelope.attempts.length, 1, mutation.name);
  }
});

test('retry policy is bounded by failure class and transient evidence', () => {
  for (const mutation of fixture.cases) {
    const envelope = normalizeEnvelope(failureInput(mutation.failureClass, mutation.transient));
    const retry = planRetry(envelope);
    assert.equal(retry.retry, mutation.expectedRetry, mutation.name);
    assert.equal(retry.maxAttempts, mutation.expectedMaxAttempts, mutation.name);
  }
});

test('missing envelope fields are structured failures rather than thrown strings', () => {
  const envelope = normalizeEnvelope(failureInput('source', false));
  delete envelope.hint;
  const result = validateEnvelope(envelope);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'envelope-field-missing');
  assert.equal(result.error.expected, 'hint');
  assert.notEqual(result.error.observed, undefined);
  assert.equal(typeof result.error.hint, 'string');
});

test('admission envelope freezes every current input and is repeatable', () => {
  const first = createAdmissionEnvelope(approvedInput());
  const second = createAdmissionEnvelope(approvedInput());
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.deepEqual(Object.keys(first.envelope).sort(), [...ADMISSION_ENVELOPE_FIELDS].sort());
  assert.equal(first.envelope.immutable, true);
  assert.equal(first.envelope.provenance.historicalBranches[0].role, 'provenance-only');
});
test('unresolved human decisions return a blocked handoff and no pass envelope', () => {
  for (const decision of ['sourceBaseline', 'producerOwnership']) {
    const input = approvedInput();
    input[decision].status = 'pending';
    const result = createAdmissionEnvelope(input);
    assert.equal(result.ok, false, decision);
    assert.equal(result.status, 'blocked', decision);
    assert.equal(result.envelope, undefined, decision);
    assert.equal(typeof result.handoff.blocker, 'string', decision);
    assert.equal(typeof result.handoff.owner, 'string', decision);
    assert.ok(Array.isArray(result.handoff.requiredEvidence), decision);
    assert.equal(typeof result.handoff.nextAction, 'string', decision);
    assert.equal(typeof result.error.code, 'string', decision);
    assert.equal(typeof result.error.hint, 'string', decision);
    assert.notEqual(result.error.expected, undefined, decision);
    assert.notEqual(result.error.observed, undefined, decision);
  }
});

test('admission validation rejects every generation and provenance drift case', () => {
  const envelope = makeEnvelope();
  for (const mutation of fixture.admissionCases) {
    const observed = mutation.path
      ? mutate(envelope, mutation.path, mutation.observed)
      : envelope;
    const result = validateAdmissionEnvelope(envelope, observed);
    assert.equal(result.ok, false, mutation.name);
    assert.equal(result.error.code, mutation.expectedCode, mutation.name);
    assert.notEqual(result.error.expected, undefined, mutation.name);
    assert.notEqual(result.error.observed, undefined, mutation.name);
    assert.equal(typeof result.error.hint, 'string', mutation.name);
  }
});

test('historical branch evidence cannot become the current source baseline', () => {
  const input = approvedInput();
  input.sourceBaseline.selectedSha = input.provenance.historicalBranches[0].sha;
  input.candidateSourceSha = input.sourceBaseline.selectedSha;
  input.sourceSha = input.sourceBaseline.selectedSha;
  const result = createAdmissionEnvelope(input);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'historical-source-not-current');
  assert.match(result.error.hint, /provenance/i);
});

test('changed-file projection rejects product and old loop-state paths', () => {
  const result = projectAdmissionChanges(
    [
      'scripts/ci/editor-ci-contract-envelope.mjs',
      'scripts/ci/editor-ci-contract.json',
      'packages/editor-core/src/index.ts',
      '.forgeax-harness/forgeax-loop/old/loop-state.json',
    ],
    DEFAULT_ADMISSION_ALLOWLIST,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.rejected, [
    'packages/editor-core/src/index.ts',
    '.forgeax-harness/forgeax-loop/old/loop-state.json',
  ]);
  assert.equal(result.error.code, 'changed-file-outside-admission-allowlist');
  assert.notEqual(result.error.expected, undefined);
  assert.notEqual(result.error.observed, undefined);
  assert.equal(typeof result.error.hint, 'string');
});

test('landed delivery accepts only one remote-main ancestor and four cloud contexts on that SHA', () => {
  const result = validateLandedDelivery(landedFixture.approvedInput);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'pass');
  assert.equal(result.landedSha, landedFixture.approvedInput.landedSha);
  assert.deepEqual(result.requiredContexts, ['b2-self-boot', 'typecheck', 'submodule-pin', 'smoke-play']);
});

test('landed delivery cases stay structured and fail closed', () => {
  for (const candidate of landedFixture.cases) {
    const input = {...structuredClone(landedFixture.approvedInput), ...structuredClone(candidate.input)};
    const result = validateLandedDelivery(input);
    assert.equal(result.ok, candidate.expectedStatus === 'pass', candidate.name);
    assert.equal(result.status, candidate.expectedStatus, candidate.name);
    if (candidate.expectedCode) {
      assert.equal(result.error.code, candidate.expectedCode, candidate.name);
      assert.equal(typeof result.error.hint, 'string', candidate.name);
      assert.notEqual(result.error.expected, undefined, candidate.name);
      assert.notEqual(result.error.observed, undefined, candidate.name);
      assert.equal(typeof result.handoff.owner, 'string', candidate.name);
      assert.ok(Array.isArray(result.handoff.requiredEvidence), candidate.name);
      assert.equal(typeof result.handoff.nextAction, 'string', candidate.name);
    }
  }
});

test('harness delivery selects only feature artifacts after a remote push', () => {
  const result = selectHarnessDelivery(harnessFixture.approvedInput);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'delivered');
  assert.equal(result.featureId, harnessFixture.approvedInput.featureId);
  assert.equal(result.harnessCommitSha, harnessFixture.approvedInput.harnessDelivery.commitSha);
  assert.deepEqual(result.selectedPaths, harnessFixture.approvedInput.harnessDelivery.selectedPaths);
});

test('harness delivery cases preserve source and floating-harness boundaries', () => {
  for (const candidate of harnessFixture.cases) {
    const input = candidate.mutate
      ? mutateNested(harnessFixture.approvedInput, candidate.mutate)
      : clone(harnessFixture.approvedInput);
    const result = selectHarnessDelivery(input);
    assert.equal(result.ok, candidate.expectedStatus === 'delivered', candidate.name);
    assert.equal(result.status, candidate.expectedStatus, candidate.name);
    if (candidate.expectedCode) {
      assert.equal(result.error.code, candidate.expectedCode, candidate.name);
      assert.equal(typeof result.error.hint, 'string', candidate.name);
      assert.notEqual(result.error.expected, undefined, candidate.name);
      assert.notEqual(result.error.observed, undefined, candidate.name);
      assert.equal(typeof result.handoff.owner, 'string', candidate.name);
      assert.ok(Array.isArray(result.handoff.requiredEvidence), candidate.name);
      assert.equal(typeof result.handoff.nextAction, 'string', candidate.name);
    }
  }
});

test('delivery state keeps landed, admission, and harness boundaries distinct', () => {
  const input = {
    ...clone(landedFixture.approvedInput),
    ...clone(harnessFixture.approvedInput),
  };
  const result = validateDeliveryState(input);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'pass');
  assert.equal(result.landed.landedSha, input.landedSha);
  assert.equal(result.admission.admissionDigest, input.admission.admissionDigest);
  assert.equal(result.harness.harnessCommitSha, input.harnessDelivery.commitSha);

  const staleAdmission = clone(input);
  staleAdmission.contractDigest = '9'.repeat(64);
  const staleResult = validateDeliveryState(staleAdmission);
  assert.equal(staleResult.ok, false);
  assert.equal(staleResult.phase, 'admission');
  assert.equal(staleResult.status, 'nonpass');
  assert.equal(staleResult.error.code, 'delivery-admission-digest-drift');

  const missingHarnessRemote = clone(input);
  missingHarnessRemote.harnessDelivery.remote.reachable = false;
  const pendingResult = validateDeliveryState(missingHarnessRemote);
  assert.equal(pendingResult.ok, false);
  assert.equal(pendingResult.phase, 'harness');
  assert.equal(pendingResult.status, 'pending');
  assert.equal(pendingResult.error.code, 'harness-remote-push-missing');
});
