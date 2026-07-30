import { expect, test } from 'bun:test';

import { createOperationRun, type OperationRun } from '@forgeax/editor-product';
import { createGatewayCapabilityAdapter, type GatewayOperationRunPort } from '../product/gateway-executor';

function run(): OperationRun {
  const created = createOperationRun({
    runId: 'operation-run-1',
    requestId: 'save-adapter-1',
    operationId: 'saveDocToDisk',
    actor: { id: 'agent-1', kind: 'ai' },
    sessionId: 'session-1',
    scope: 'game-1',
    input: { requestId: 'save-adapter-1' },
    cancellable: false,
    retryable: true,
  }, 10);
  if (!created.ok) throw new Error(created.error.hint);
  return Object.freeze({
    ...created.value,
    status: 'running',
    progress: Object.freeze({ fraction: 0, stage: 'saving' }),
    sequence: 2,
    startedAt: 11,
  });
}

function source(operationRuns?: GatewayOperationRunPort) {
  const current = run();
  return {
    listOps: () => [{
      id: 'saveDocToDisk',
      domain: 'session' as const,
      argsSchema: { type: 'object' as const },
      source: 'builtin' as const,
      title: 'Save to Disk',
    }],
    dispatch: () => ({ ok: true, result: { operationRun: current } }),
    ...(operationRuns === undefined ? {} : { operationRuns }),
  };
}

test('save adapter projects the Gateway run without inventing a terminal', () => {
  const current = run();
  const port: GatewayOperationRunPort = {
    get: () => ({ ok: true, value: current }),
    wait: async () => ({ ok: true, value: current }),
    subscribe: () => () => undefined,
    cancel: () => ({ ok: false, error: { code: 'run-not-cancellable', hint: 'save cannot be cancelled', retryable: false, recoveryActions: [] } }),
    retry: () => ({ ok: false, error: { code: 'operation-not-retryable', hint: 'retry is not available', retryable: false, recoveryActions: [] } }),
  };
  const adapter = createGatewayCapabilityAdapter(source(port));

  const accepted = adapter.dispatchRun('saveDocToDisk', { requestId: 'save-adapter-1' }, {
    requestId: 'save-adapter-1',
    actor: { id: 'agent-1', kind: 'ai' },
    sessionId: 'session-1',
    scope: 'game-1',
  });

  expect(accepted).toMatchObject({
    ok: true,
    runId: 'operation-run-1',
    reused: false,
    run: { requestId: 'save-adapter-1', runId: 'operation-run-1', status: 'running', sequence: 2 },
  });
  expect(adapter.getOperationRunResult('save-adapter-1')).toEqual({ ok: true, value: current });
  expect(adapter.getOperationRunResult('save-adapter-1')).toEqual(adapter.getOperationRunResult('save-adapter-1'));
  expect((accepted.ok ? accepted.run.status : 'succeeded')).not.toBe('succeeded');
});

test('save adapter reports structured unavailable when the Gateway read port is absent', () => {
  const adapter = createGatewayCapabilityAdapter(source());
  const accepted = adapter.dispatchRun('saveDocToDisk', { requestId: 'save-unavailable-1' }, {
    requestId: 'save-unavailable-1',
    actor: { id: 'agent-1', kind: 'ai' },
    sessionId: 'session-1',
    scope: 'game-1',
  });

  expect(accepted).toMatchObject({ ok: false, error: { code: 'executor-unavailable', retryable: false } });
  expect(adapter.getOperationRunResult('save-unavailable-1')).toMatchObject({
    ok: false,
    error: { code: 'executor-unavailable', recoveryActions: ['editor.discover'] },
  });
});
