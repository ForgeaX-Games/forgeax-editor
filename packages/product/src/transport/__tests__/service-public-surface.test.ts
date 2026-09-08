import { expect, test } from 'bun:test';

import {
  CapabilityRegistry,
  createAssetWorkspace,
  createEditorProduct,
  createTransportSecurityPolicy,
  createTransportService,
  TRANSPORT_PROTOCOL_VERSION,
  type TransportRequest,
} from '@forgeax/editor-product';
import {
  RENDERER_OWNER_ADMISSION_OPERATION,
  RENDERER_OWNER_ADMISSION_SCHEMA,
} from '../../contracts/renderer-owner-admission';
import { createReferenceCreationEntry, type GatewayCreationPort } from '../..';

function request(id: string, method: string, params: unknown): TransportRequest {
  return { jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id, correlationId: `public-${id}`, scope: 'default', method, params };
}

const auth = { scope: 'default', actor: { id: 'public-test', kind: 'ai' }, sessionId: 'public-session', permission: 'execute' as const };

const rendererIdentity = {
  carrierId: 'public-carrier-1',
  pageIdentity: 'page-1',
  browserRealmId: 'realm-1',
  runtimeId: 'runtime-1',
  canvasIdentity: 'canvas-1',
  rendererGeneration: 'renderer-generation-1',
} as const;

const rendererOwnerInput = {
  schema: RENDERER_OWNER_ADMISSION_SCHEMA,
  shadowSubmitMode: 'coalesced-with-frame' as const,
  identity: rendererIdentity,
};

test('discover publishes the product capability manifest without parallel runtime methods', async () => {
  const registry = new CapabilityRegistry();
  registry.register({
    id: 'asset.rename', kind: 'operation', version: '1', subject: 'asset', verb: 'rename',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, availability: { available: true },
    preconditions: [], recoveryActions: [], executor: { execute: (input) => input },
  });
  const service = createTransportService({ product: createEditorProduct({ availability: { available: true, blocking: false, code: 'product-available' }, capabilityRegistry: registry }) });
  const response = await service.handle(request('discover', 'discover', {}));
  expect(response.result).toMatchObject({
    manifest: { productId: '@forgeax/editor-product', capabilitySource: 'registered-ssot' },
    capabilityManifest: { generatedFrom: 'capability-registry', capabilities: [{ id: 'asset.rename' }] },
    availability: { available: true, code: 'product-available' },
    methods: expect.not.arrayContaining(['runtime.play', 'runtime.stop']),
  });
});

test('discover publishes renderer owner admission as one typed public capability', async () => {
  const service = createTransportService({ product: createEditorProduct() });
  const response = await service.handle(request('renderer-discover', 'discover', {}));
  const manifest = response.result && typeof response.result === 'object'
    ? (response.result as { readonly capabilityManifest?: { readonly capabilities?: readonly Record<string, unknown>[] } }).capabilityManifest
    : undefined;
  const descriptor = manifest?.capabilities?.find((capability) => capability.id === RENDERER_OWNER_ADMISSION_OPERATION);

  expect(response).toMatchObject({
    id: 'renderer-discover',
    correlationId: 'public-renderer-discover',
    result: {
      protocolVersion: TRANSPORT_PROTOCOL_VERSION,
      methods: expect.arrayContaining(['discover', 'run.dispatch']),
    },
  });
  expect(descriptor).toMatchObject({
    id: RENDERER_OWNER_ADMISSION_OPERATION,
    kind: 'run',
    version: '1',
    subject: 'renderer',
    verb: 'ownerAdmission',
    inputSchema: {
      type: 'object',
      required: expect.arrayContaining(['schema', 'shadowSubmitMode', 'identity']),
    },
    outputSchema: {
      type: 'object',
      required: expect.arrayContaining(['status', 'operation', 'identity', 'appliedCount', 'restoredCount']),
    },
    availability: {
      available: false,
      code: 'capability-blocked',
    },
    permission: { action: 'execute' },
    recoveryActions: ['renderer.ownerAdmission.rediscover'],
  });
  expect(descriptor?.preconditions).toEqual(expect.arrayContaining([
    expect.stringMatching(/identity/i),
    expect.stringMatching(/generation/i),
  ]));
  expect(JSON.stringify(descriptor)).not.toContain('rawScope');
  expect(JSON.stringify(descriptor)).not.toContain(':15173');
});

