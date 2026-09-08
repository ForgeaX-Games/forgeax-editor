import { expect, test } from 'bun:test';
import { createReferenceCreationRuntime, type GatewayCreationPort } from '@forgeax/editor-product';

import { EditGateway } from '../io/gateway';
import { registerApplier, type SessionApplier } from '../io/appliers';
import { OperationRunRegistry } from '../io/operation-runs';
import { createEditSession } from '../session/document';
import '../index';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

test('save dispatch is request-correlated and terminal-only', async () => {
  const completions: Array<Deferred<unknown>> = [];
  const fakeApplier: SessionApplier = () => {
    const effect = deferred<unknown>();
    completions.push(effect);
    return { ok: true, completion: effect.promise };
  };
  const restoreApplier = registerApplier('session', 'saveDocToDisk', fakeApplier);

  try {
    const gateway = new EditGateway(createEditSession());
    const accepted = gateway.dispatch({ kind: 'saveDocToDisk', requestId: 'save-1' }, 'ai');
    expect(accepted).toMatchObject({
      ok: true,
      result: { operationRun: { requestId: 'save-1', status: 'running' } },
    });
    expect(completions).toHaveLength(1);
    expect(gateway.getOperationRunResult('save-1')).toMatchObject({ ok: true, value: { status: 'running' } });
    expect(gateway.getOperationRunResult('save-1')).not.toMatchObject({ ok: true, value: { status: 'succeeded' } });
    expect(gateway.ledger).toHaveLength(0);

    const observed: string[] = [];
    const unsubscribe = gateway.subscribeOperationRun('save-1', (run) => observed.push(run.status));
    const terminalPromise = gateway.waitOperationRun('save-1');

    const duplicate = gateway.dispatch({ kind: 'saveDocToDisk', requestId: 'save-1' }, 'ai');
    expect(duplicate).toMatchObject({ ok: true, result: { operationRun: { status: 'running' } } });
    expect(typeof (duplicate.ok ? duplicate.result?.operationRun?.runId : undefined)).toBe('string');
    expect(completions).toHaveLength(1);

    const overlap = gateway.dispatch({ kind: 'saveDocToDisk', requestId: 'save-2' }, 'ai');
    expect(overlap).toMatchObject({ ok: false, error: { code: 'save-already-running', current: { requestId: 'save-1' } } });
    expect(gateway.getOperationRunResult('save-2')).toMatchObject({ ok: false, error: { code: 'run-not-found' } });

    expect(gateway.cancelOperationRun('save-1')).toMatchObject({ ok: false, error: { code: 'run-not-cancellable' } });
    completions[0]!.resolve({ ok: true, revision: 1 });
    const succeeded = await terminalPromise;
    expect(succeeded).toMatchObject({ ok: true, value: { requestId: 'save-1', status: 'succeeded', result: { ok: true, revision: 1 } } });
    expect(observed).toEqual(['running', 'succeeded']);
    unsubscribe();
    expect(gateway.ledger).toHaveLength(1);
    expect(gateway.getOperationRunResult('save-1')).toEqual(succeeded);
    expect(gateway.getOperationRunResult('save-1')).toEqual(gateway.getOperationRunResult('save-1'));

    const failed = gateway.dispatch({ kind: 'saveDocToDisk', requestId: 'save-2' }, 'ai');
    expect(failed).toMatchObject({ ok: true, result: { operationRun: { requestId: 'save-2', attempt: 1 } } });
    expect(completions).toHaveLength(2);
    completions[1]!.reject(new Error('write failed'));
    const failedResult = await gateway.waitOperationRun('save-2');
    expect(failedResult).toMatchObject({ ok: true, value: { requestId: 'save-2', status: 'failed', error: { code: 'operation-failed' } } });

    const retry = gateway.retryOperationRun('save-2', 'save-3');
    expect(retry).toMatchObject({ ok: true, result: { operationRun: { requestId: 'save-3', attempt: 2 } } });
    expect(typeof (retry.ok ? retry.result?.operationRun?.parentRunId : undefined)).toBe('string');
    expect(completions).toHaveLength(3);
    completions[2]!.reject(new Error('retry failed'));
    const retryResult = await gateway.waitOperationRun('save-3');
    expect(retryResult).toMatchObject({ ok: true, value: { requestId: 'save-3', status: 'failed', error: { code: 'operation-failed' } } });
    expect(gateway.ledger).toHaveLength(1);
  } finally {
    restoreApplier();
  }
});

