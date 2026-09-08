import { expect, test } from 'bun:test';

import {
  createReferenceCreationEntry,
  type GatewayCreationPort,
} from '../reference-creation';
import { PRODUCT_CONTRACT_MANIFEST } from '../../contracts/manifest';

const input = {
  creationRunId: 'reference-entry-test',
  referenceFingerprint: 'sha256:reference-entry',
  targetProject: 'games/reference',
  targetScene: 'default',
  originalStage: 'blockout',
  viewSemantics: 'front orthographic reference view',
  visibleFacts: ['root silhouette'],
  inferredFacts: ['hidden back face'],
  unknownFacts: ['occluded underside'],
  fidelityFocus: ['silhouette', 'hierarchy'],
  correctionBudget: { perStage: 3, total: 12 },
};

const captureProvenance = {
  backend: 'webgpu', rendererIdentity: 'renderer-test', rendererGeneration: 1,
  carrierGeneration: 1, carrierId: 'carrier-test', carrierKind: 'local',
  runtimeId: 'runtime-test', runtimeGeneration: 1,
};

function port(): GatewayCreationPort & { readonly calls: string[] } {
  const calls: string[] = [];
  let repaired = false;
  return {
    calls,
    listOps: () => [
      { id: 'addSceneAssetToScene', available: true, operationRun: true },
      { id: 'spawnEntity', available: true, operationRun: true },
      { id: 'captureFrame', available: true, operationRun: true },
      repaired
        ? { id: 'createAsset', available: true, operationRun: true, capabilityGeneration: 'g1' }
        : { id: 'createAsset', available: false, operationRun: false, capabilityGeneration: 'g0', blocked: { recoveryAction: 'owner.repair' } },
    ],
    assetCatalog: () => [{ guid: 'scene-entry-1', kind: 'scene', name: 'Entry Seed' }],
    query: () => ({ rows: [{ entity: 11, Name: { value: 'Reference Root' } }] }),
    dispatch: (command) => {
      calls.push(command.kind);
      if (command.kind === 'createAsset' && !repaired) return { ok: false, error: { code: 'capability-blocked', hint: 'blocked', capabilityGeneration: 'g0' } };
      return { ok: true, operationRun: { requestId: String(command.requestId), runId: `${command.kind}-run`, operationId: command.kind, status: 'running' } };
    },
    waitOperationRun: async (requestId) => requestId.startsWith('fail-')
      ? { ok: true, value: { requestId, runId: `${requestId}-run`, status: 'failed', error: { code: 'native-write-failed', hint: 'fixture failure' } } }
      : { ok: true, value: { requestId, runId: `${requestId}-run`, operationId: requestId.startsWith('capture-') ? 'captureFrame' : 'saveDocToDisk', status: 'succeeded', result: requestId.startsWith('capture-') ? { runId: `artifact-${requestId}-run`, tapePath: `.forgeax-debug/artifact-${requestId}-run/frame-0.tape.bin`, reportPath: `.forgeax-debug/artifact-${requestId}-run/frame-0.report.json`, provenance: captureProvenance } : { created: [11] } } },
    reconnect: () => { repaired = true; },
  };
}

