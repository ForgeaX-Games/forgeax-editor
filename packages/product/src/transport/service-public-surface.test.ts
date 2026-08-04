import { expect, test } from 'bun:test';

import {
  CapabilityRegistry,
  createAssetWorkspace,
  createEditorProduct,
  createTransportSecurityPolicy,
  createTransportService,
  TRANSPORT_PROTOCOL_VERSION,
  type TransportRequest,
} from '@forgeax/editor-product';

function request(id: string, method: string, params: unknown): TransportRequest {
  return { jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id, correlationId: `public-${id}`, scope: 'default', method, params };
}

const auth = { scope: 'default', actor: { id: 'public-test', kind: 'ai' }, sessionId: 'public-session', permission: 'execute' as const };

test('discover publishes the product capability manifest without parallel runtime methods', async () => {
  const registry = new CapabilityRegistry();
  registry.register({
    id: 'asset.rename', kind: 'operation', version: '1', subject: 'asset', verb: 'rename',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, availability: { available: true },
    preconditions: [], recoveryActions: [], executor: { execute: (input) => input },
  });
  const service = createTransportService({ product: createEditorProduct({ availability: { available: true, blocking: false, code: 'product-available' }, capabilityRegistry: registry }) });
  const response = await service.handle(request('discover', 'discover', {}));
  expect(response.result).toMatchObject({
    manifest: { productId: '@forgeax/editor-product', capabilitySource: 'registered-ssot' },
    capabilityManifest: { generatedFrom: 'capability-registry', capabilities: [{ id: 'asset.rename' }] },
    availability: { available: true, code: 'product-available' },
    methods: expect.not.arrayContaining(['runtime.play', 'runtime.stop']),
  });
});

test('asset snapshot and preflight are callable through the typed service', async () => {
  const workspace = createAssetWorkspace();
  workspace.reconcile({
    resourceRevision: 'resource:r1',
    subjects: [{ id: 'asset:one', kind: 'internal-asset', provenance: { owner: 'editor', source: 'fixture' }, resourceId: 'resource:one', path: 'one.asset', capabilities: { canImport: false, canMove: true, canDelete: true, canPreflight: true } }],
    relations: [], issues: [],
  });
  const service = createTransportService({ assetWorkspace: workspace });
  const snapshot = await service.handle(request('snapshot', 'asset.snapshot', { limit: 1 }));
  expect(snapshot.result).toMatchObject({ revision: 'workspace:r1', subjects: [{ id: 'asset:one' }] });
  const preflight = await service.handle(request('preflight', 'asset.preflight', { request: { operation: 'delete', subjectId: 'asset:one' } }));
  expect(preflight.result).toMatchObject({ ok: true, subjectRef: 'asset:one', confirmation: { required: true } });
});

test('gameplay is advertised and delegated only when the live carrier supplies it', async () => {
  const calls: unknown[] = [];
  const service = createTransportService({ gameplay: (input) => { calls.push(input); return { ok: true, operation: 'query' }; } });
  const discovered = await service.handle(request('discover-gameplay', 'discover', {}));
  expect(discovered.result).toMatchObject({ methods: expect.arrayContaining(['gameplay']) });
  const response = await service.handle(request('gameplay-query', 'gameplay', { version: 1, operation: 'query', query: '2048.snapshot' }));
  expect(response.result).toEqual({ ok: true, operation: 'query' });
  expect(calls).toEqual([{ version: 1, operation: 'query', query: '2048.snapshot' }]);

  const unavailable = await createTransportService().handle(request('gameplay-unavailable', 'gameplay', {}));
  expect(unavailable).toMatchObject({ error: { code: 'not-supported' } });
});

