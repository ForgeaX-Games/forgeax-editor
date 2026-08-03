import { expect, test } from 'bun:test';

import { EditGateway } from '../io/gateway';
import { sessionAppliers, type SessionApplier } from '../io/appliers';
import { createEditSession } from '../session/document';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
}

test('deleteScene is a human/AI-equal request-correlated OperationRun', async () => {
  const completion = deferred<unknown>();
  const previousApplier = sessionAppliers.get('deleteScene');
  const fakeApplier: SessionApplier = () => ({ ok: true, completion: completion.promise });
  sessionAppliers.set('deleteScene', fakeApplier);
  try {
    const gateway = new EditGateway(createEditSession());
    const missingRequestId = gateway.dispatch({ kind: 'deleteScene', sceneGuid: 'guid-lvl2' } as never, 'ai');
    expect(missingRequestId).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });

    const accepted = gateway.dispatch({
      kind: 'deleteScene',
      sceneGuid: 'guid-lvl2',
      requestId: 'delete-scene-run-1',
    }, 'ai');
    expect(accepted).toMatchObject({
      ok: true,
      result: { operationRun: { operationId: 'deleteScene', requestId: 'delete-scene-run-1', status: 'running' } },
    });
    expect(gateway.ledger).toHaveLength(0);

    completion.resolve({ ok: false, error: {
      code: 'scene-delete-guarded',
      hint: 'current scene',
      current: { impact: { sceneGuid: 'guid-lvl2', isCurrent: true } },
      retryable: false,
      recoveryActions: [],
    } });
    const terminal = await gateway.waitOperationRun('delete-scene-run-1');
    expect(terminal).toMatchObject({
      ok: true,
      value: {
        operationId: 'deleteScene',
        requestId: 'delete-scene-run-1',
        status: 'failed',
        error: { code: 'scene-delete-guarded' },
      },
    });
    expect(gateway.ledger).toHaveLength(0);
  } finally {
    if (previousApplier === undefined) sessionAppliers.delete('deleteScene');
    else sessionAppliers.set('deleteScene', previousApplier);
  }
});