test('public reference entry projects live capabilities and has a zero-write preflight', async () => {
  const gateway = port();
  let persisted: readonly unknown[] = [];
  const journalStore = {
    read: () => persisted,
    write: (records: readonly unknown[]) => { persisted = records; },
  };
  const entry = createReferenceCreationEntry({ gateway, journalStore });
  const preflight = entry.preflight(input);
  expect(preflight).toMatchObject({ ok: true, value: { id: 'forgeax-reference-creation', zeroWritePreflight: { mutates: false } } });
  expect(PRODUCT_CONTRACT_MANIFEST.skills[0]).toMatchObject({
    id: 'forgeax-reference-creation',
    publicEntry: 'createReferenceCreationEntry',
    publicRoute: 'reference-creation',
    zeroWritePreflight: { mutates: false },
  });
  expect(entry.skill().capabilities.find((capability) => capability.id === 'createAsset')).toMatchObject({
    available: false,
    operationRun: false,
  });
  expect(gateway.calls).toEqual([]);
  expect(entry.skill().shortestRoute).toContain('resume');

  const started = await entry.start(input);
  expect(started).toMatchObject({ ok: false, error: { code: 'capability-gap' }, run: { status: 'blocked' } });
  const repaired = await entry.ownerRepairAndResume(input.creationRunId);
  expect(repaired).toMatchObject({ ok: true, run: { q5Mutation: { capabilityGeneration: 'g1' } } });
  const entities = await entry.createNativeEntities(input.creationRunId, [{
    mutationId: 'root',
    name: 'Reference Root',
    components: {},
  }]);
  expect(entities).toMatchObject({ ok: true, run: { nativeEntities: [{ name: 'Reference Root', entity: 11 }] } });
  expect(await entry.recordEvidence(input.creationRunId, {
    kind: 'stage-advanced',
    stage: 'blockout',
    evidenceId: 'native-entities-committed',
  })).toMatchObject({ ok: true, run: { stageAdvanceCount: 1 } });
  expect(await entry.recordEvidence(input.creationRunId, {
    kind: 'save-committed',
    requestId: 'save-test',
    evidenceId: 'save-test',
  })).toMatchObject({ ok: true, run: { saveCount: 1 } });
  expect(await entry.recordEvidence(input.creationRunId, {
    kind: 'capture-committed',
    stage: 'edit-after-reopen',
    evidenceId: 'edit-test',
    requestId: 'capture-edit-test',
  })).toMatchObject({ ok: true, run: { captureCount: 1 } });
  expect(await entry.recordEvidence(input.creationRunId, {
    kind: 'capture-committed',
    stage: 'play-roundtrip',
    evidenceId: 'play-test',
    requestId: 'capture-play-test',
  })).toMatchObject({ ok: true, run: { captureCount: 2 } });
  const report = entry.finalize(input.creationRunId, {
    input: 'pass',
    structure: 'pass',
    persistence: 'pass',
    play: 'pass',
    visual: 'unproven',
    toolCompleteness: 'pass',
    uncompletedItems: [],
  });
  expect(report).toMatchObject({ ok: true, report: { verdict: 'fail', persistence: 'pass', play: 'pass', visual: 'unproven', uncompletedItems: ['visual review pending'] } });
  expect(entry.journal(input.creationRunId).some((record) => record.kind === 'final-report')).toBe(true);
  const resumedEntry = createReferenceCreationEntry({ gateway, journalStore });
  expect(resumedEntry.resume(input.creationRunId)).toMatchObject({ ok: true, value: { creationRunId: input.creationRunId, q5Mutation: { capabilityGeneration: 'g1' } } });
});

test('public skill descriptor is the single typed action and lifecycle contract', () => {
  const descriptor = createReferenceCreationEntry({ gateway: port() }).skill();
  const actions = descriptor.actions.map((action) => action.action);

  expect(actions).toEqual([...descriptor.shortestRoute]);
  expect(new Set(actions).size).toBe(actions.length);
  expect(descriptor.actions.every((action) => action.method === 'reference-creation' && action.terminal)).toBe(true);
  expect(descriptor.actions.every((action) => action.terminalResult === descriptor.terminalResult)).toBe(true);
  expect(descriptor.terminalResult).toEqual({
    success: 'ReferenceCreationResult.run',
    failure: 'ReferenceCreationResult.error',
    operationRunStatuses: ['accepted', 'running', 'succeeded', 'failed', 'cancelled'],
    terminalOperationRunStatuses: ['succeeded', 'failed', 'cancelled'],
  });

  const preflight = descriptor.actions.find((action) => action.action === 'preflight');
  const start = descriptor.actions.find((action) => action.action === 'start');
  expect(preflight?.parameters).toMatchObject({
    type: 'object',
    required: ['action', 'input'],
    properties: { action: { type: 'string' }, input: { type: 'object' } },
  });
  expect(start?.parameters.properties.input).toMatchObject({
    type: 'object',
    required: expect.arrayContaining(['creationRunId', 'originalStage', 'correctionBudget']),
  });
  expect(descriptor.actions.map((action) => action.entryMethod)).toEqual([
    'skill', 'preflight', 'start', 'resume', 'ownerRepairAndResume', 'createNativeEntities',
    'correct', 'recordEvidence', 'appendVisualReview', 'finalize', 'journal',
  ]);
  expect(descriptor.lifecycle).toEqual({
    save: { action: 'recordEvidence', eventKind: 'save-committed', stage: 'save' },
    reopen: { action: 'recordEvidence', eventKind: 'stage-advanced', stage: 'edit-after-reopen' },
    play: { action: 'recordEvidence', eventKind: 'stage-advanced', stage: 'play-roundtrip' },
    capture: { action: 'recordEvidence', eventKind: 'capture-committed', stages: ['edit-after-reopen', 'play-roundtrip'] },
  });
});

