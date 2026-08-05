import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GatewayTransportError,
  createGatewayTransportClient,
  resolveGatewayCapability,
} from './gateway-transport-client.mjs';

const capabilities = [
  { id: 'editor.play', verb: 'play', availability: { available: true } },
  { id: 'editor.stop', verb: 'stop', availability: { available: true } },
];

test('resolves public Gateway operation names without exposing product prefixes', () => {
  assert.equal(resolveGatewayCapability(capabilities, 'play')?.id, 'editor.play');
  assert.equal(resolveGatewayCapability(capabilities, 'editor.stop')?.id, 'editor.stop');
});

test('discovers before dispatch and uses the registered product capability', async () => {
  const requests = [];
  const operationResult = { created: [21, 22] };
  const client = createGatewayTransportClient({
    scope: 'editor:document',
    request: async (method, params) => {
      requests.push({ method, params });
      return method === 'discover'
        ? { result: { capabilityManifest: { capabilities } } }
        : { runId: 'run-play', result: { runId: 'run-play', status: 'succeeded', result: operationResult } };
    },
  });

  const listed = await client.list();
  assert.equal(listed.capabilities[0].operation, 'play');
  const dispatched = await client.dispatch('play', { dirtyPolicy: 'last-saved' }, { idempotencyKey: 'play-once' });
  assert.deepEqual(requests.at(-1), {
    method: 'run.dispatch',
    params: {
      operationId: 'editor.play',
      input: { dirtyPolicy: 'last-saved' },
      scope: 'editor:document',
      actor: { id: 'forgeax-editor-gateway-cli', kind: 'ai' },
      sessionId: 'forgeax-editor-gateway-cli:editor:document',
      permission: 'execute',
      idempotencyKey: 'play-once',
    },
  });
  assert.deepEqual(dispatched.result.result, operationResult);
});

test('retries a reused retryable failure after its external precondition is repaired', async () => {
  const requests = [];
  const responses = [
    { result: { capabilityManifest: { capabilities } } },
    { runId: 'run-failed', result: { runId: 'run-failed', status: 'failed', retryable: true } },
    { runId: 'run-retry', result: { runId: 'run-retry', status: 'succeeded', attempt: 2 } },
  ];
  const client = createGatewayTransportClient({
    scope: 'game:2048',
    request: async (method, params) => {
      requests.push({ method, params });
      return responses.shift();
    },
  });

  await assert.doesNotReject(() => client.dispatch('play', {}, { idempotencyKey: 'desired-play' }));
  assert.deepEqual(requests.map((request) => request.method), ['discover', 'run.dispatch', 'run.retry']);
  assert.deepEqual(requests.at(-1), { method: 'run.retry', params: { runId: 'run-failed' } });
});

test('surfaces a fresh transport failure without replaying the operation', async () => {
  const requests = [];
  const responses = [
    { result: { capabilityManifest: { capabilities } } },
    { runId: 'run-failed', error: { code: 'edit-rejected-in-play', hint: 'stop play mode before editing', retryable: true } },
  ];
  const client = createGatewayTransportClient({
    scope: 'game:2048',
    request: async (method, params) => {
      requests.push({ method, params });
      return responses.shift();
    },
  });

  await assert.rejects(() => client.dispatch('play', {}, { idempotencyKey: 'fresh-play' }), (error) => {
    assert.ok(error instanceof GatewayTransportError);
    assert.equal(error.code, 'TRANSPORT_REJECTED');
    return true;
  });
  assert.deepEqual(requests.map((request) => request.method), ['discover', 'run.dispatch']);
});

test('fails from structured discovery when an operation is unavailable', async () => {
  const client = createGatewayTransportClient({
    scope: 'editor:document',
    request: async () => ({ result: { capabilityManifest: { capabilities } } }),
  });
  await assert.rejects(() => client.dispatch('missing'), (error) => {
    assert.ok(error instanceof GatewayTransportError);
    assert.equal(error.code, 'OPERATION_NOT_REGISTERED');
    return true;
  });
});

test('derives operation help from the discovered capability manifest', async () => {
  const client = createGatewayTransportClient({
    scope: 'editor:document',
    request: async () => ({ result: { capabilityManifest: { capabilities } } }),
  });
  assert.deepEqual(await client.describe('play'), {
    scope: 'editor:document',
    capability: { ...capabilities[0], operation: 'play' },
  });
});

test('queries the Gateway read model without operation discovery', async () => {
  const requests = [];
  const client = createGatewayTransportClient({
    scope: 'editor:document',
    request: async (method, params) => {
      requests.push({ method, params });
      return { result: { ok: true, rows: [{ entity: 7 }] } };
    },
  });
  assert.deepEqual(await client.query({ kind: 'world', with: ['Transform'] }), {
    ok: true, rows: [{ entity: 7 }],
  });
  assert.deepEqual(requests, [{
    method: 'query', params: { input: { kind: 'world', with: ['Transform'] } },
  }]);
});

test('executes operation-scope JavaScript through the typed transport', async () => {
  const requests = [];
  const client = createGatewayTransportClient({
    scope: 'game:2048',
    request: async (method, params) => {
      requests.push({ method, params });
      return { runId: 'script-run', result: { runId: 'script-run', status: 'succeeded', result: { ok: true, value: 42 } } };
    },
  });
  const response = await client.evaluate('gateway.listOps().length', { idempotencyKey: 'script-once' });
  assert.equal(response.result.status, 'succeeded');
  assert.deepEqual(requests, [{
    method: 'script.execute',
    params: {
      code: 'gateway.listOps().length',
      scope: 'game:2048',
      actor: { id: 'forgeax-editor-gateway-cli', kind: 'ai' },
      sessionId: 'forgeax-editor-gateway-cli:game:2048',
      permission: 'execute',
      idempotencyKey: 'script-once',
    },
  }]);
});

test('delegates gameplay to the typed bridge on the same live carrier', async () => {
  const requests = [];
  const client = createGatewayTransportClient({
    scope: 'game:2048',
    request: async (method, params) => {
      requests.push({ method, params });
      return { result: { ok: true, operation: 'query' } };
    },
  });
  assert.deepEqual(
    await client.gameplay({ version: 1, operation: 'query', query: '2048.snapshot' }),
    { ok: true, operation: 'query' },
  );
  assert.deepEqual(requests, [{
    method: 'gameplay',
    params: { version: 1, operation: 'query', query: '2048.snapshot' },
  }]);
});