test('typed owner dispatch preserves unavailable recovery and operation correlation identity', async () => {
  const service = createTransportService({ product: createEditorProduct() });
  const response = await service.handle(request('renderer-dispatch', 'run.dispatch', {
    operationId: RENDERER_OWNER_ADMISSION_OPERATION,
    input: rendererOwnerInput,
    ...auth,
  }));

  expect(response).toMatchObject({
    id: 'renderer-dispatch',
    correlationId: 'public-renderer-dispatch',
    runId: 'transport-renderer-dispatch',
    error: {
      code: 'capability-blocked',
      recoveryActions: ['renderer.ownerAdmission.rediscover'],
    },
  });
  expect(response.result).toBeUndefined();
  expect(service.getRun(response.runId!)).toMatchObject({
    ok: true,
    value: {
      runId: response.runId,
      operationId: RENDERER_OWNER_ADMISSION_OPERATION,
      scope: auth.scope,
      actor: auth.actor,
      sessionId: auth.sessionId,
      status: 'failed',
      error: {
        code: 'capability-blocked',
        recoveryActions: ['renderer.ownerAdmission.rediscover'],
      },
    },
  });
});

test('undocumented owner aliases stay unsupported instead of bypassing typed dispatch', async () => {
  const service = createTransportService({ product: createEditorProduct() });
  const response = await service.handle(request('renderer-alias', 'run.dispatch', {
    operationId: 'renderer.owner-admission',
    input: rendererOwnerInput,
    ...auth,
  }));

  expect(response).toMatchObject({
    id: 'renderer-alias',
    correlationId: 'public-renderer-alias',
    error: { code: 'not-supported' },
  });
  expect(response.result).toBeUndefined();
});