test('createAsset stays blocked when its real owner has no terminal OperationRun', async () => {
  const gateway = new EditGateway(createEditSession());
  const requestId = 'create-asset-q5-red-1';

  const result = gateway.dispatch({
    kind: 'createAsset',
    packPath: 'assets/q5-red.pack.json',
    guid: 'asset-q5-red-1',
    assetKind: 'scene',
    name: 'Q5 Red Asset',
    requestId,
  } as never, 'ai');

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: 'capability-blocked',
      stage: 'preflight',
      owner: '@forgeax/editor-core OperationRun/applier contract owner',
      recoveryAction: 'owner.repair',
      diagnosticId: 'q5-create-asset-terminal-run',
    },
  });
  expect(gateway.ledger).toHaveLength(0);
  expect(gateway.operationRunSnapshot().runs).toHaveLength(0);
  await expect(gateway.waitOperationRun(requestId)).resolves.toMatchObject({
    ok: false,
    error: { code: 'run-not-found' },
  });

  const error = result.ok ? undefined : result.error as unknown as Record<string, unknown>;
  expect(error?.recoveryActions).not.toContain('save');
  expect(error?.recoveryActions).not.toContain('capture');
  expect(error?.recoveryActions).not.toContain('stage.advance');
});

test('t09 reads the M2 q5 gap without creating a repair or mutation run', async () => {
  const gateway = new EditGateway(createEditSession());
  const before = gateway.operationRunSnapshot();
  const descriptor = gateway.listOps().find((entry) => entry.id === 'createAsset');

  expect(descriptor).toMatchObject({
    capabilityGeneration: 'g0',
    capabilityStatus: 'blocked',
    stage: 'preflight',
    owner: '@forgeax/editor-core OperationRun/applier contract owner',
    diagnosticId: 'q5-create-asset-terminal-run',
    recoveryAction: 'owner.repair',
    availability: {
      available: false,
      code: 'capability-blocked',
    },
  });

  const observed = gateway.dispatch({
    kind: 'createAsset',
    packPath: 'games/reference/assets/m2-q5.blocked.pack.json',
    guid: 'creation-m2-1:asset',
    assetKind: 'scene',
    name: 'M2 persisted q5 probe',
    requestId: 'creation-m2-1:q5-probe',
  } as never, 'ai');

  expect(observed).toMatchObject({
    ok: false,
    error: {
      code: 'capability-blocked',
      stage: 'preflight',
      owner: '@forgeax/editor-core OperationRun/applier contract owner',
      diagnosticId: 'q5-create-asset-terminal-run',
      recoveryAction: 'owner.repair',
      capabilityGeneration: 'g0',
    },
  });
  const after = gateway.operationRunSnapshot();
  expect(after).toEqual(before);
  expect(gateway.ledger).toHaveLength(0);
});

