import { expect, test } from 'bun:test';

import { createOperationRun, type OperationRun, type OperationRunAcceptResult, type OperationRunReadResult } from '../contracts/run';
import { TRANSPORT_PROTOCOL_VERSION } from '../contracts/transport';
import {
  createTransportSecurityPolicy,
  createTransportService,
  type SaveOperationRunPort,
  type TransportRequest,
} from './service';

function request(id: string, method: string, params: unknown): TransportRequest {
  return {
    jsonrpc: '2.0',
    version: TRANSPORT_PROTOCOL_VERSION,
    id,
    correlationId: `corr-${id}`,
    method,
    params,
  };
}

function run(requestId: string, runId = 'operation-run-1'): OperationRun {
  const created = createOperationRun({
    runId,
    requestId,
    operationId: 'saveDocToDisk',
    actor: { id: 'transport-agent', kind: 'ai' },
    sessionId: 'transport-session',
    scope: 'default',
    input: { requestId },
    cancellable: false,
    retryable: true,
  }, 10);
  if (!created.ok) throw new Error(created.error.hint);
  return Object.freeze({ ...created.value, status: 'running', sequence: 2, startedAt: 11 });
}

const auth = {
  scope: 'default',
  actor: { id: 'transport-agent', kind: 'ai' as const },
  sessionId: 'transport-session',
  permission: 'execute' as const,
};

test('save transport delegates request-correlated reads and never promotes accepted to succeeded', async () => {
  const current = run('save-transport-1');
  const calls: string[] = [];
  const port: SaveOperationRunPort = {
    dispatchSave: () => {
      calls.push('dispatch');
      return { ok: true, runId: current.runId, reused: false, run: current };
    },
    get: () => {
      calls.push('get');
      return { ok: true, value: current };
    },
    wait: async () => {
      calls.push('wait');
      return { ok: true, value: current };
    },
    retry: () => {
      calls.push('retry');
      return { ok: true, runId: 'operation-run-2', reused: false, run: run('save-transport-retry', 'operation-run-2') };
    },
    cancel: () => {
      calls.push('cancel');
      return { ok: false, error: { code: 'run-not-cancellable', hint: 'save cannot be cancelled', retryable: false, recoveryActions: [] } };
    },
  };
  const service = createTransportService({
    operationRuns: port,
    security: createTransportSecurityPolicy({ version: TRANSPORT_PROTOCOL_VERSION, scopes: ['default'], permissions: {} }),
  });

  const accepted = await service.handle(request('dispatch', 'run.dispatch', {
    operationId: 'saveDocToDisk',
    input: { requestId: 'save-transport-1' },
    ...auth,
  }));
  expect(accepted).toMatchObject({ runId: current.runId, result: { requestId: 'save-transport-1', runId: current.runId, status: 'running' } });

  const fetched = await service.handle(request('get', 'run.get', { requestId: 'save-transport-1', ...auth }));
  const waited = await service.handle(request('wait', 'run.wait', { requestId: 'save-transport-1', ...auth }));
  expect(fetched.result).toEqual(current);
  expect(waited.result).toEqual(current);
  expect(calls).toEqual(['dispatch', 'get', 'wait']);
});

test('save transport exposes structured unknown, expired, unavailable, retry, and cancel facts', async () => {
  const missing: OperationRunReadResult = { ok: false, error: { code: 'run-not-found', hint: 'unknown request', retryable: false, recoveryActions: ['run.list'] } };
  const expired: OperationRunReadResult = { ok: false, error: { code: 'run-expired', hint: 'expired request', retryable: false, recoveryActions: ['run.list'] } };
  const port: SaveOperationRunPort = {
    dispatchSave: () => ({ ok: false, error: { code: 'operation-request-id-conflict', hint: 'conflict', retryable: false, recoveryActions: ['run.get'] } }),
    get: (requestId) => requestId === 'expired' ? expired : missing,
    wait: async (requestId) => requestId === 'expired' ? expired : missing,
    retry: () => ({ ok: false, error: { code: 'run-not-retryable', hint: 'retry later', retryable: false, recoveryActions: ['run.get'] } }),
    cancel: () => ({ ok: false, error: { code: 'run-not-cancellable', hint: 'save cannot be cancelled', retryable: false, recoveryActions: ['run.wait'] } }),
  };
  const service = createTransportService({
    operationRuns: port,
    security: createTransportSecurityPolicy({ version: TRANSPORT_PROTOCOL_VERSION, scopes: ['default'], permissions: {} }),
  });

  expect(await service.handle(request('unknown', 'run.get', { requestId: 'unknown', ...auth }))).toMatchObject({ error: { code: 'run-not-found', recoveryActions: ['run.list'] } });
  expect(await service.handle(request('expired', 'run.wait', { requestId: 'expired', ...auth }))).toMatchObject({ error: { code: 'run-expired' } });
  expect(await service.handle(request('conflict', 'run.dispatch', { operationId: 'saveDocToDisk', input: { requestId: 'conflict' }, ...auth }))).toMatchObject({ error: { code: 'operation-request-id-conflict' } });
  expect(await service.handle(request('cancel', 'run.cancel', { requestId: 'unknown', ...auth }))).toMatchObject({ error: { code: 'run-not-found' } });
  expect(await service.handle(request('retry', 'run.retry', { requestId: 'unknown', retryRequestId: 'retry-1', ...auth }))).toMatchObject({ error: { code: 'run-not-found' } });

  const unavailable = createTransportService({
    security: createTransportSecurityPolicy({ version: TRANSPORT_PROTOCOL_VERSION, scopes: ['default'], permissions: {} }),
  });
  expect(await unavailable.handle(request('unavailable', 'run.dispatch', { operationId: 'saveDocToDisk', input: { requestId: 'save-unavailable' }, ...auth }))).toMatchObject({ error: { code: 'executor-unavailable' } });
});

const _typeGuard: OperationRunAcceptResult | undefined = undefined;
void _typeGuard;