test('reference-creation is exposed through the canonical typed transport and preflight is zero-write', async () => {
  const calls: string[] = [];
  const gateway: GatewayCreationPort = {
    listOps: () => [
      { id: 'addSceneAssetToScene', available: true, operationRun: true },
      { id: 'spawnEntity', available: true, operationRun: true },
      { id: 'createAsset', available: false, operationRun: false, capabilityGeneration: 'g0' },
    ],
    assetCatalog: () => [],
    dispatch: (command) => { calls.push(command.kind); return { ok: false, error: { code: 'blocked', hint: 'not called' } }; },
    waitOperationRun: async (requestId) => ({ ok: true, value: { requestId, runId: requestId, status: 'succeeded' } }),
  };
  const entry = createReferenceCreationEntry({ gateway });
  const service = createTransportService({ referenceCreation: entry });
  const discovered = await service.handle(request('reference-discover', 'discover', {}));
  expect(discovered.result).toMatchObject({ methods: expect.arrayContaining(['reference-creation']) });

  const route = await service.handle(request('reference-route', 'reference-creation', { action: 'discover' }));
  expect(route.result).toMatchObject({ id: 'forgeax-reference-creation', publicRoute: 'reference-creation', zeroWritePreflight: { mutates: false } });

  const preflight = await service.handle(request('reference-preflight', 'reference-creation', {
    action: 'preflight',
    input: {
      creationRunId: 'transport-preflight', referenceFingerprint: 'sha256:transport', targetProject: 'games/reference', targetScene: 'default',
      originalStage: 'blockout', viewSemantics: 'front view', visibleFacts: ['silhouette'], inferredFacts: ['inferred'], unknownFacts: ['back'], fidelityFocus: ['shape'], correctionBudget: { perStage: 1, total: 1 },
    },
  }));
  expect(preflight.result).toMatchObject({ id: 'forgeax-reference-creation', zeroWritePreflight: { mutates: false } });
  expect(calls).toEqual([]);

  const readback = await service.handle(request('reference-journal', 'reference-creation', {
    action: 'journal', creationRunId: 'transport-preflight',
  }));
  expect(readback.result).toEqual({ creationRunId: 'transport-preflight', records: [] });

  const malformed = await service.handle(request('reference-malformed', 'reference-creation', { action: 'start' }));
  expect(malformed).toMatchObject({ error: { code: 'invalid-reference-creation-input' } });

  for (const correction of [
    null,
    1,
    {},
    { stage: 'blockout', issueGroup: null, command: { kind: 'spawnEntity' } },
    { stage: 'blockout', issueGroup: { id: 'issue', issues: null }, command: { kind: 'spawnEntity' } },
    { stage: 'blockout', issueGroup: { id: 'issue', issues: ['broken command'] }, command: null },
    { stage: 'blockout', issueGroup: { id: 'issue', issues: ['broken command'] }, command: {} },
    { stage: 'blockout', issueGroup: { id: 'issue', issues: ['empty command kind'] }, command: { kind: '' } },
  ]) {
    const response = await service.handle(request('reference-correction-malformed', 'reference-creation', {
      action: 'correct', creationRunId: 'transport-preflight', correction,
    }));
    expect(response).toMatchObject({ error: { code: 'invalid-reference-creation-input' } });
    expect(calls).toEqual([]);
  }

  const validInput = {
    creationRunId: 'transport-malformed-shapes', referenceFingerprint: 'sha256:transport', targetProject: 'games/reference', targetScene: 'default',
    originalStage: 'blockout', viewSemantics: 'front view', visibleFacts: ['silhouette'], inferredFacts: ['inferred'], unknownFacts: ['back'], fidelityFocus: ['shape'], correctionBudget: { perStage: 1, total: 1 },
  };
  for (const malformedInput of [
    null,
    {},
    'input',
    [],
    { ...validInput, visibleFacts: [] },
    { ...validInput, inferredFacts: [] },
    { ...validInput, unknownFacts: [] },
    { ...validInput, visibleFacts: [], inferredFacts: [] },
    { ...validInput, inferredFacts: [], unknownFacts: [] },
    { ...validInput, visibleFacts: [], unknownFacts: [] },
    { ...validInput, visibleFacts: [], inferredFacts: [], unknownFacts: [] },
    { ...validInput, fidelityFocus: [] },
    { ...validInput, visibleFacts: null },
    { ...validInput, visibleFacts: ['  '] },
    { ...validInput, inferredFacts: [''] },
    { ...validInput, unknownFacts: ['\t'] },
    { ...validInput, fidelityFocus: ['\n'] },
    { ...validInput, visibleFacts: ['silhouette', null] },
    { ...validInput, correctionBudget: { perStage: 0, total: 1 } },
    { ...validInput, correctionBudget: { perStage: -1, total: 1 } },
    { ...validInput, correctionBudget: { perStage: 1.5, total: 1 } },
    { ...validInput, correctionBudget: { perStage: Number.NaN, total: 1 } },
    { ...validInput, correctionBudget: { perStage: 1, total: Number.POSITIVE_INFINITY } },
    { ...validInput, correctionBudget: { perStage: '1', total: 1 } },
    { ...validInput, correctionBudget: { perStage: 4, total: 1 } },
    { ...validInput, correctionBudget: { perStage: 1, total: 13 } },
  ]) {
    const response = await service.handle(request('reference-input-malformed', 'reference-creation', { action: 'preflight', input: malformedInput }));
    expect(response).toMatchObject({ error: { code: 'invalid-reference-creation-input' } });
    expect(calls).toEqual([]);
  }

  const validSpec = { mutationId: 'entity-1', name: 'Entity', parent: 0, components: {} };
  for (const malformedSpecs of [
    null,
    {},
    'specs',
    [null],
    [{}],
    [{ ...validSpec, components: null }],
    [{ ...validSpec, components: { Transform: null } }],
    [{ ...validSpec, components: { Transform: [] } }],
    [{ ...validSpec, components: { Transform: 1 } }],
    [{ ...validSpec, components: { '': {} } }],
    [validSpec, { mutationId: 'entity-2', name: 2, components: {} }],
  ]) {
    const response = await service.handle(request('reference-specs-malformed', 'reference-creation', {
      action: 'createNativeEntities', creationRunId: validInput.creationRunId, specs: malformedSpecs,
    }));
    expect(response).toMatchObject({ error: { code: 'invalid-reference-creation-input' } });
    expect(calls).toEqual([]);
  }
  const arbitraryPayload = await service.handle(request('reference-specs-arbitrary', 'reference-creation', {
    action: 'createNativeEntities', creationRunId: validInput.creationRunId,
    specs: [{ mutationId: 'entity-arbitrary', name: 'Entity', components: { Custom: { nested: [1, 'two'], enabled: true } } }],
  }));
  expect(arbitraryPayload).not.toMatchObject({ error: { code: 'invalid-reference-creation-input' } });

  for (const malformedEvent of [
    null,
    {},
    1,
    { kind: 'save-committed', requestId: '  ' },
    { kind: 'save-committed', requestId: null },
    { kind: 'capture-committed', stage: ' ', evidenceId: 'capture-1', requestId: 'capture-1' },
    { kind: 'capture-committed', stage: 'edit-after-reopen', evidenceId: null, requestId: 'capture-1' },
    { kind: 'stage-advanced', stage: 1, evidenceId: 'native-entities-committed' },
    { kind: 'stage-advanced', stage: 'blockout', evidenceId: ' ' },
  ]) {
    const response = await service.handle(request('reference-event-malformed', 'reference-creation', {
      action: 'recordEvidence', creationRunId: validInput.creationRunId, event: malformedEvent,
    }));
    expect(response).toMatchObject({ error: { code: 'invalid-reference-creation-input' } });
    expect(calls).toEqual([]);
  }

  for (const malformedFacts of [
    null,
    {},
    'facts',
    { authoredBy: 'verify', executor: 'step-verify-visual-executor' },
    { authoredBy: 'verify', executor: 'step-verify-visual-executor', expectation: 'edit-prop-after-reopen', observed: null },
    { authoredBy: 'verify', executor: 'step-verify-visual-executor', expectation: 'edit-prop-after-reopen', observed: {}, verdict: 'pass', confidence: '1', capture: {}, renderer: {} },
    { authoredBy: 'verify', executor: 'step-verify-visual-executor', expectation: 'edit-prop-after-reopen', observed: [], verdict: 'pass', confidence: 1, capture: { runId: 'run', tapePath: 'tape', reportPath: 'report' }, renderer: { backend: 'webgpu', generation: 1, carrierGeneration: 1, rendererIdentity: 'renderer', carrierId: ' ', carrierKind: 'iframe', runtimeId: 'runtime', runtimeGeneration: 1 } },
    { authoredBy: 'verify', executor: 'step-verify-visual-executor', expectation: 'edit-prop-after-reopen', observed: {}, verdict: 'pass', confidence: Number.NaN, capture: { runId: 'run', tapePath: 'tape', reportPath: 'report' }, renderer: { backend: 'webgpu', generation: 1, carrierGeneration: 1, rendererIdentity: 'renderer' } },
  ]) {
    const response = await service.handle(request('reference-facts-malformed', 'reference-creation', {
      action: 'appendVisualReview', creationRunId: validInput.creationRunId, facts: malformedFacts,
    }));
    expect(response).toMatchObject({ error: { code: 'invalid-reference-creation-input' } });
    expect(calls).toEqual([]);
  }

  for (const malformedDimensions of [
    null,
    {},
    'dimensions',
    { input: 'pass' },
    { input: 'pass', structure: 'pass', persistence: 'pass', play: 'pass', visual: 'pending', toolCompleteness: 'pass' },
    { input: 'pass', structure: 'pass', persistence: 'pass', play: 'pass', visual: 'pass', toolCompleteness: ' ' },
    { input: 'pass', structure: 'pass', persistence: 'pass', play: 'pass', visual: 'pass', toolCompleteness: 'pass', uncompletedItems: [null] },
  ]) {
    const response = await service.handle(request('reference-dimensions-malformed', 'reference-creation', {
      action: 'finalize', creationRunId: validInput.creationRunId, dimensions: malformedDimensions,
    }));
    expect(response).toMatchObject({ error: { code: 'invalid-reference-creation-input' } });
    expect(calls).toEqual([]);
  }

  for (const command of [
    { kind: 'spawnEntity' },
    { kind: 'spawnEntity', requestId: null },
    { kind: 'spawnEntity', requestId: '' },
    { kind: 'spawnEntity', requestId: '  ' },
    { kind: 'spawnEntity', requestId: 1 },
  ]) {
    const response = await service.handle(request('reference-command-malformed', 'reference-creation', {
      action: 'correct', creationRunId: validInput.creationRunId,
      correction: { stage: 'blockout', issueGroup: { id: 'issue', issues: ['invalid command request id'] }, command },
    }));
    expect(response).toMatchObject({ error: { code: 'invalid-reference-creation-input' } });
    expect(calls).toEqual([]);
  }
});

