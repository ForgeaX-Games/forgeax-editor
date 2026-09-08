import { expect, test } from 'bun:test';

import {
  createReferenceCreationRuntime,
  type GatewayCreationPort,
  type ReferenceCreationRuntime,
} from '../../runtime/reference-creation';
import { CreationRunKernel, creationRunVisualReviewStatus } from '../creation-run';
import { CreationRunJournal, type CreationVisualReviewFacts } from '../run-journal';

const visualFacts = (expectation: CreationVisualReviewFacts['expectation'], runId: string): CreationVisualReviewFacts => ({
  authoredBy: 'verify',
  executor: 'step-verify-visual-executor',
  expectation,
  observed: { targetCount: expectation === 'play-prop-roundtrip' ? 3 : 3 },
  verdict: 'pass',
  confidence: 0.97,
  capture: { runId, tapePath: `.forgeax-debug/${runId}/frame-0.tape.bin`, reportPath: `.forgeax-debug/${runId}/frame-0.report.json` },
  renderer: { backend: 'webgpu', generation: 1, carrierGeneration: 1, rendererIdentity: `renderer-${expectation}` },
});

const M2_PERSISTED_BLOCKED_RECORDS = [
  {
    schemaVersion: 'creation-run/v1',
    sequence: 1,
    at: 1786548000000,
    creationRunId: 'creation-m2-1',
    kind: 'run-created',
    referenceFingerprint: 'sha256:reference-m2',
    targetProject: 'games/reference',
    targetScene: 'default',
    originalStage: 'blockout',
    viewSemantics: 'front orthographic reference view',
    visibleFacts: ['root silhouette'],
    inferredFacts: ['hidden back face'],
    unknownFacts: ['occluded underside'],
    fidelityFocus: ['silhouette', 'child relationship', 'warm and cool material regions'],
    correctionBudget: { perStage: 3, total: 12 },
  },
  {
    schemaVersion: 'creation-run/v1',
    sequence: 2,
    at: 1786548000001,
    creationRunId: 'creation-m2-1',
    kind: 'native-seed-committed',
    mutationId: 'creation-m2-1:native-seed',
    operationRunId: 'operation-native-seed-1',
    dispatchCount: 1,
    commitCount: 1,
    mutationCount: 1,
    originalStage: 'blockout',
  },
  {
    schemaVersion: 'creation-run/v1',
    sequence: 3,
    at: 1786548000002,
    creationRunId: 'creation-m2-1',
    kind: 'q5-gap-blocked',
    capabilityId: 'scene.createAsset',
    originalStage: 'blockout',
    capabilityGeneration: 'g0',
    priorOperationRunId: 'operation-native-seed-1',
    owner: '@forgeax/editor-core OperationRun/applier contract owner',
    diagnosticId: 'q5-create-asset-terminal-run',
    nextStep: 'owner.repair',
    code: 'capability-gap',
    expected: 'request-correlated terminal OperationRun',
  },
] as const;

function persistedPort(repairedGeneration = 'g1', onReconnect?: (previousGeneration: string) => void): GatewayCreationPort & { readonly calls: string[] } {
  const calls: string[] = [];
  let repaired = false;
  return {
    calls,
    listOps: () => repaired
      ? [{ id: 'createAsset', available: true, capabilityGeneration: repairedGeneration, operationRun: true }]
      : [{
        id: 'createAsset',
        available: false,
        capabilityGeneration: 'g0',
        blocked: {
          code: 'capability-blocked',
          stage: 'preflight',
          owner: '@forgeax/editor-core OperationRun/applier contract owner',
          diagnosticId: 'q5-create-asset-terminal-run',
          recoveryAction: 'owner.repair',
        },
      }],
    assetCatalog: () => [],
    dispatch: (command) => {
      calls.push(command.kind);
      if (repaired && command.kind === 'createAsset') {
        return {
          ok: true,
          operationRun: {
            requestId: String(command.requestId),
            runId: 'operation-q5-repair-1',
            status: 'running',
          },
        };
      }
      return {
        ok: false,
        error: {
          code: 'capability-blocked',
          stage: 'preflight',
          owner: '@forgeax/editor-core OperationRun/applier contract owner',
          diagnosticId: 'q5-create-asset-terminal-run',
          recoveryAction: 'owner.repair',
          capabilityGeneration: 'g0',
        },
      };
    },
    waitOperationRun: async (requestId) => ({
      ok: true,
      value: { requestId, runId: 'operation-q5-repair-1', status: 'succeeded' },
    }),
    reconnect: (previousGeneration) => { onReconnect?.(previousGeneration); repaired = true; },
  };
}

