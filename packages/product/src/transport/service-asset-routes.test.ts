import { expect, test } from 'bun:test';

import {
  createAssetWorkspace,
  createTransportService,
  TRANSPORT_PROTOCOL_VERSION,
  type TransportRequest,
} from '@forgeax/editor-product';

function request(id: string, method: string, params: unknown): TransportRequest {
  return { jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id, correlationId: `asset-${id}`, method, params };
}

test('discovery publishes the typed asset and workflow recovery methods', async () => {
  const service = createTransportService();
  const response = await service.handle(request('discover', 'discover', {}));
  const methods = response.result && typeof response.result === 'object' ? (response.result as { methods?: readonly string[] }).methods : undefined;

  expect(methods).toEqual(expect.arrayContaining([
    'asset.observe', 'asset.reconcile', 'asset.preflight', 'asset.mutate', 'asset.restore',
    'workflow.get', 'workflow.recover', 'workflow.retry',
  ]));
});

test('asset routes reject malformed input without invoking the workspace', async () => {
  const service = createTransportService({ assetWorkspace: createAssetWorkspace() });

  await expect(service.handle(request('observe-invalid', 'asset.observe', { kind: 'unknown' }))).resolves.toMatchObject({
    error: { code: 'invalid-asset-input', recoveryActions: ['transport.describe'] },
  });
  await expect(service.handle(request('reconcile-invalid', 'asset.reconcile', null))).resolves.toMatchObject({
    error: { code: 'invalid-asset-input', recoveryActions: ['transport.describe'] },
  });
  await expect(service.handle(request('reconcile-malformed-subject', 'asset.reconcile', {
    resourceRevision: 'resource:r1', subjects: [null], relations: [], issues: [],
  }))).resolves.toMatchObject({ error: { code: 'invalid-asset-input' } });
  await expect(service.handle(request('mutate-invalid', 'asset.mutate', { request: { operation: 'delete' } }))).resolves.toMatchObject({
    error: { code: 'invalid-asset-input' },
  });
});

test('asset preflight failures use the top-level transport error channel', async () => {
  const service = createTransportService({ assetWorkspace: createAssetWorkspace() });
  const response = await service.handle(request('preflight-failed', 'asset.preflight', {
    request: { operation: 'delete', subjectId: 'asset:missing' },
  }));

  expect(response).toMatchObject({ error: {
    code: 'unsupported-subject-operation',
    subjectRef: 'asset:missing',
    recoveryActions: ['asset.preflight'],
  } });
  expect(response.result).toBeUndefined();
});

test('asset restore host failures remain structured errors after run normalization', async () => {
  const service = createTransportService({
    assetRestore: async () => ({ ok: false, error: { code: 'restore-failed', hint: 'injected', retryable: false, recoveryActions: ['asset.restore'] } }),
  });
  const response = await service.handle(request('restore-failed', 'asset.restore', { input: { subjectId: 'asset:one' } }));

  expect(response).toMatchObject({ error: { code: 'restore-failed', recoveryActions: ['asset.restore'] } });
  expect(response.result).toBeUndefined();
});

test('asset restore rejects a null explicit input before invoking the host', async () => {
  let invoked = false;
  const service = createTransportService({ assetRestore: async () => { invoked = true; return { ok: true }; } });
  const response = await service.handle(request('restore-invalid', 'asset.restore', { input: null }));

  expect(response).toMatchObject({ error: { code: 'invalid-asset-input', recoveryActions: ['transport.describe'] } });
  expect(invoked).toBe(false);
});