test('reference entry returns structured input, capability, terminal, and budget failures', async () => {
  const gateway = port();
  const entry = createReferenceCreationEntry({ gateway });
  expect(entry.preflight({ ...input, viewSemantics: '' })).toMatchObject({
    ok: false,
    error: { code: 'creation-input-incomplete', stage: 'preflight' },
  });

  const started = await entry.start({ ...input, creationRunId: 'correction-test' });
  expect(started).toMatchObject({ ok: false, error: { code: 'capability-gap' } });
  expect(await entry.ownerRepairAndResume('correction-test')).toMatchObject({ ok: true });

  const missing = await entry.correct('correction-test', {
    stage: 'blockout',
    issueGroup: { id: 'missing-operation', issues: ['missing operation'] },
    command: { kind: 'not-a-capability', requestId: 'missing-correction' },
  });
  expect(missing).toMatchObject({
    ok: false,
    error: { code: 'capability-missing', stage: 'correction', recoveryActions: ['editor.discover'] },
    run: { records: expect.arrayContaining([expect.objectContaining({ kind: 'correction-failed', code: 'capability-missing' })]) },
  });

  const failed = await entry.correct('correction-test', {
    stage: 'blockout',
    issueGroup: { id: 'terminal-write-failed', issues: ['terminal write failed'] },
    command: { kind: 'addSceneAssetToScene', requestId: 'fail-correction' },
  });
  expect(failed).toMatchObject({
    ok: false,
    error: { code: 'correction-not-terminal-success', stage: 'wait' },
    run: { records: expect.arrayContaining([expect.objectContaining({ kind: 'correction-failed', code: 'operation-failed' })]) },
  });
  expect(failed).toMatchObject({ run: { totalCorrectionCount: 1 } });

  for (const index of [1, 2]) {
    const correction = await entry.correct('correction-test', {
      stage: 'blockout',
      issueGroup: { id: `bounded-correction-${index}`, issues: [`bounded correction ${index}`] },
      command: { kind: 'addSceneAssetToScene', requestId: `correction-${index}` },
    });
    expect(correction).toMatchObject({
      ok: true,
      run: {
        totalCorrectionCount: index + 1,
      },
    });
    const committedCorrection = correction.run.records.find((record) => record.kind === 'correction' && record.issueGroupId === `bounded-correction-${index}`);
    expect(committedCorrection).toMatchObject({
      kind: 'correction',
      issueGroupId: `bounded-correction-${index}`,
      budgetConsumed: true,
      preQuery: { query: 'world.snapshot', rowCount: 1 },
      postQuery: { query: 'world.snapshot', rowCount: 1 },
      stageJudgment: { status: 'unchanged' },
    });
  }
  const exhausted = await entry.correct('correction-test', {
    stage: 'blockout',
    issueGroup: { id: 'fourth-correction', issues: ['fourth correction is uncompleted'] },
    command: { kind: 'addSceneAssetToScene', requestId: 'correction-4' },
  });
  expect(exhausted).toMatchObject({
    ok: false,
    error: { code: 'correction-budget-exhausted', stage: 'correction' },
    run: { records: expect.arrayContaining([expect.objectContaining({ kind: 'uncompleted-item', reason: 'correction-budget-exhausted' })]) },
  });
});

