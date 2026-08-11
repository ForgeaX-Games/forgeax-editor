// M2-T2: save is a real Gateway-owned OperationRun adopter. These tests keep the
// effect unresolved until the fixture decides, so accepted/running can never be
// mistaken for a persisted terminal result.

import { expect, test } from 'bun:test';

import { EditGateway } from '../io/gateway';
import { registerApplier, type SessionApplier } from '../io/appliers';
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

function makeSaveGateway(): {
  gateway: EditGateway;
  effects: Array<Deferred<unknown>>;
  restore(): void;
} {
  const effects: Array<Deferred<unknown>> = [];
  const fakeApplier: SessionApplier = () => {
    const effect = deferred<unknown>();
    effects.push(effect);
    return { ok: true, completion: effect.promise };
  };
  const restoreApplier = registerApplier('session', 'saveDocToDisk', fakeApplier);
  return {
    gateway: new EditGateway(createEditSession()),
    effects,
    restore(): void {
      restoreApplier();
    },
  };
}

test('save lifecycle is accepted before commit and publishes exactly one terminal', async () => {
  const fixture = makeSaveGateway();
  try {
    const gateway = fixture.gateway;
    const accepted = gateway.dispatch({ kind: 'saveDocToDisk', requestId: 'save-life-1' }, 'ai');
    expect(accepted).toMatchObject({ ok: true, result: { operationRun: { requestId: 'save-life-1', status: 'running' } } });
    expect(fixture.effects).toHaveLength(1);
    expect(gateway.getOperationRunResult('save-life-1')).toMatchObject({ ok: true, value: { status: 'running' } });
    expect(gateway.getOperationRunResult('save-life-1')).not.toMatchObject({ ok: true, value: { status: 'succeeded' } });
    expect(gateway.ledger).toHaveLength(0);

    const observed: string[] = [];
    const unsubscribe = gateway.subscribeOperationRun('save-life-1', (run) => observed.push(run.status));
    const terminal = gateway.waitOperationRun('save-life-1');
    fixture.effects[0]!.resolve({ ok: true, result: { committedRevision: 'pack:r1' } });
    await expect(terminal).resolves.toMatchObject({ ok: true, value: { status: 'succeeded', result: { committedRevision: 'pack:r1' } } });
    expect(observed).toEqual(['running', 'succeeded']);
    expect(gateway.ledger).toHaveLength(1);
    expect(gateway.historySteps()).toHaveLength(0);
    expect(gateway.getOperationRunResult('save-life-1')).toEqual(await gateway.waitOperationRun('save-life-1'));
    unsubscribe();
  } finally {
    fixture.restore();
  }
});

test('same requestId equivalent duplicate reuses one effect while a different ID overlap is rejected', async () => {
  const fixture = makeSaveGateway();
  try {
    const gateway = fixture.gateway;
    const first = gateway.dispatch({ kind: 'saveDocToDisk', requestId: 'save-duplicate-1', intent: 'same' }, 'ai');
    const duplicate = gateway.dispatch({ kind: 'saveDocToDisk', requestId: 'save-duplicate-1', intent: 'same' }, 'ai');
    const overlap = gateway.dispatch({ kind: 'saveDocToDisk', requestId: 'save-duplicate-2', intent: 'later' }, 'ai');
    expect(first).toMatchObject({ ok: true, result: { operationRun: { runId: expect.any(String) } } });
    expect(duplicate).toMatchObject({ ok: true, result: { operationRun: { requestId: 'save-duplicate-1', status: 'running' } } });
    expect(overlap).toMatchObject({ ok: false, error: { code: 'save-already-running', current: { requestId: 'save-duplicate-1' } } });
    expect(fixture.effects).toHaveLength(1);
    expect(gateway.getOperationRunResult('save-duplicate-2')).toMatchObject({ ok: false, error: { code: 'run-not-found' } });
    fixture.effects[0]!.resolve({ ok: true, result: { committedRevision: 'pack:r2' } });
    await gateway.waitOperationRun('save-duplicate-1');
  } finally {
    fixture.restore();
  }
});

test('same requestId with a different intent is a conflict without another write', async () => {
  const fixture = makeSaveGateway();
  try {
    const gateway = fixture.gateway;
    gateway.dispatch({ kind: 'saveDocToDisk', requestId: 'save-conflict-1', intent: 'first' }, 'ai');
    const conflict = gateway.dispatch({ kind: 'saveDocToDisk', requestId: 'save-conflict-1', intent: 'second' }, 'ai');
    expect(conflict).toMatchObject({ ok: false, error: { code: 'operation-request-id-conflict' } });
    expect(fixture.effects).toHaveLength(1);
    fixture.effects[0]!.resolve({ ok: true, result: { committedRevision: 'pack:r3' } });
    await gateway.waitOperationRun('save-conflict-1');
  } finally {
    fixture.restore();
  }
});

test('failed save is non-cancellable, has no authored history, and retries with a new identity', async () => {
  const fixture = makeSaveGateway();
  try {
    const gateway = fixture.gateway;
    gateway.dispatch({ kind: 'saveDocToDisk', requestId: 'save-failed-1' }, 'ai');
    expect(gateway.cancelOperationRun('save-failed-1')).toMatchObject({ ok: false, error: { code: 'run-not-cancellable', current: { requestId: 'save-failed-1' } } });
    fixture.effects[0]!.reject({
      code: 'save-write-failed',
      hint: 'write rejected',
      retryable: true,
      recoveryActions: ['save.retry'],
    });
    const failed = await gateway.waitOperationRun('save-failed-1');
    expect(failed).toMatchObject({ ok: true, value: { status: 'failed', error: { code: 'save-write-failed' } } });
    expect(gateway.ledger).toHaveLength(0);
    expect(gateway.historySteps()).toHaveLength(0);

    const retry = gateway.retryOperationRun('save-failed-1', 'save-retry-1', 'ai');
    expect(retry).toMatchObject({ ok: true, result: { operationRun: { requestId: 'save-retry-1', parentRunId: expect.any(String), attempt: 2 } } });
    expect(fixture.effects).toHaveLength(2);
    fixture.effects[1]!.resolve({ ok: true, result: { committedRevision: 'pack:r4' } });
    await gateway.waitOperationRun('save-retry-1');
    expect(gateway.ledger).toHaveLength(1);
    expect(gateway.getOperationRunResult('save-failed-1')).toMatchObject({ ok: true, value: { status: 'failed' } });
  } finally {
    fixture.restore();
  }
});