test('t09 consumes the persisted M2 record and preserves its fail-closed facts', () => {
  const gateway = persistedPort();
  const journal = CreationRunJournal.fromRecords(M2_PERSISTED_BLOCKED_RECORDS);
  const runtime = createReferenceCreationRuntime({ gateway, journal });
  const resumed = runtime.resume('creation-m2-1');

  expect(resumed).toMatchObject({
    ok: true,
    value: {
      creationRunId: 'creation-m2-1',
      originalStage: 'blockout',
      currentStage: 'blockout',
      priorOperationRunId: 'operation-native-seed-1',
      dispatchCount: 1,
      commitCount: 1,
      mutationCount: 1,
      status: 'blocked',
      nextStep: 'owner.repair',
      q5Gap: {
        capabilityGeneration: 'g0',
        originalStage: 'blockout',
        priorOperationRunId: 'operation-native-seed-1',
        owner: '@forgeax/editor-core OperationRun/applier contract owner',
        diagnosticId: 'q5-create-asset-terminal-run',
        nextStep: 'owner.repair',
      },
    },
  });
  expect(gateway.calls).toEqual([]);
  expect(resumed.ok && resumed.value.records).toHaveLength(3);
});

test('t10 repairs the persisted owner in place and records one new q5 mutation', async () => {
  const gateway = persistedPort();
  const journal = CreationRunJournal.fromRecords(M2_PERSISTED_BLOCKED_RECORDS);
  const runtime = createReferenceCreationRuntime({ gateway, journal });
  const ownerRepair = (runtime as unknown as ReferenceCreationRuntime & {
    ownerRepairAndResume: (creationRunId: string) => unknown;
  }).ownerRepairAndResume;

  expect(ownerRepair).toBeTypeOf('function');
  expect(await ownerRepair.call(runtime, 'creation-m2-1')).toMatchObject({
    ok: true,
    run: {
      creationRunId: 'creation-m2-1',
      originalStage: 'blockout',
      currentStage: 'blockout',
      priorOperationRunId: 'operation-native-seed-1',
      dispatchCount: 1,
      commitCount: 1,
      mutationCount: 2,
      status: 'running',
      q5Mutation: {
        mutationId: 'creation-m2-1:q5-mutation',
        operationRunId: 'operation-q5-repair-1',
        capabilityGeneration: 'g1',
      },
    },
  });
  expect(gateway.calls).toEqual(['createAsset']);
  expect(await ownerRepair.call(runtime, 'creation-m2-1')).toMatchObject({ ok: true });
  expect(gateway.calls).toEqual(['createAsset']);
});

test('t10 rejects a same-generation repair without dispatching', async () => {
  const gateway = persistedPort('g0');
  const runtime = createReferenceCreationRuntime({ gateway, journal: CreationRunJournal.fromRecords(M2_PERSISTED_BLOCKED_RECORDS) });
  const result = await runtime.ownerRepairAndResume('creation-m2-1');
  expect(result).toMatchObject({ ok: false, error: { code: 'capability-repair-unavailable', capabilityGeneration: 'g0' } });
  expect(gateway.calls).toEqual([]);
});

test('t10 rejects a stage-shifted persisted record without dispatching', async () => {
  const gateway = persistedPort();
  const journal = CreationRunJournal.fromRecords([...M2_PERSISTED_BLOCKED_RECORDS, {
    schemaVersion: 'creation-run/v1', sequence: 4, at: 1786548000003, creationRunId: 'creation-m2-1', kind: 'stage-advanced', stage: 'detail',
  }]);
  const runtime = createReferenceCreationRuntime({ gateway, journal });
  const result = await runtime.ownerRepairAndResume('creation-m2-1');
  expect(result).toMatchObject({ ok: false, error: { code: 'creation-journal-corrupt' } });
  expect(gateway.calls).toEqual([]);
});

test('t10 passes the persisted capability generation to the owner repair carrier', async () => {
  const generations: string[] = [];
  const gateway = persistedPort('g8', (generation) => generations.push(generation));
  const records = M2_PERSISTED_BLOCKED_RECORDS.map((record) => record.kind === 'q5-gap-blocked'
    ? { ...record, capabilityGeneration: 'g7' }
    : record);
  const runtime = createReferenceCreationRuntime({ gateway, journal: CreationRunJournal.fromRecords(records) });

  expect(await runtime.ownerRepairAndResume('creation-m2-1')).toMatchObject({ ok: true, run: { q5Mutation: { capabilityGeneration: 'g8' } } });
  expect(generations).toEqual(['g7']);
});

