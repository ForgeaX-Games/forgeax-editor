import { expect, test } from 'bun:test';
import type { CommandError } from '@forgeax/editor-core';
import { RunJournal, createTransportService, createTransportSecurityPolicy, TRANSPORT_PROTOCOL_VERSION } from '@forgeax/editor-product';
import { createSourceAuthoringTransport } from '../source-authoring-transport';

test('producer HTTP failure stays structured through source dispatch and its journal record', async () => {
  const producer = {
    code: 'produce-failed' as CommandError['code'],
    hint: 'repair declarations',
    owner: 'engine',
    category: 'resource',
    retryable: false,
    recoveryActions: ['asset.preflight'],
    cause: { code: 'pack-source-external-closure-mismatch', detail: { sourcePath: 'assets/scene.pack.ts', unusedDeclaredGuids: ['unused'] } },
  };
  const source = createSourceAuthoringTransport({
    fetch: async () => Response.json({ ok: true, value: { sourcePath: 'assets/scene.pack.ts', revision: 'a'.repeat(64), assets: [{ guid: '11111111-1111-4111-8111-111111111111' }] } }),
    triggerCook: async () => ({
      ok: false,
      error: { kind: 'http', status: 503, hint: 'repair declarations', producerError: producer },
    }),
    observePublication: async () => { throw new Error('must not observe failed production'); },
  });
  const service = createTransportService({
    journal: new RunJournal({ scope: 'page-a' }),
    security: createTransportSecurityPolicy({ version: TRANSPORT_PROTOCOL_VERSION, scopes: ['page-a'], permissions: { 'run.dispatch': 'execute' } }),
    dispatch: async (_operation, input) => source.execute({ kind: 'asset-source.cold-cook', ...(input as { sourcePath: string; expectedRevision: string; requestId: string }) }),
  });
  const request = { jsonrpc: '2.0' as const, version: TRANSPORT_PROTOCOL_VERSION, id: 'cook-request', correlationId: 'cook-correlation', scope: 'page-a', method: 'run.dispatch', params: { operationId: 'editor.asset-source.cold-cook', input: { sourcePath: 'assets/scene.pack.ts', expectedRevision: 'a'.repeat(64), requestId: 'source-cook' }, actor: { id: 'forge', kind: 'ai' }, sessionId: 'session-a', permission: 'execute' } };
  const failed = await service.handle(request);
  expect(JSON.parse(JSON.stringify(failed))).toMatchObject({ runId: 'transport-cook-request', error: producer });
  expect(await service.handle({ ...request, id: 'read', method: 'run.get', params: { runId: failed.runId } })).toMatchObject({ result: { runId: failed.runId, status: 'failed', error: producer, scope: 'page-a', sessionId: 'session-a' } });
  expect(await service.handle({ ...request, id: 'list', method: 'run.list', params: {} })).toMatchObject({ result: { items: [{ runId: failed.runId, status: 'failed' }] } });
  expect(await service.handle({ ...request, id: 'denied', params: { ...request.params, permission: 'read' } })).toMatchObject({ error: { code: 'permission-denied' } });
  expect(await service.handle({ ...request, id: 'wrong-scope', scope: 'page-b' })).toMatchObject({ error: { code: 'scope-mismatch' } });
});