test('t10 reconnect invalidates the cached q5 snapshot and publishes a new callable generation', () => {
  const gateway = new EditGateway(createEditSession());
  const blocked = gateway.operationCapabilitySnapshot();
  expect(blocked).toBe(gateway.operationCapabilitySnapshot());
  expect(blocked).toMatchObject({ capabilityGeneration: 'g0' });

  const observed: string[] = [];
  const unsubscribe = gateway.subscribeOperationCapabilities((snapshot) => {
    observed.push(snapshot.capabilityGeneration ?? 'missing');
  });
  const repaired = gateway.reconnectCapabilitySnapshot();
  unsubscribe();

  expect(repaired).not.toBe(blocked);
  expect(repaired).toMatchObject({ capabilityGeneration: 'g1' });
  expect(repaired.ops.find((entry) => entry.id === 'createAsset')).toMatchObject({
    capabilityGeneration: 'g1',
    capabilityStatus: 'callable',
    availability: { available: true },
    operationRun: {
      read: { get: 'getOperationRun', wait: 'waitOperationRun', subscribe: 'subscribeOperationRun' },
      retry: { requiresNewRequestId: true },
    },
  });
  expect(observed).toEqual(['g1']);
});

test('M2 discovers a terminal native seed before probing the live createAsset path', async () => {
  const gateway = new EditGateway(createEditSession());
  const discovered = gateway.listOps();
  const seed = discovered.find((entry) => (
    entry.id === 'spawnEntity' &&
    entry.operationRun !== undefined &&
    entry.availability.available
  ));
  expect(seed).toBeDefined();

  const createAsset = discovered.find((entry) => entry.id === 'createAsset');
  expect(createAsset).toMatchObject({
    capabilityGeneration: 'g0',
    capabilityStatus: 'blocked',
    availability: {
      available: false,
      code: 'capability-blocked',
      diagnosticId: 'q5-create-asset-terminal-run',
    },
  });

  const runId = 'm2-native-seed-1';
  const ledgerBefore = gateway.ledger.length;
  const seedDispatch = gateway.dispatch({
    kind: 'spawnEntity',
    name: 'M2 native seed',
    components: {},
    requestId: runId,
  } as never, 'ai');
  expect(seedDispatch).toMatchObject({
    ok: true,
    result: { operationRun: { requestId: runId, status: 'running' } },
  });
  const seedTerminal = await gateway.waitOperationRun(runId);
  expect(seedTerminal).toMatchObject({
    ok: true,
    value: { requestId: runId, status: 'succeeded' },
  });
  expect(gateway.ledger).toHaveLength(ledgerBefore + 1);

  const q5 = gateway.dispatch({
    kind: 'createAsset',
    packPath: 'assets/m2-q5-red.pack.json',
    guid: 'asset-m2-q5-red-1',
    assetKind: 'scene',
    name: 'M2 Q5 Red Asset',
  } as never, 'ai');
  expect(q5).toMatchObject({
    ok: false,
    error: {
      code: 'capability-blocked',
      stage: 'preflight',
      owner: '@forgeax/editor-core OperationRun/applier contract owner',
      diagnosticId: 'q5-create-asset-terminal-run',
    },
  });
  expect(gateway.operationRunSnapshot().runs.some((run) => run.requestId === runId)).toBe(true);
  expect(gateway.ledger).toHaveLength(ledgerBefore + 1);
});

