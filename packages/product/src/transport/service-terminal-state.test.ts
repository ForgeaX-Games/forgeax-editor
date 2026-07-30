import { expect, test } from 'bun:test';

import {
  createTransportSecurityPolicy,
  createTransportService,
  TRANSPORT_PROTOCOL_VERSION,
  type TransportRequest,
} from '@forgeax/editor-product';

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

const input = {
  scope: 'default',
  actor: { id: 'terminal-test', kind: 'system' },
  sessionId: 'terminal-session',
  permission: 'execute' as const,
};

test('dispatch returns a run id and wait/get expose the canonical succeeded terminal', async () => {
  const service = createTransportService({
    security: createTransportSecurityPolicy({ version: TRANSPORT_PROTOCOL_VERSION, scopes: ['default'], permissions: {} }),
    dispatch: async () => ({ saved: true }),
  });
  const accepted = await service.handle(request('dispatch-1', 'run.dispatch', { operationId: 'saveDocToDisk', input }));
  expect(accepted.runId).toBe('transport-dispatch-1');
  expect(accepted.result).toMatchObject({ runId: accepted.runId, status: 'succeeded' });

  const waited = await service.handle(request('wait-1', 'run.wait', { runId: accepted.runId }));
  const fetched = await service.handle(request('get-1', 'run.get', { runId: accepted.runId }));
  expect(waited.result).toMatchObject({ runId: accepted.runId, status: 'succeeded' });
  expect(fetched.result).toMatchObject({ runId: accepted.runId, status: 'succeeded' });
  expect(service.listEvents(accepted.runId ?? '') .map((event) => event.type)).toEqual(['accepted', 'running', 'succeeded']);
});

test('accepted response is not treated as terminal when the executor is deferred', async () => {
  let resolve: ((value: unknown) => void) | undefined;
  const service = createTransportService({
    security: createTransportSecurityPolicy({ version: TRANSPORT_PROTOCOL_VERSION, scopes: ['default'], permissions: {} }),
    dispatch: () => new Promise((finish) => { resolve = finish; }),
  });
  const pending = service.handle(request('dispatch-2', 'run.dispatch', { operationId: 'longTask', input }));
  await Promise.resolve();
  expect(resolve).toBeDefined();
  resolve?.({ done: true });
  const accepted = await pending;
  expect(accepted.runId).toBe('transport-dispatch-2');
  expect((await service.handle(request('wait-2', 'run.wait', { runId: accepted.runId }))).result).toMatchObject({ status: 'succeeded' });
});