test('reference correction rejects malformed nested payloads without throwing or dispatching', async () => {
  const gateway = port();
  const entry = createReferenceCreationEntry({ gateway });
  const runId = 'malformed-correction-input';
  expect(await entry.start({ ...input, creationRunId: runId })).toMatchObject({ ok: false, error: { code: 'capability-gap' } });
  expect(await entry.ownerRepairAndResume(runId)).toMatchObject({ ok: true });
  const callsBeforeMalformed = [...gateway.calls];

  const malformed = [
    null,
    { stage: 'blockout', issueGroup: null, command: { kind: 'spawnEntity' } },
    { stage: 'blockout', issueGroup: { id: 'issue', issues: ['missing command'] }, command: null },
    { stage: 'blockout', issueGroup: { id: 'issue', issues: ['empty command kind'] }, command: { kind: '' } },
  ];
  for (const correction of malformed) {
    const result = await entry.correct(runId, correction as never);
    expect(result).toMatchObject({ ok: false, error: { stage: 'correction', retryable: false } });
    expect(result.run.records.at(-1)).toMatchObject({ kind: 'correction-failed', budgetConsumed: false });
  }
  expect(gateway.calls).toEqual(callsBeforeMalformed);
  expect(entry.journal(runId).filter((record) => record.kind === 'correction')).toEqual([]);
});

test('reference entry exposes Verify visual review intake but keeps missing capture facts fail-closed', async () => {
  const entry = createReferenceCreationEntry({ gateway: port() });
  const runId = 'visual-review-intake';
  expect(await entry.start({ ...input, creationRunId: runId })).toMatchObject({ ok: false, error: { code: 'capability-gap' } });
  expect(await entry.ownerRepairAndResume(runId)).toMatchObject({ ok: true });
  expect(await entry.createNativeEntities(runId, [{ mutationId: 'root', name: 'Reference Root', components: {} }])).toMatchObject({ ok: true });
  expect(await entry.recordEvidence(runId, { kind: 'stage-advanced', stage: 'blockout', evidenceId: 'native-entities-committed' })).toMatchObject({ ok: true });

  const review = await entry.appendVisualReview(runId, {
    authoredBy: 'verify',
    executor: 'step-verify-visual-executor',
    expectation: 'edit-prop-after-reopen',
    observed: { targetCount: 1 },
    verdict: 'pass',
    confidence: 0.9,
    capture: { runId: 'missing-capture', tapePath: '.forgeax-debug/missing-capture/frame-0.tape.bin', reportPath: '.forgeax-debug/missing-capture/frame-0.report.json' },
    renderer: { backend: 'webgpu', generation: 1, carrierGeneration: 1, rendererIdentity: 'renderer-1' },
  });
  expect(review).toMatchObject({ ok: false, error: { code: 'visual-review-order-invalid' } });
  expect(entry.journal(runId).some((record) => record.kind === 'visual-review-committed')).toBe(false);
});

test('reference correction fails closed when query facts are unavailable and consumes accepted budget on post-query failure', async () => {
  const base = port();
  const noQuery = createReferenceCreationEntry({ gateway: { ...base, query: undefined } });
  expect(await noQuery.start({ ...input, creationRunId: 'correction-no-query' })).toMatchObject({ ok: false, error: { code: 'capability-gap' } });
  expect(await noQuery.ownerRepairAndResume('correction-no-query')).toMatchObject({ ok: true });
  const unavailable = await noQuery.correct('correction-no-query', {
    stage: 'blockout',
    issueGroup: { id: 'query-unavailable', issues: ['query owner is unavailable'] },
    command: { kind: 'addSceneAssetToScene', requestId: 'query-unavailable-correction' },
  });
  expect(unavailable).toMatchObject({
    ok: false,
    error: { code: 'correction-query-unavailable' },
    run: { totalCorrectionCount: 0 },
  });
  expect(base.calls).toEqual(['spawnEntity', 'createAsset', 'createAsset']);

  let queryCount = 0;
  const postQueryFailure = createReferenceCreationEntry({
    gateway: {
      ...port(),
      query: () => {
        queryCount += 1;
        return queryCount === 1
          ? { rows: [{ entity: 11, Name: { value: 'Reference Root' } }] }
          : { ok: false, error: { code: 'query-after-write-failed', hint: 'post-query unavailable' } };
      },
    },
  });
  expect(await postQueryFailure.start({ ...input, creationRunId: 'correction-post-query-failure' })).toMatchObject({ ok: false, error: { code: 'capability-gap' } });
  expect(await postQueryFailure.ownerRepairAndResume('correction-post-query-failure')).toMatchObject({ ok: true });
  const postFailed = await postQueryFailure.correct('correction-post-query-failure', {
    stage: 'blockout',
    issueGroup: { id: 'post-query-failure', issues: ['post-query must be observed'] },
    command: { kind: 'addSceneAssetToScene', requestId: 'post-query-failure-correction' },
  });
  expect(postFailed).toMatchObject({
    ok: false,
    error: { code: 'query-after-write-failed' },
    run: { totalCorrectionCount: 1 },
  });
  const failedRecord = postFailed.run.records.find((record) => record.kind === 'correction-failed');
  expect(failedRecord).toMatchObject({ budgetConsumed: true, operationRunId: 'post-query-failure-correction-run', preQuery: { rowCount: 1 } });
});