test('dispatches play only through the registered product operation', async () => {
  const registry = new CapabilityRegistry();
  registry.register({
    id: 'editor.play', kind: 'operation', version: '1', subject: 'editor', verb: 'play',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, availability: { available: true },
    preconditions: [], recoveryActions: [], executor: { execute: () => ({ worldId: 'play-1' }) },
  });
  const service = createTransportService({
    product: createEditorProduct({ capabilityRegistry: registry }),
  });
  const response = await service.handle(request('play', 'run.dispatch', {
    operationId: 'editor.play', input: {}, ...auth,
  }));
  expect(response).toMatchObject({ result: { status: 'succeeded' } });
  expect(service.getRun(response.runId!)).toMatchObject({
    ok: true,
    value: { status: 'succeeded', result: { worldId: 'play-1' } },
  });
  const alias = await service.handle(request('runtime-alias', 'runtime.play', auth));
  expect(alias).toMatchObject({ error: { code: 'not-supported' } });
});

test('async dispatch returns a running run before the executor resolves', async () => {
  let finish: ((value: unknown) => void) | undefined;
  const service = createTransportService({
    security: createTransportSecurityPolicy({ version: TRANSPORT_PROTOCOL_VERSION, scopes: ['default'], permissions: {} }),
    dispatch: () => new Promise((resolve) => { finish = resolve; }),
  });
  const accepted = await service.handle(request('async', 'run.dispatch', { operationId: 'asset.rename', input: { id: 'asset:one' }, ...auth, async: true }));
  expect(accepted).toMatchObject({ runId: 'transport-async', result: { status: 'running' } });
  finish?.({ renamed: true });
  await Promise.resolve();
  await Promise.resolve();
  const completed = await service.handle(request('async-get', 'run.get', { runId: accepted.runId }));
  expect(completed.result).toMatchObject({ status: 'succeeded', result: { renamed: true } });
});

test('run.dispatch applies the transport idempotency key', async () => {
  let calls = 0;
  const service = createTransportService({ dispatch: () => ({ call: ++calls }) });
  const params = { operationId: 'asset.rename', input: { id: 'asset:one' }, ...auth, idempotencyKey: 'rename-once' };
  const first = await service.handle(request('idempotent-1', 'run.dispatch', params));
  const second = await service.handle(request('idempotent-2', 'run.dispatch', params));
  expect(second.runId).toBe(first.runId);
  expect(calls).toBe(1);
});

test('run list, event cursor, cancel, and retry are public operations', async () => {
  let calls = 0;
  const service = createTransportService({
    security: createTransportSecurityPolicy({ version: TRANSPORT_PROTOCOL_VERSION, scopes: ['default'], permissions: {} }),
    dispatch: async () => { calls++; if (calls === 1) throw new Error('temporary'); return { ok: true, attempt: calls }; },
  });
  const failed = await service.handle(request('failed', 'run.dispatch', { operationId: 'asset.rename', input: {}, ...auth }));
  const retried = await service.handle(request('retry', 'run.retry', { runId: failed.runId, retryRunId: 'retry-1', ...auth }));
  expect(retried).toMatchObject({ runId: 'retry-1', result: { status: 'succeeded' } });
  const listed = await service.handle(request('list', 'run.list', { limit: 1 }));
  expect(listed.result).toMatchObject({ ok: true, items: [{ runId: 'transport-failed' }] });
  const firstPage = await service.handle(request('events-1', 'run.listEvents', { runId: failed.runId, limit: 1 }));
  expect(firstPage.result).toMatchObject({ events: [{ type: 'accepted' }] });
  expect((firstPage.result as { nextCursor?: string }).nextCursor).toBeTruthy();

  let resolve: (() => void) | undefined;
  const cancellable = createTransportService({ dispatch: () => new Promise((finish) => { resolve = () => finish({ done: true }); }) });
  const pending = await cancellable.handle(request('cancel-me', 'run.dispatch', { operationId: 'slow', input: {}, ...auth, async: true }));
  const cancelled = await cancellable.handle(request('cancel', 'run.cancel', { runId: pending.runId }));
  expect(cancelled.result).toMatchObject({ status: 'cancelled' });
  resolve?.();
});