test('reference-creation transport publishes one public vocabulary with typed terminal descriptors', async () => {
  const gateway: GatewayCreationPort = {
    listOps: () => [],
    assetCatalog: () => [],
    dispatch: () => ({ ok: false, error: { code: 'blocked', hint: 'not called' } }),
    waitOperationRun: async (requestId) => ({ ok: true, value: { requestId, runId: requestId, status: 'succeeded' } }),
  };
  const service = createTransportService({ referenceCreation: createReferenceCreationEntry({ gateway }) });
  const response = await service.handle(request('reference-contract', 'reference-creation', { action: 'discover' }));
  const skill = (response.result as { readonly skill: { readonly actions: readonly { readonly action: string; readonly method: string; readonly terminal: boolean; readonly parameters: { readonly required: readonly string[] }; readonly terminalResult: unknown }[]; readonly shortestRoute: readonly string[]; readonly terminalResult: unknown; readonly lifecycle: unknown } }).skill;

  expect(skill.actions.map((action) => action.action)).toEqual([...skill.shortestRoute]);
  expect(skill.actions.every((action) => action.method === 'reference-creation' && action.terminal)).toBe(true);
  expect(skill.actions.every((action) => action.terminalResult === skill.terminalResult)).toBe(true);
  expect(skill.actions.find((action) => action.action === 'start')?.parameters.required).toEqual(['action', 'input']);
  expect(skill.actions.find((action) => action.action === 'createNativeEntities')?.parameters.required).toEqual(['action', 'creationRunId', 'specs']);
  expect(skill.actions.find((action) => action.action === 'appendVisualReview')?.parameters.required).toEqual(['action', 'creationRunId', 'facts']);
  expect(skill.lifecycle).toEqual({
    save: { action: 'recordEvidence', eventKind: 'save-committed', stage: 'save' },
    reopen: { action: 'recordEvidence', eventKind: 'stage-advanced', stage: 'edit-after-reopen' },
    play: { action: 'recordEvidence', eventKind: 'stage-advanced', stage: 'play-roundtrip' },
    capture: { action: 'recordEvidence', eventKind: 'capture-committed', stages: ['edit-after-reopen', 'play-roundtrip'] },
  });

  const discovered = await service.handle(request('reference-contract-discover', 'discover', {}));
  expect(discovered.result).toMatchObject({ methods: ['discover', 'transport.describe', 'query', 'asset.snapshot', 'asset.observe', 'asset.reconcile', 'asset.preflight', 'asset.mutate', 'asset.restore', 'run.dispatch', 'run.get', 'run.wait', 'run.list', 'run.listEvents', 'run.retry', 'run.cancel', 'run.reconcile', 'workflow.start', 'workflow.get', 'workflow.recover', 'workflow.retry', 'workflow.listRecipes', 'save', 'reopen', 'reference-creation'] });
  expect((discovered.result as { readonly methods: readonly string[] }).methods
    .filter((method) => method !== 'discover' && method !== 'reference-creation')
    .some((method) => skill.actions.some((action) => action.action === method))).toBe(false);
});