test('t04 real Gateway integration records the native terminal run before the q5 gap', async () => {
  const gateway = new EditGateway(createEditSession());
  const port: GatewayCreationPort = {
    listOps: () => gateway.listOps().map((entry) => ({
      id: entry.id,
      available: entry.availability.available,
      ...(entry.operationRun === undefined ? {} : { operationRun: true }),
      ...(entry.capabilityGeneration === undefined ? {} : { capabilityGeneration: entry.capabilityGeneration }),
      ...(entry.availability.available ? {} : {
        blocked: {
          code: entry.availability.code,
          stage: entry.stage,
          owner: entry.owner,
          diagnosticId: entry.diagnosticId,
          recoveryAction: entry.recoveryAction,
        },
      }),
    })),
    assetCatalog: () => gateway.assetCatalog().map((entry) => ({ guid: entry.guid, kind: entry.kind, name: entry.name })),
    dispatch: (command, origin) => {
      const result = gateway.dispatch(command as never, origin);
      if (!result.ok) return { ok: false, error: result.error as never };
      const nested = result.result as { readonly operationRun?: unknown } | undefined;
      const operationRun = nested?.operationRun;
      return {
        ok: true,
        ...(operationRun === undefined ? {} : { operationRun: operationRun as never }),
      };
    },
    waitOperationRun: async (requestId) => {
      const result = await gateway.waitOperationRun(requestId);
      return result.ok
        ? { ok: true, value: { requestId, runId: result.value.runId, status: result.value.status as never } }
        : { ok: false, error: result.error as never };
    },
    reconnect: (generation) => {
      expect(gateway.operationCapabilitySnapshot().capabilityGeneration).toBe(generation);
      gateway.reconnectCapabilitySnapshot();
    },
  };
  const runtime = createReferenceCreationRuntime({ gateway: port });
  const result = await runtime.start({
    creationRunId: 't04-real-gateway-run',
    referenceFingerprint: 'sha256:t04-real',
    targetProject: 'games/reference',
    targetScene: 'default',
    originalStage: 'blockout',
    viewSemantics: 'front orthographic reference view',
    visibleFacts: ['root silhouette'],
    inferredFacts: ['hidden back face'],
    unknownFacts: ['occluded underside'],
    fidelityFocus: ['silhouette'],
    correctionBudget: { perStage: 3, total: 12 },
  });
  expect(result).toMatchObject({
    ok: false,
    error: { code: 'capability-gap', capabilityGeneration: 'g0', capabilityId: 'scene.createAsset' },
    run: { priorOperationRunId: expect.any(String), dispatchCount: 1, commitCount: 1, mutationCount: 1, status: 'blocked' },
  });
  expect(gateway.operationRunSnapshot().runs.some((run) => run.requestId === 't04-real-gateway-run:native-seed')).toBe(true);
});

test('t10 spawnEntity returns a terminal native OperationRun', async () => {
  const gateway = new EditGateway(createEditSession());
  const requestId = 't10-spawn-entity-terminal-1';

  const accepted = gateway.dispatch({
    kind: 'spawnEntity',
    requestId,
    name: 'Reference root',
    components: {},
  } as never, 'ai');

  expect(accepted).toMatchObject({
    ok: true,
    result: {
      created: [expect.anything()],
      operationRun: { requestId, status: 'running' },
    },
  });

  await expect(gateway.waitOperationRun(requestId)).resolves.toMatchObject({
    ok: true,
    value: {
      requestId,
      status: 'succeeded',
      result: { created: [expect.anything()] },
    },
  });
});

test('createSceneFile dispatch is request-correlated and publishes only its terminal success', async () => {
  const completion = deferred<unknown>();
  const restoreApplier = registerApplier('session', 'createSceneFile', () => ({ ok: true, completion: completion.promise }));

  try {
    const gateway = new EditGateway(createEditSession());
    const missingRequestId = gateway.dispatch({
      kind: 'createSceneFile',
      id: 'level-c',
      duplicateCurrent: false,
    } as never, 'ai');
    expect(missingRequestId).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });

    const accepted = gateway.dispatch({
      kind: 'createSceneFile',
      id: 'level-c',
      duplicateCurrent: true,
      requestId: 'create-level-c-1',
    }, 'ai');
    expect(accepted).toMatchObject({
      ok: true,
      result: { operationRun: { requestId: 'create-level-c-1', operationId: 'createSceneFile', status: 'running' } },
    });
    expect(gateway.ledger).toHaveLength(0);

    completion.resolve({
      ok: true,
      result: {
        requestId: 'create-level-c-1',
        sceneId: 'level-c',
        sceneGuid: '019f5545-087e-7f92-9041-f5b839605afe',
        pack: 'assets/scenes/level-c.pack.json',
        duplicateCurrent: true,
      },
    });
    const terminal = await gateway.waitOperationRun('create-level-c-1');
    expect(terminal).toMatchObject({
      ok: true,
      value: {
        operationId: 'createSceneFile',
        requestId: 'create-level-c-1',
        status: 'succeeded',
        result: { sceneId: 'level-c', duplicateCurrent: true },
      },
    });
    expect(gateway.ledger).toHaveLength(1);
  } finally {
    restoreApplier();
  }
});

