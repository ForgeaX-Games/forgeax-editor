import { afterEach, describe, expect, it } from 'bun:test';
import {
  TRANSPORT_PROTOCOL_VERSION,
  VIEWPORT_RUNTIME_CONTRACT_VERSION,
  type MessagePortTransportClient,
  type TransportRequest,
  type ViewportRuntimeIdentity,
} from '@forgeax/editor-product';
import { bindViewportRuntimeClient } from '@forgeax/editor-core';
import { readCanonicalScriptablePackRevision } from '../../scriptable-pack-mutation';

const runtime: ViewportRuntimeIdentity = {
  version: VIEWPORT_RUNTIME_CONTRACT_VERSION,
  runtimeId: 'edit-runtime',
  runtimeGeneration: 1,
  carrierId: 'mutation-test',
  carrierKind: 'iframe',
};

let dispose: (() => void) | undefined;

function bind(handler: (request: TransportRequest) => unknown): void {
  const client: MessagePortTransportClient = {
    request: async (request) => handler(request) as never,
    dispose() {},
  };
  dispose = bindViewportRuntimeClient(runtime, client);
}

afterEach(() => {
  dispose?.();
  dispose = undefined;
});

describe('Scriptable Pack mutation preflight result', () => {
  const outputGuid = '01890000-0000-7000-8000-000000000001';
  it.each([
    ['failed', { code: 'promote-session-mismatch', hint: 'stale preview', retryable: false, recoveryActions: ['previewImportedScene'] }],
    ['cancelled', { code: 'operation-failed', hint: 'cancelled by user', retryable: true, recoveryActions: ['operation.retry'] }],
  ] as const)('projects %s terminal errors without throwing or dispatching a mutation', async (status, error) => {
    const requests: TransportRequest[] = [];
    bind((request) => {
      requests.push(request);
      if (request.method === 'run.dispatch') {
        return { jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id: request.id, correlationId: request.correlationId, result: { status: 'accepted' } };
      }
      return { jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id: request.id, correlationId: request.correlationId, result: { status, error } };
    });

    const result = await readCanonicalScriptablePackRevision('assets/source.pack.ts', outputGuid);

    expect(result).toEqual({ ok: false, error });
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.method)).toEqual(['run.dispatch', 'run.wait']);
    expect((requests[0]!.params as { operationId: string }).operationId).toBe('editor.asset.preflight');
  });

  it('normalizes a transport disconnect and never emits a mutation request', async () => {
    const requests: TransportRequest[] = [];
    bind((request) => {
      requests.push(request);
      if (request.method === 'run.dispatch') {
        return { jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id: request.id, correlationId: request.correlationId, result: { status: 'accepted' } };
      }
      throw new Error('carrier disconnected');
    });

    const result = await readCanonicalScriptablePackRevision('assets/source.pack.ts', outputGuid);

    expect(result).toMatchObject({ ok: false, error: { code: 'operation-failed', retryable: true } });
    expect(requests.map((request) => request.method)).toEqual(['run.dispatch', 'run.wait']);
    expect(requests.every((request) => request.method !== 'run.dispatch'
      || (request.params as { operationId: string }).operationId === 'editor.asset.preflight')).toBe(true);
  });

  it('returns the bare canonical CAS revision only on a successful preflight terminal', async () => {
    bind((request) => ({
      jsonrpc: '2.0',
      version: TRANSPORT_PROTOCOL_VERSION,
      id: request.id,
      correlationId: request.correlationId,
      result: request.method === 'run.dispatch'
        ? { status: 'accepted' }
        : { status: 'succeeded', result: { ok: true, revision: 'a'.repeat(64) } },
    }));

    await expect(readCanonicalScriptablePackRevision('assets/source.pack.ts', outputGuid)).resolves.toEqual({
      ok: true,
      revision: 'a'.repeat(64),
    });
  });
});
