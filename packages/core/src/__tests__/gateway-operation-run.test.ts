import { expect, test } from 'bun:test';

import { EditGateway } from '../io/gateway';
import { sessionAppliers, type SessionApplier } from '../io/appliers';
import { OperationRunRegistry } from '../io/operation-runs';
import { createEditSession } from '../session/document';

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
  const previousApplier = sessionAppliers.get('saveDocToDisk');
  sessionAppliers.set('saveDocToDisk', fakeApplier);

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
    if (previousApplier === undefined) sessionAppliers.delete('saveDocToDisk');
    else sessionAppliers.set('saveDocToDisk', previousApplier);
  }
});

test('createSceneFile dispatch is request-correlated and publishes only its terminal success', async () => {
  const completion = deferred<unknown>();
  const previousApplier = sessionAppliers.get('createSceneFile');
  sessionAppliers.set('createSceneFile', () => ({ ok: true, completion: completion.promise }));

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
    if (previousApplier === undefined) sessionAppliers.delete('createSceneFile');
    else sessionAppliers.set('createSceneFile', previousApplier);
  }
});

test('human save without a requestId cannot bypass the Gateway OperationRun path', () => {
  const previousApplier = sessionAppliers.get('saveDocToDisk');
  sessionAppliers.set('saveDocToDisk', () => ({ ok: true }));
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
    if (previousApplier === undefined) sessionAppliers.delete('saveDocToDisk');
    else sessionAppliers.set('saveDocToDisk', previousApplier);
  }
});

test('human and AI request-correlated saves share the same run facts and terminal notifications', async () => {
  const completions: Array<Deferred<unknown>> = [];
  const previousApplier = sessionAppliers.get('saveDocToDisk');
  sessionAppliers.set('saveDocToDisk', () => {
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
    if (previousApplier === undefined) sessionAppliers.delete('saveDocToDisk');
    else sessionAppliers.set('saveDocToDisk', previousApplier);
  }
});

test('Gateway exposes one versioned snapshot for retained operation runs', async () => {
  const previousApplier = sessionAppliers.get('saveDocToDisk');
  sessionAppliers.set('saveDocToDisk', () => ({
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
  } finally {
    if (previousApplier === undefined) sessionAppliers.delete('saveDocToDisk');
    else sessionAppliers.set('saveDocToDisk', previousApplier);
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