test('human save without a requestId cannot bypass the Gateway OperationRun path', () => {
  const restoreApplier = registerApplier('session', 'saveDocToDisk', () => ({ ok: true }));
  try {
    const gateway = new EditGateway(createEditSession());
    const rejected = gateway.dispatch({ kind: 'saveDocToDisk' }, 'human');

    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGS' },
    });
    expect(gateway.ledger).toHaveLength(0);
    expect(gateway.operationRuns.listRuns()).toHaveLength(0);
  } finally {
    restoreApplier();
  }
});

test('scene switch dispatch is request-correlated and retryable', async () => {
  const completions: Array<Deferred<unknown>> = [];
  const restoreApplier = registerApplier('session', 'switchSceneFile', () => {
    const effect = deferred<unknown>();
    completions.push(effect);
    return { ok: true, completion: effect.promise };
  });

  try {
    const gateway = new EditGateway(createEditSession());
    const accepted = gateway.dispatch({ kind: 'switchSceneFile', id: 'level-b', dirtyPolicy: 'discard', requestId: 'switch-run-1' }, 'ai');
    expect(accepted).toMatchObject({ ok: true, result: { operationRun: { operationId: 'switchSceneFile', requestId: 'switch-run-1', status: 'running' } } });
    expect(completions).toHaveLength(1);
    completions[0]!.reject({ code: 'scene-switch-load-failed', hint: 'fixture load failed', retryable: true, recoveryActions: ['operation.retry'] });
    await expect(gateway.waitOperationRun('switch-run-1')).resolves.toMatchObject({ ok: true, value: { status: 'failed', error: { code: 'scene-switch-load-failed' } } });
    expect(gateway.ledger).toHaveLength(0);

    const retry = gateway.retryOperationRun('switch-run-1', 'switch-run-2', 'ai');
    expect(retry).toMatchObject({ ok: true, result: { operationRun: { operationId: 'switchSceneFile', requestId: 'switch-run-2', parentRunId: expect.any(String), attempt: 2 } } });
    completions[1]!.resolve({ ok: true, result: { sceneId: 'level-b' } });
    await gateway.waitOperationRun('switch-run-2');
    expect(gateway.ledger).toHaveLength(1);
  } finally {
    restoreApplier();
  }
});

test('human and AI request-correlated saves share the same run facts and terminal notifications', async () => {
  const completions: Array<Deferred<unknown>> = [];
  const restoreApplier = registerApplier('session', 'saveDocToDisk', () => {
    const effect = deferred<unknown>();
    completions.push(effect);
    return { ok: true, completion: effect.promise };
  });

  try {
    const gateway = new EditGateway(createEditSession());
    const observed: Array<{ requestId?: string; status: string }> = [];
    const unsubscribe = gateway.subscribeOperationRuns((run) => observed.push({ requestId: run.requestId, status: run.status }));
    const human = gateway.dispatch({ kind: 'saveDocToDisk', requestId: 'human-save-1' }, 'human');
    expect(human).toMatchObject({ ok: true, result: { operationRun: { requestId: 'human-save-1', status: 'running' } } });
    completions[0]!.resolve({ ok: true, revision: 1 });
    await gateway.waitOperationRun('human-save-1');

    const ai = gateway.dispatch({ kind: 'saveDocToDisk', requestId: 'ai-save-1' }, 'ai');
    expect(ai).toMatchObject({ ok: true, result: { operationRun: { requestId: 'ai-save-1', status: 'running' } } });
    completions[1]!.resolve({ ok: true, revision: 2 });
    await gateway.waitOperationRun('ai-save-1');
    unsubscribe();

    expect(observed).toEqual([
      { requestId: 'human-save-1', status: 'accepted' },
      { requestId: 'human-save-1', status: 'running' },
      { requestId: 'human-save-1', status: 'succeeded' },
      { requestId: 'ai-save-1', status: 'accepted' },
      { requestId: 'ai-save-1', status: 'running' },
      { requestId: 'ai-save-1', status: 'succeeded' },
    ]);
    expect(gateway.getOperationRunResult('human-save-1')).toMatchObject({ ok: true, value: { actor: { kind: 'human' }, status: 'succeeded' } });
    expect(gateway.getOperationRunResult('ai-save-1')).toMatchObject({ ok: true, value: { actor: { kind: 'ai' }, status: 'succeeded' } });
  } finally {
    restoreApplier();
  }
});

