import { expect, test } from 'bun:test';

import { EditGateway } from '../io/gateway';
import { registerApplier, type SessionApplier } from '../io/appliers';
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

test('setDefaultScene is a request-correlated human/AI-equal OperationRun', async () => {
  const completion = deferred<unknown>();
  const fakeApplier: SessionApplier = () => ({ ok: true, completion: completion.promise });
  const restoreApplier = registerApplier('session', 'setDefaultScene', fakeApplier);
  try {
    const gateway = new EditGateway(createEditSession());
    const missingRequestId = gateway.dispatch({ kind: 'setDefaultScene', sceneGuid: 'guid-lvl2' } as never, 'ai');
    expect(missingRequestId).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });

    const accepted = gateway.dispatch({
      kind: 'setDefaultScene',
      sceneGuid: 'guid-lvl2',
      requestId: 'default-scene-run-1',
    }, 'ai');
    expect(accepted).toMatchObject({
      ok: true,
      result: { operationRun: { operationId: 'setDefaultScene', requestId: 'default-scene-run-1', status: 'running' } },
    });
    expect(gateway.ledger).toHaveLength(0);

    completion.resolve({ ok: true, result: { requestId: 'default-scene-run-1', sceneGuid: 'guid-lvl2', sceneId: 'lvl2', previousSceneGuid: 'guid-lvl1', changed: true } });
    const terminal = await gateway.waitOperationRun('default-scene-run-1');
    expect(terminal).toMatchObject({
      ok: true,
      value: {
        operationId: 'setDefaultScene',
        requestId: 'default-scene-run-1',
        status: 'succeeded',
        result: { sceneGuid: 'guid-lvl2', changed: true },
      },
    });
    expect(gateway.ledger).toHaveLength(1);
  } finally {
    restoreApplier();
  }
});
