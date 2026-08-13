import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { classifyPostMergeAdmission } from '../post-merge-monitor.mjs';
import { createDeliveryEnvelope } from '../editor-ci-contract-envelope.mjs';

const fixturePath = resolve('scripts/ci/fixtures/post-merge-ruleset-cases.json');

test('ruleset admission fixtures fail closed when live evidence is absent or drifts', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  for (const mutation of fixture.cases) {
    const result = classifyPostMergeAdmission({
      workflowRun: {
        id: mutation.workflowRun?.id ?? 801,
        run_attempt: mutation.workflowRun?.run_attempt ?? 2,
        head_sha: 'target-sha-001',
        html_url: 'https://github.com/ForgeaX-Games/forgeax-editor/actions/runs/801',
      },
      targetSha: 'target-sha-001',
      jobs: mutation.jobs,
      liveRuleset: mutation.liveRuleset,
      liveEvidence: mutation.liveEvidence ?? true,
      requiredContexts: mutation.requiredContexts ?? ['typecheck'],
    });

    assert.equal(result.ok, false, mutation.name);
    assert.equal(result.envelope.failureClass, mutation.expectedClass, mutation.name);
    assert.equal(result.envelope.code, mutation.expectedCode, mutation.name);
    assert.equal(result.envelope.terminalStatus, 'failure', mutation.name);
  }
});

test('unavailable live ruleset is not converted into a fixture-backed green result', () => {
  const result = classifyPostMergeAdmission({
    workflowRun: { id: 801, run_attempt: 1, head_sha: 'target-sha-001', html_url: 'https://example.test/run/801' },
    targetSha: 'target-sha-001',
    jobs: [{ id: 901, name: 'typecheck', conclusion: 'success' }],
    liveRuleset: null,
    liveEvidence: false,
    requiredContexts: ['typecheck'],
  });
  assert.equal(result.ok, false);
  assert.notEqual(result.envelope.failureClass, null);
  assert.equal(result.envelope.terminalStatus, 'failure');
});

function applyDeliveryMutation(input, mutation) {
  const next = structuredClone(input);
  if (!mutation) return next;
  if (mutation.kind === 'missing-context') next.landed.contexts = next.landed.contexts.slice(0, -1);
  if (mutation.kind === 'wrong-context-sha') next.landed.contexts[0].sha = mutation.value;
  if (mutation.kind === 'non-cloud-context') next.landed.contexts[0].provenance = {kind: 'local', timingDomain: 'local-execution'};
  if (mutation.kind === 'remote-ancestry') next.landed.remoteMain.ancestor = mutation.value;
  if (mutation.kind === 'required-context-drift') next.landed.requiredContexts = mutation.value;
  if (mutation.kind === 'stale-generation') next.expectedAdmissionGeneration = mutation.value;
  return next;
}

test('delivery ruleset accepts only the exact four cloud contexts on landed SHA', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  for (const mutation of fixture.deliveryCases) {
    const input = applyDeliveryMutation(fixture.deliveryBase, mutation.mutation);
    const result = createDeliveryEnvelope(input);
    assert.equal(result.status, mutation.expectedStatus, mutation.name);
    assert.equal(result.ok, mutation.expectedStatus === 'pass', mutation.name);
    if (mutation.expectedCode) assert.equal(result.error.code, mutation.expectedCode, mutation.name);
  }
});