test('reference entry uses the published spawnEntity seed when scene activation is absent', async () => {
  const base = port();
  const gateway: GatewayCreationPort & { readonly calls: string[] } = {
    ...base,
    listOps: () => base.listOps().filter((descriptor) => descriptor.id !== 'addSceneAssetToScene'),
  };
  const entry = createReferenceCreationEntry({ gateway });
  const started = await entry.start({ ...input, creationRunId: 'spawn-seed-fallback' });

  expect(started).toMatchObject({
    ok: false,
    error: { code: 'capability-gap' },
    run: { priorOperationRunId: expect.any(String), status: 'blocked' },
  });
  expect(gateway.calls).toEqual(['spawnEntity', 'createAsset']);
});

test('reference entry rejects a missing native EntityHandle but preserves explicit zero', async () => {
  const missingBase = port();
  const missingGateway: GatewayCreationPort & { readonly calls: string[] } = {
    ...missingBase,
    waitOperationRun: async (requestId) => requestId === 'missing-entity:entity:missing'
      ? { ok: true, value: { requestId, runId: 'missing-entity-run', operationId: 'spawnEntity', status: 'succeeded', result: {} } }
      : missingBase.waitOperationRun(requestId),
  };
  const missingEntry = createReferenceCreationEntry({ gateway: missingGateway });
  expect(await missingEntry.start({ ...input, creationRunId: 'missing-entity' })).toMatchObject({ ok: false, error: { code: 'capability-gap' } });
  expect(await missingEntry.ownerRepairAndResume('missing-entity')).toMatchObject({ ok: true });
  expect(await missingEntry.createNativeEntities('missing-entity', [{ mutationId: 'missing', name: 'Missing', components: {} }])).toMatchObject({
    ok: false,
    error: { code: 'native-entity-handle-missing' },
    run: { nativeEntities: [] },
  });

  const zeroBase = port();
  const zeroGateway: GatewayCreationPort & { readonly calls: string[] } = {
    ...zeroBase,
    waitOperationRun: async (requestId) => requestId === 'zero-entity:entity:zero'
      ? { ok: true, value: { requestId, runId: 'zero-entity-run', operationId: 'spawnEntity', status: 'succeeded', result: { created: [0] } } }
      : zeroBase.waitOperationRun(requestId),
  };
  const zeroEntry = createReferenceCreationEntry({ gateway: zeroGateway });
  expect(await zeroEntry.start({ ...input, creationRunId: 'zero-entity' })).toMatchObject({ ok: false, error: { code: 'capability-gap' } });
  expect(await zeroEntry.ownerRepairAndResume('zero-entity')).toMatchObject({ ok: true });
  expect(await zeroEntry.createNativeEntities('zero-entity', [{ mutationId: 'zero', name: 'Zero', components: {} }])).toMatchObject({
    ok: true,
    run: { nativeEntities: [{ mutationId: 'zero', entity: 0 }] },
  });
});

test('reference entry fails closed on explicit false operationRun descriptors', () => {
  for (const operationRun of [false, null, undefined]) {
    const gateway = port();
    const entry = createReferenceCreationEntry({
      gateway: {
        ...gateway,
        listOps: () => [{ id: 'createAsset', available: true, operationRun }],
      },
    });
    expect(entry.skill().capabilities).toEqual([expect.objectContaining({
      id: 'createAsset',
      available: true,
      operationRun: false,
    })]);
  }
});