test('reference-creation journal corruption is structured and distinct from a valid empty journal', async () => {
  const calls: string[] = [];
  const gateway: GatewayCreationPort = {
    listOps: () => [],
    assetCatalog: () => [],
    dispatch: (command) => { calls.push(command.kind); return { ok: false, error: { code: 'unexpected', hint: 'must not dispatch' } }; },
    waitOperationRun: async (requestId) => ({ ok: true, value: { requestId, runId: requestId, status: 'succeeded' } }),
  };
  for (const persisted of [null, 1, 'journal', {}, [{}]]) {
    let writes = 0;
    const entry = createReferenceCreationEntry({
      gateway,
      journalStore: { read: () => persisted, write: () => { writes++; } },
    });
    const service = createTransportService({ referenceCreation: entry });
    const response = await service.handle(request(`journal-corrupt-${String(persisted)}`, 'reference-creation', {
      action: 'journal', creationRunId: 'corrupt-journal',
    }));
    expect(response).toMatchObject({ error: { code: 'creation-journal-corrupt' } });
    expect(calls).toEqual([]);
    expect(writes).toBe(0);
  }

  const emptyEntry = createReferenceCreationEntry({
    gateway,
    journalStore: { read: () => [], write: () => { throw new Error('empty journal must not write'); } },
  });
  const emptyService = createTransportService({ referenceCreation: emptyEntry });
  await expect(emptyService.handle(request('journal-empty', 'reference-creation', {
    action: 'journal', creationRunId: 'empty-journal',
  }))).resolves.toMatchObject({ result: { creationRunId: 'empty-journal', records: [] } });
});

