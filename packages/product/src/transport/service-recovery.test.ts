import { expect, test } from 'bun:test';

import {
  createTransportSecurityPolicy,
  createTransportService,
  TRANSPORT_PROTOCOL_VERSION,
  type TransportRequest,
} from '@forgeax/editor-product';

function request(id: string, params: unknown): TransportRequest {
  return {
    jsonrpc: '2.0',
    version: TRANSPORT_PROTOCOL_VERSION,
    id,
    correlationId: `corr-${id}`,
    method: 'run.dispatch',
    params,
  };
}

test('failed dispatch is recoverable through structured error and terminal run state', async () => {
  const service = createTransportService({
    security: createTransportSecurityPolicy({ version: TRANSPORT_PROTOCOL_VERSION, scopes: ['default'], permissions: {} }),
    dispatch: async () => { throw new Error('disk is temporarily unavailable'); },
  });
  const response = await service.handle(request('failure-1', {
    operationId: 'saveDocToDisk',
    input: {
      scope: 'default',
      actor: { id: 'recovery-test', kind: 'system' },
      sessionId: 'recovery-session',
    },
  }));

  expect(response).toMatchObject({ error: { code: 'operation-failed', retryable: false, recoveryActions: ['run.retry'] } });
  expect(response.runId).toBe('transport-failure-1');
  const terminal = await service.handle({
    ...request('failure-get', { runId: response.runId }),
    method: 'run.get',
  });
  expect(terminal.result).toMatchObject({ runId: response.runId, status: 'failed', error: { code: 'operation-failed' } });
  expect(service.getRun(response.runId ?? '')).toMatchObject({ ok: true, value: { status: 'failed' } });
});