test('reference entry returns structured recovery and never mutates after journal corruption', async () => {
  const gateway = port();
  let writes = 0;
  const journalStore = {
    read: () => [{ schemaVersion: 'creation-run/v1', sequence: 0, at: 1, creationRunId: input.creationRunId, kind: 'run-created' }],
    write: () => { writes += 1; },
  };
  const entry = createReferenceCreationEntry({ gateway, journalStore });

  expect(entry.preflight(input)).toMatchObject({ ok: false, error: { code: 'creation-journal-corrupt', stage: 'preflight' } });
  expect(await entry.start(input)).toMatchObject({ ok: false, error: { code: 'creation-journal-corrupt' } });
  expect(entry.resume(input.creationRunId)).toMatchObject({ ok: false, error: { code: 'creation-journal-corrupt' } });
  expect(await entry.ownerRepairAndResume(input.creationRunId)).toMatchObject({ ok: false, error: { code: 'creation-journal-corrupt' } });
  expect(await entry.createNativeEntities(input.creationRunId, [{ mutationId: 'duplicate-check', name: 'No Mutation', components: {} }])).toMatchObject({
    ok: false,
    error: { code: 'creation-journal-corrupt' },
  });
  expect(gateway.calls).toEqual([]);
  expect(writes).toBe(0);
});

test('reference entry rejects unknown, incomplete, and cross-record journals before mutation', async () => {
  const baseRun = {
    schemaVersion: 'creation-run/v1',
    sequence: 1,
    at: 1,
    creationRunId: input.creationRunId,
    kind: 'run-created',
    referenceFingerprint: input.referenceFingerprint,
    targetProject: input.targetProject,
    targetScene: input.targetScene,
    originalStage: input.originalStage,
    viewSemantics: input.viewSemantics,
    visibleFacts: input.visibleFacts,
    inferredFacts: input.inferredFacts,
    unknownFacts: input.unknownFacts,
    fidelityFocus: input.fidelityFocus,
    correctionBudget: input.correctionBudget,
  };
  const malformed = [
    [...[baseRun], { ...baseRun, sequence: 2, kind: 'not-a-known-kind' }],
    [{ ...baseRun, referenceFingerprint: undefined }],
    [baseRun, {
      schemaVersion: 'creation-run/v1', sequence: 2, at: 2, creationRunId: input.creationRunId,
      kind: 'q5-gap-blocked', capabilityId: 'scene.createAsset', originalStage: 'detail',
      capabilityGeneration: 'g0', priorOperationRunId: 'unrelated-seed', owner: 'owner',
      diagnosticId: 'diagnostic', nextStep: 'owner.repair', code: 'capability-gap',
      expected: 'terminal OperationRun',
    }],
  ];
  for (const records of malformed) {
    const gateway = port();
    let writes = 0;
    const entry = createReferenceCreationEntry({
      gateway,
      journalStore: { read: () => records, write: () => { writes += 1; } },
    });
    expect(await entry.start(input)).toMatchObject({ ok: false, error: { code: 'creation-journal-corrupt' } });
    expect(entry.resume(input.creationRunId)).toMatchObject({ ok: false, error: { code: 'creation-journal-corrupt' } });
    expect(gateway.calls).toEqual([]);
    expect(writes).toBe(0);
  }
});