test('asset snapshot and preflight are callable through the typed service', async () => {
  const workspace = createAssetWorkspace();
  workspace.reconcile({
    resourceRevision: 'resource:r1',
    subjects: [{ id: 'asset:one', kind: 'internal-asset', provenance: { owner: 'editor', source: 'fixture' }, resourceId: 'resource:one', path: 'one.asset', capabilities: { canImport: false, canMove: true, canDelete: true, canPreflight: true } }],
    relations: [], issues: [],
  });
  const service = createTransportService({ assetWorkspace: workspace });
  const snapshot = await service.handle(request('snapshot', 'asset.snapshot', { limit: 1 }));
  expect(snapshot.result).toMatchObject({ revision: 'workspace:r1', subjects: [{ id: 'asset:one' }] });
  const preflight = await service.handle(request('preflight', 'asset.preflight', { request: { operation: 'delete', subjectId: 'asset:one' } }));
  expect(preflight.result).toMatchObject({ ok: true, subjectRef: 'asset:one', confirmation: { required: true } });
});

test('gameplay is advertised and delegated only when the live carrier supplies it', async () => {
  const calls: unknown[] = [];
  const service = createTransportService({ gameplay: (input) => { calls.push(input); return { ok: true, operation: 'query' }; } });
  const discovered = await service.handle(request('discover-gameplay', 'discover', {}));
  expect(discovered.result).toMatchObject({ methods: expect.arrayContaining(['gameplay']) });
  const response = await service.handle(request('gameplay-query', 'gameplay', { version: 1, operation: 'query', query: '2048.snapshot' }));
  expect(response.result).toEqual({ ok: true, operation: 'query' });
  expect(calls).toEqual([{ version: 1, operation: 'query', query: '2048.snapshot' }]);

  const unavailable = await createTransportService().handle(request('gameplay-unavailable', 'gameplay', {}));
  expect(unavailable).toMatchObject({ error: { code: 'not-supported' } });
});

test('asset.importSource delegates the typed source bytes without creating a second importer', async () => {
  const calls: unknown[] = [];
  const service = createTransportService({
    assetImportSource: async (input, request) => {
      calls.push({ input, actor: request.actor, sessionId: request.sessionId });
      return { ok: true, requestId: (input as { requestId: string }).requestId, operationRun: { status: 'succeeded' } };
    },
    security: createTransportSecurityPolicy({
      version: TRANSPORT_PROTOCOL_VERSION,
      scopes: ['default'],
      permissions: { 'asset.importSource': 'execute' },
    }),
  });
  const discovered = await service.handle(request('discover-import', 'discover', {}));
  expect(discovered.result).toMatchObject({ methods: expect.arrayContaining(['asset.importSource']) });
  const response = await service.handle(request('import-source', 'asset.importSource', {
    input: { destPath: 'assets/3d/robot.glb', sourceName: 'robot.glb', base64: 'Z2xURg==', requestId: 'import-1' },
    ...auth,
  }));
  expect(response).toMatchObject({ result: { ok: true, requestId: 'import-1' } });
  expect(calls).toEqual([{
    input: { destPath: 'assets/3d/robot.glb', sourceName: 'robot.glb', base64: 'Z2xURg==', requestId: 'import-1' },
    actor: auth.actor,
    sessionId: auth.sessionId,
  }]);
});

test('Gateway scripts are advertised and executed as typed operation-scope runs', async () => {
  const calls: string[] = [];
  const service = createTransportService({
    evaluate: async (code) => {
      calls.push(code);
      return { ok: true, value: 42 };
    },
    security: createTransportSecurityPolicy({
      version: TRANSPORT_PROTOCOL_VERSION,
      scopes: ['default'],
      permissions: { 'script.execute': 'execute' },
    }),
  });
  const discovered = await service.handle(request('discover-script', 'discover', {}));
  expect(discovered.result).toMatchObject({ methods: expect.arrayContaining(['script.execute']) });

  const rejected = await service.handle(request('script-no-permission', 'script.execute', {
    code: 'gateway.listOps().length', ...auth, permission: 'read',
  }));
  expect(rejected).toMatchObject({ error: { code: 'permission-denied' } });

  const executed = await service.handle(request('script', 'script.execute', {
    code: 'gateway.listOps().length', ...auth, idempotencyKey: 'script-once',
  }));
  expect(executed).toMatchObject({
    runId: 'transport-script',
    result: { status: 'succeeded', result: { ok: true, value: 42 } },
  });
  expect(calls).toEqual(['gateway.listOps().length']);

  const unavailable = await createTransportService().handle(request('script-unavailable', 'script.execute', {
    code: '42', ...auth,
  }));
  expect(unavailable).toMatchObject({ error: { code: 'not-supported' } });
});