test('Gateway exposes one versioned snapshot for retained operation runs', async () => {
  const restoreApplier = registerApplier('session', 'saveDocToDisk', () => ({
    ok: true,
    completion: Promise.resolve({ ok: true, result: { revision: 1 } }),
  }));
  try {
    const gateway = new EditGateway(createEditSession());
    const empty = gateway.operationRunSnapshot();
    expect(empty).toEqual({ revision: 0, runs: [] });
    expect(Object.isFrozen(empty)).toBe(true);

    const accepted = gateway.dispatch({ kind: 'saveDocToDisk', requestId: 'snapshot-save-1' }, 'ai');
    expect(accepted).toMatchObject({ ok: true, result: { operationRun: { status: 'running' } } });
    await gateway.waitOperationRun('snapshot-save-1');

    const snapshot = gateway.operationRunSnapshot();
    expect(snapshot.revision).toBeGreaterThan(empty.revision);
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]).toMatchObject({ requestId: 'snapshot-save-1', status: 'succeeded' });
    expect(Object.isFrozen(snapshot.runs)).toBe(true);
    expect(Object.isFrozen(snapshot.runs[0])).toBe(true);
    expect(gateway.operationRunSnapshot()).toEqual(snapshot);
    expect(gateway.operationRunSnapshot()).toBe(snapshot);
  } finally {
    restoreApplier();
  }
});

test('Gateway-owned registry expires only terminal runs and reports unknown/expired IDs structurally', () => {
  const registry = new OperationRunRegistry({ scope: 'editor', maxTerminalRuns: 1 });
  const actor = { id: 'agent-1', kind: 'ai' as const };
  const first = registry.acceptSave('retention-save-1', {}, actor);
  expect(first).toMatchObject({ ok: true, run: { status: 'accepted' } });
  if (!first.ok) return;
  expect(registry.markRunning(first.runId)).toMatchObject({ ok: true, value: { status: 'running' } });
  expect(registry.fail(first.runId, {
    code: 'write-failed',
    hint: 'fixture failure',
    retryable: true,
    recoveryActions: ['operation.retry'],
  })).toMatchObject({ ok: true, value: { status: 'failed' } });

  const second = registry.acceptSave('retention-save-2', {}, actor);
  expect(second).toMatchObject({ ok: true, run: { status: 'accepted' } });
  if (!second.ok) return;
  expect(registry.markRunning(second.runId)).toMatchObject({ ok: true, value: { status: 'running' } });
  expect(registry.fail(second.runId, {
    code: 'write-failed',
    hint: 'fixture failure',
    retryable: true,
    recoveryActions: ['operation.retry'],
  })).toMatchObject({ ok: true, value: { status: 'failed' } });
  expect(registry.getRunResult('retention-save-1')).toMatchObject({ ok: false, error: { code: 'run-expired' } });
  expect(registry.getRunResult('never-seen')).toMatchObject({ ok: false, error: { code: 'run-not-found' } });
  expect(registry.snapshot().runs).toHaveLength(1);
  expect(registry.snapshot().runs[0]).toMatchObject({ requestId: 'retention-save-2', status: 'failed' });
});