test('reference evidence stays fail-closed for running, failed, duplicate, and out-of-order terminal facts', async () => {
  const terminalGateway = port();
  const gateway: GatewayCreationPort & { readonly calls: string[] } = {
    ...terminalGateway,
    waitOperationRun: async (requestId) => requestId === 'running-save' || requestId === 'capture-running'
      ? { ok: true, value: { requestId, runId: 'running-save-run', status: 'running' } }
      : requestId === 'capture-failed'
        ? { ok: true, value: { requestId, runId: 'capture-failed-run', operationId: 'captureFrame', status: 'failed' } }
        : requestId === 'capture-mismatch'
          ? { ok: true, value: { requestId, runId: 'capture-mismatch-run', operationId: 'saveDocToDisk', status: 'succeeded', result: { created: [11] } } }
        : requestId === 'capture-missing'
          ? { ok: true, value: { requestId, runId: 'capture-missing-run', operationId: 'captureFrame', status: 'succeeded', result: {} } }
        : requestId === 'capture-run-mismatch'
          ? { ok: true, value: { requestId: 'other-request', runId: 'capture-run-mismatch-run', operationId: 'captureFrame', status: 'succeeded', result: { runId: 'capture-run-mismatch-run', tapePath: 'capture.tape.bin', reportPath: 'capture.report.json', provenance: captureProvenance } } }
        : requestId === 'capture-artifact-empty'
          ? { ok: true, value: { requestId, runId: 'capture-artifact-empty-run', operationId: 'captureFrame', status: 'succeeded', result: { runId: '', tapePath: 'capture.tape.bin', reportPath: 'capture.report.json', provenance: captureProvenance } } }
        : requestId === 'capture-artifact-path-mismatch'
          ? { ok: true, value: { requestId, runId: 'capture-artifact-path-mismatch-run', operationId: 'captureFrame', status: 'succeeded', result: { runId: 'artifact-path-run', tapePath: '.forgeax-debug/other-run/frame-0.tape.bin', reportPath: '.forgeax-debug/other-run/frame-0.report.json', provenance: captureProvenance } } }
      : terminalGateway.waitOperationRun(requestId),
  };
  const entry = createReferenceCreationEntry({ gateway });
  const runId = 'evidence-contract';
  expect(await entry.start({ ...input, creationRunId: runId })).toMatchObject({ ok: false, error: { code: 'capability-gap' } });
  expect(await entry.ownerRepairAndResume(runId)).toMatchObject({ ok: true });
  expect(await entry.createNativeEntities(runId, [{ mutationId: 'root', name: 'Reference Root', components: {} }])).toMatchObject({ ok: true });
  expect(await entry.recordEvidence(runId, { kind: 'capture-committed', stage: 'edit-after-reopen', evidenceId: 'too-early', requestId: 'capture-too-early' })).toMatchObject({
    ok: false,
    error: { code: 'evidence-order-invalid' },
  });
  expect(await entry.recordEvidence(runId, { kind: 'stage-advanced', stage: 'blockout', evidenceId: 'native-entities-committed' })).toMatchObject({ ok: true });
  expect(await entry.recordEvidence(runId, { kind: 'stage-advanced', stage: 'blockout', evidenceId: 'duplicate-stage' })).toMatchObject({
    ok: false,
    error: { code: 'evidence-duplicate' },
  });
  expect(await entry.recordEvidence(runId, { kind: 'save-committed', requestId: 'running-save', evidenceId: 'running-save' })).toMatchObject({
    ok: false,
    error: { code: 'evidence-not-terminal-success' },
  });
  expect(await entry.recordEvidence(runId, { kind: 'save-committed', requestId: 'fail-save', evidenceId: 'failed-save' })).toMatchObject({
    ok: false,
    error: { code: 'evidence-not-terminal-success' },
  });
  expect(await entry.recordEvidence(runId, { kind: 'save-committed', requestId: 'save-test', evidenceId: 'save' })).toMatchObject({ ok: true });
  for (const [requestId, code] of [['capture-running', 'evidence-not-terminal-success'], ['capture-failed', 'evidence-not-terminal-success'], ['capture-mismatch', 'evidence-capture-operation-mismatch'], ['capture-missing', 'evidence-capture-artifact-missing'], ['capture-artifact-empty', 'evidence-capture-artifact-missing'], ['capture-artifact-path-mismatch', 'evidence-capture-artifact-missing'], ['capture-run-mismatch', 'evidence-capture-run-mismatch']] as const) {
    expect(await entry.recordEvidence(runId, { kind: 'capture-committed', stage: 'edit-after-reopen', evidenceId: requestId, requestId })).toMatchObject({
      ok: false,
      error: { code },
    });
  }
  expect(entry.journal(runId).some((record) => record.kind === 'capture-committed')).toBe(false);
  expect(entry.finalize(runId, {
    input: 'pass', structure: 'pass', persistence: 'pass', play: 'pass', visual: 'pass', toolCompleteness: 'pass',
  })).toMatchObject({ ok: false, error: { code: 'final-report-evidence-incomplete' } });
  expect(await entry.recordEvidence(runId, { kind: 'capture-committed', stage: 'play-roundtrip', evidenceId: 'out-of-order-play', requestId: 'capture-out-of-order' })).toMatchObject({
    ok: false,
    error: { code: 'evidence-order-invalid' },
  });
  expect(await entry.recordEvidence(runId, { kind: 'capture-committed', stage: 'edit-after-reopen', evidenceId: 'edit', requestId: 'capture-edit' })).toMatchObject({ ok: true });
  expect(await entry.recordEvidence(runId, { kind: 'capture-committed', stage: 'edit-after-reopen', evidenceId: 'duplicate-edit', requestId: 'capture-duplicate' })).toMatchObject({
    ok: false,
    error: { code: 'evidence-duplicate' },
  });
});

