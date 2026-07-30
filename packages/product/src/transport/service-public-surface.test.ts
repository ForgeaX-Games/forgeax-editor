import { expect, test } from 'bun:test';

import {
  CapabilityRegistry,
  createAssetWorkspace,
  createEditorProduct,
  createRuntimeAvailability,
  createTransportSecurityPolicy,
  createTransportService,
  TRANSPORT_PROTOCOL_VERSION,
  type GameRuntimePort,
  type TransportRequest,
} from '@forgeax/editor-product';

function request(id: string, method: string, params: unknown): TransportRequest {
  return { jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id, correlationId: `public-${id}`, method, params };
}

const auth = { scope: 'default', actor: { id: 'public-test', kind: 'ai' }, sessionId: 'public-session', permission: 'execute' as const };

function runtime(): GameRuntimePort {
  const availability = createRuntimeAvailability({ host: 'bun', capabilities: { play: { available: true }, stop: { available: true } } });
  return {
    availability: () => availability,
    async play() { return { ok: true as const, value: { worldId: 'play-1' } }; },
    async stop() { return { ok: true as const, value: undefined }; },
    async query() { return { ok: true as const, value: { worldId: 'play-1' } }; },
    async fixedStep() { return { ok: true as const, value: undefined }; },
    async dispose() { return { ok: true as const, value: undefined }; },
    async capture() { return { ok: true as const, value: { captured: false } }; },
    async reveal() { return { ok: true as const, value: undefined }; },
  };
}

test('discover publishes product manifest and runtime availability', async () => {
  const registry = new CapabilityRegistry();
  registry.register({
    id: 'asset.rename', kind: 'operation', version: '1', subject: 'asset', verb: 'rename',
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, availability: { available: true },
    preconditions: [], recoveryActions: [], executor: { execute: (input) => input },
  });
  const service = createTransportService({ product: createEditorProduct({ availability: { available: true, blocking: false, code: 'product-available' }, capabilityRegistry: registry }), runtime: runtime() });
  const response = await service.handle(request('discover', 'discover', {}));
  expect(response.result).toMatchObject({
    manifest: { productId: '@forgeax/editor-product', capabilitySource: 'registered-ssot' },
    capabilityManifest: { generatedFrom: 'capability-registry', capabilities: [{ id: 'asset.rename' }] },
    availability: { available: true, code: 'product-available' },
    runtime: { host: 'bun', blocking: false },
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