test('dispatches play only through the registered product operation', async () => {
  const registry = new CapabilityRegistry();
  registry.register({
    id: 'editor.play', kind: 'operation', version: '1', subject: 'editor', verb: 'play',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, availability: { available: true },
    preconditions: [], recoveryActions: [], executor: { execute: () => ({ worldId: 'play-1' }) },
  });
  const service = createTransportService({
    product: createEditorProduct({ capabilityRegistry: registry }),
  });
  const response = await service.handle(request('play', 'run.dispatch', {
    operationId: 'editor.play', input: {}, ...auth,
  }));
  expect(response).toMatchObject({ result: { status: 'succeeded' } });
  expect(service.getRun(response.runId!)).toMatchObject({
    ok: true,
    value: { status: 'succeeded', result: { worldId: 'play-1' } },
  });
  const alias = await service.handle(request('runtime-alias', 'runtime.play', auth));
  expect(alias).toMatchObject({ error: { code: 'not-supported' } });
});

test('async dispatch returns a running run before the executor resolves', async () => {
  let finish: ((value: unknown) => void) | undefined;
  const service = createTransportService({
    security: createTransportSecurityPolicy({ version: TRANSPORT_PROTOCOL_VERSION, scopes: ['default'], permissions: {} }),
    dispatch: () => new Promise((resolve) => { finish = resolve; }),
  });
  const accepted = await service.handle(request('async', 'run.dispatch', { operationId: 'asset.rename', input: { id: 'asset:one' }, ...auth, async: true }));
  expect(accepted).toMatchObject({ runId: 'transport-async', result: { status: 'running' } });
  finish?.({ renamed: true });
  await Promise.resolve();
  await Promise.resolve();
  const completed = await service.handle(request('async-get', 'run.get', { runId: accepted.runId }));
  expect(completed.result).toMatchObject({ status: 'succeeded', result: { renamed: true } });
});

test('run.dispatch applies the transport idempotency key', async () => {
  let calls = 0;
  const service = createTransportService({ dispatch: () => ({ call: ++calls }) });
  const params = { operationId: 'asset.rename', input: { id: 'asset:one' }, ...auth, idempotencyKey: 'rename-once' };
  const first = await service.handle(request('idempotent-1', 'run.dispatch', params));
  const second = await service.handle(request('idempotent-2', 'run.dispatch', params));
  expect(second.runId).toBe(first.runId);
  expect(calls).toBe(1);
});

test('run list, event cursor, cancel, and retry are public operations', async () => {
  let calls = 0;
  const service = createTransportService({
    security: createTransportSecurityPolicy({ version: TRANSPORT_PROTOCOL_VERSION, scopes: ['default'], permissions: {} }),
    dispatch: async () => { calls++; if (calls === 1) throw new Error('temporary'); return { ok: true, attempt: calls }; },
  });
  const failed = await service.handle(request('failed', 'run.dispatch', { operationId: 'asset.rename', input: {}, ...auth }));
  const retried = await service.handle(request('retry', 'run.retry', { runId: failed.runId, retryRunId: 'retry-1', ...auth }));
  expect(retried).toMatchObject({ runId: 'retry-1', result: { status: 'succeeded' } });
  const listed = await service.handle(request('list', 'run.list', { limit: 1 }));
  expect(listed.result).toMatchObject({ ok: true, items: [{ runId: 'transport-failed' }] });
  const firstPage = await service.handle(request('events-1', 'run.listEvents', { runId: failed.runId, limit: 1 }));
  expect(firstPage.result).toMatchObject({ events: [{ type: 'accepted' }] });
  expect((firstPage.result as { nextCursor?: string }).nextCursor).toBeTruthy();

  let resolve: (() => void) | undefined;
  const cancellable = createTransportService({ dispatch: () => new Promise((finish) => { resolve = () => finish({ done: true }); }) });
  const pending = await cancellable.handle(request('cancel-me', 'run.dispatch', { operationId: 'slow', input: {}, ...auth, async: true }));
  const cancelled = await cancellable.handle(request('cancel', 'run.cancel', { runId: pending.runId }));
  expect(cancelled.result).toMatchObject({ status: 'cancelled' });
  resolve?.();
});