test('reference evidence resolves non-terminal gets once and consumes terminal gets directly', async () => {
  const base = port();
  const waitRequests: string[] = [];
  const gateway: GatewayCreationPort & { readonly calls: string[] } = {
    ...base,
    getOperationRunResult: (requestId) => {
      if (requestId === 'running-get') return { ok: true, value: { requestId, runId: 'running-snapshot', status: 'running' } };
      if (requestId === 'failed-terminal-get') return { ok: true, value: { requestId, runId: 'failed-terminal-run', operationId: 'captureFrame', status: 'failed' } };
      if (requestId === 'terminal-get') return { ok: true, value: { requestId, runId: 'terminal-run', operationId: 'captureFrame', status: 'succeeded', result: { runId: 'terminal-artifact-run', tapePath: '.forgeax-debug/terminal-artifact-run/frame-0.tape.bin', reportPath: '.forgeax-debug/terminal-artifact-run/frame-0.report.json', provenance: captureProvenance } } };
      return { ok: true, value: { requestId, runId: `${requestId}-run`, status: 'succeeded' } };
    },
    waitOperationRun: async (requestId) => {
      waitRequests.push(requestId);
      if (requestId === 'running-get') return { ok: true, value: { requestId, runId: 'save-run', operationId: 'saveDocToDisk', status: 'succeeded', result: { created: [11] } } };
      return base.waitOperationRun(requestId);
    },
  };
  const entry = createReferenceCreationEntry({ gateway });
  const runId = 'evidence-get-resolution';
  expect(await entry.start({ ...input, creationRunId: runId })).toMatchObject({ ok: false, error: { code: 'capability-gap' } });
  expect(await entry.ownerRepairAndResume(runId)).toMatchObject({ ok: true });
  expect(await entry.createNativeEntities(runId, [{ mutationId: 'root', name: 'Reference Root', components: {} }])).toMatchObject({ ok: true });
  expect(await entry.recordEvidence(runId, { kind: 'stage-advanced', stage: 'blockout', evidenceId: 'native-entities-committed' })).toMatchObject({ ok: true });

  expect(await entry.recordEvidence(runId, { kind: 'save-committed', requestId: 'running-get', evidenceId: 'save' })).toMatchObject({ ok: true });
  expect(waitRequests.filter((requestId) => requestId === 'running-get')).toEqual(['running-get']);
  expect(await entry.recordEvidence(runId, { kind: 'capture-committed', stage: 'edit-after-reopen', evidenceId: 'failed-capture', requestId: 'failed-terminal-get' })).toMatchObject({
    ok: false,
    error: { code: 'evidence-not-terminal-success' },
  });
  expect(waitRequests.filter((requestId) => requestId === 'failed-terminal-get')).toEqual([]);
  const terminalCapture = await entry.recordEvidence(runId, { kind: 'capture-committed', stage: 'edit-after-reopen', evidenceId: 'terminal-capture', requestId: 'terminal-get' });
  expect(terminalCapture).toMatchObject({ ok: true });
  expect(terminalCapture.ok && terminalCapture.run.records.at(-1)).toMatchObject({
    operationRunId: 'terminal-run',
    provenance: { artifactRunId: 'terminal-artifact-run' },
  });
  expect(waitRequests.filter((requestId) => requestId === 'terminal-get')).toEqual([]);
});