test('t10 journal rejects a native entity commit with no EntityHandle', () => {
  const journal = CreationRunJournal.fromRecords([...M2_PERSISTED_BLOCKED_RECORDS, {
    schemaVersion: 'creation-run/v1', sequence: 4, at: 1786548000003, creationRunId: 'creation-m2-1', kind: 'native-entity-committed',
    mutationId: 'root', operationRunId: 'operation-entity', terminalStatus: 'succeeded', name: 'Root',
    dispatchCount: 1, commitCount: 1, mutationCount: 1, stage: 'blockout',
  }]);
  expect(journal.validationError()).toMatchObject({ code: 'creation-journal-corrupt' });
});

test('t10 rejects changed prior mutation counts without dispatching', async () => {
  const gateway = persistedPort();
  const records = M2_PERSISTED_BLOCKED_RECORDS.map((record) => record.kind === 'native-seed-committed'
    ? { ...record, dispatchCount: 2 }
    : record);
  const runtime = createReferenceCreationRuntime({ gateway, journal: CreationRunJournal.fromRecords(records) });
  const result = await runtime.ownerRepairAndResume('creation-m2-1');
  expect(result).toMatchObject({ ok: false, error: { code: 'creation-run-prior-mutation-changed' } });
  expect(gateway.calls).toEqual([]);
});

test('Verify visual review facts are capture-bound and remain the only source of visual status', () => {
  const kernel = new CreationRunKernel(CreationRunJournal.fromRecords(M2_PERSISTED_BLOCKED_RECORDS));
  kernel.append({ creationRunId: 'creation-m2-1', kind: 'q5-mutation-committed', mutationId: 'creation-m2-1:q5-mutation', operationRunId: 'operation-q5', capabilityGeneration: 'g1', mutationCount: 2, originalStage: 'blockout', terminalStatus: 'succeeded' });
  kernel.append({ creationRunId: 'creation-m2-1', kind: 'native-entity-committed', mutationId: 'root', operationRunId: 'operation-entity', terminalStatus: 'succeeded', name: 'Root', entity: 1, mutationCount: 1, dispatchCount: 1, commitCount: 1, stage: 'blockout' });
  kernel.append({ creationRunId: 'creation-m2-1', kind: 'stage-advanced', stage: 'blockout', evidenceId: 'native-entities-committed', provenance: { sourceSequences: [5], operationRunIds: ['operation-entity'] } });
  kernel.append({ creationRunId: 'creation-m2-1', kind: 'save-committed', requestId: 'save-1', operationRunId: 'operation-save', terminalStatus: 'succeeded', provenance: { sourceSequences: [6], operationRunIds: ['operation-entity', 'operation-save'] } });
  kernel.append({ creationRunId: 'creation-m2-1', kind: 'capture-committed', stage: 'edit-after-reopen', evidenceId: 'edit-capture', requestId: 'capture-edit', operationRunId: 'operation-capture-edit', terminalStatus: 'succeeded', artifact: { runId: 'edit-artifact', tapePath: '.forgeax-debug/edit-artifact/frame-0.tape.bin', reportPath: '.forgeax-debug/edit-artifact/frame-0.report.json' }, provenance: { sourceSequences: [7], operationRunIds: ['operation-save', 'operation-capture-edit'] } });
  kernel.append({ creationRunId: 'creation-m2-1', kind: 'capture-committed', stage: 'play-roundtrip', evidenceId: 'play-capture', requestId: 'capture-play', operationRunId: 'operation-capture-play', terminalStatus: 'succeeded', artifact: { runId: 'play-artifact', tapePath: '.forgeax-debug/play-artifact/frame-0.tape.bin', reportPath: '.forgeax-debug/play-artifact/frame-0.report.json' }, provenance: { sourceSequences: [8], operationRunIds: ['operation-save', 'operation-capture-edit', 'operation-capture-play'] } });

  const editReview = kernel.appendVisualReview('creation-m2-1', visualFacts('edit-prop-after-reopen', 'edit-artifact'));
  expect(editReview).toMatchObject({ ok: true, value: { visualReviews: [{ authoredBy: 'verify', verdict: 'pass', confidence: 0.97 }] } });
  expect(editReview.ok && creationRunVisualReviewStatus(editReview.value)).toBe('pass');
  expect(kernel.appendVisualReview('creation-m2-1', visualFacts('edit-prop-after-reopen', 'edit-artifact'))).toMatchObject({ ok: false, error: { code: 'visual-review-duplicate' } });
  expect(kernel.appendVisualReview('creation-m2-1', { ...visualFacts('play-prop-roundtrip', 'play-artifact'), confidence: 2 })).toMatchObject({ ok: false, error: { code: 'visual-review-invalid' } });
});
