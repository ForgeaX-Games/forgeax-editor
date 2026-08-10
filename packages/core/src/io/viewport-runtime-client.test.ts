import { describe, expect, test } from 'bun:test';
import {
  TRANSPORT_PROTOCOL_VERSION,
  VIEWPORT_RUNTIME_CONTRACT_VERSION,
  type MessagePortTransportClient,
  type TransportRequest,
  type ViewportRuntimeIdentity,
} from '@forgeax/editor-product';
import {
  bindViewportRuntimeClient,
  discoverViewportRuntimeCapabilities,
  dispatchViewportRuntimeOperation,
  getViewportRuntimeClientSnapshot,
  queryViewportRuntimeProjection,
  retryViewportRuntimeOperationRun,
} from './viewport-runtime-client';
import { dispatchActiveEditorOperation } from '../store/active-operation';
import { getSelection } from '../store/selection';

const runtime = (generation: number): ViewportRuntimeIdentity => ({
  version: VIEWPORT_RUNTIME_CONTRACT_VERSION,
  runtimeId: 'edit-runtime',
  runtimeGeneration: generation,
  carrierId: `frame-${generation}`,
  carrierKind: 'iframe',
});

function client(handle: (request: TransportRequest) => unknown): MessagePortTransportClient {
  return {
    request: async (request) => handle(request) as any,
    dispose() {},
  };
}

describe('viewport runtime client cache', () => {
  test('a stale disposer cannot disconnect a newer Runtime generation', () => {
    const disposeOne = bindViewportRuntimeClient(runtime(1), client(() => ({})));
    const disposeTwo = bindViewportRuntimeClient(runtime(2), client(() => ({})));
    disposeOne();
    expect(getViewportRuntimeClientSnapshot()).toMatchObject({ status: 'ready', runtime: { runtimeGeneration: 2 } });
    disposeTwo();
    expect(getViewportRuntimeClientSnapshot()).toEqual({ status: 'disconnected', runtime: null });
  });

  test('queries typed envelopes and fences a stale producer response', async () => {
    const current = runtime(4);
    const bind = (responseRuntime: ViewportRuntimeIdentity) => bindViewportRuntimeClient(current, client((request) => ({
      jsonrpc: '2.0',
      version: TRANSPORT_PROTOCOL_VERSION,
      id: request.id,
      correlationId: request.correlationId,
      result: { version: VIEWPORT_RUNTIME_CONTRACT_VERSION, runtime: responseRuntime, revision: 1, status: 'ready', value: { rows: [] } },
    })));
    let dispose = bind(current);
    await expect(queryViewportRuntimeProjection({ kind: 'world.snapshot', with: ['Name'] })).resolves.toMatchObject({ status: 'ready' });
    dispose();
    dispose = bind(runtime(3));
    await expect(queryViewportRuntimeProjection({ kind: 'world.snapshot', with: ['Name'] })).rejects.toThrow('viewport-runtime-stale-generation');
    dispose();
  });

  test('projects panel writes onto the canonical editor capability id', async () => {
    const requests: TransportRequest[] = [];
    const dispose = bindViewportRuntimeClient(runtime(5), client((request) => {
      requests.push(request);
      return { jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id: request.id, correlationId: request.correlationId, result: { ok: true } };
    }));
    await dispatchViewportRuntimeOperation('setSelection', { id: 7 });
    expect(requests[0]).toMatchObject({
      scope: 'viewport:edit-runtime:5',
      method: 'run.dispatch',
      params: { operationId: 'editor.setSelection', input: { id: 7 } },
    });
    dispose();
  });

  test('retries the Runtime-owned run without creating a shell run registry', async () => {
    const requests: TransportRequest[] = [];
    const dispose = bindViewportRuntimeClient(runtime(5), client((request) => {
      requests.push(request);
      return { jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id: request.id, correlationId: request.correlationId, result: { ok: true } };
    }));
    await retryViewportRuntimeOperationRun('failed-request', 'retry-request');
    expect(requests[0]).toMatchObject({
      scope: 'viewport:edit-runtime:5',
      method: 'run.retry',
      params: {
        requestId: 'failed-request',
        retryRequestId: 'retry-request',
        actor: { id: 'editor-panel', kind: 'human' },
      },
    });
    dispose();
  });

  test('discovers only a valid Runtime capability manifest', async () => {
    const requests: TransportRequest[] = [];
    const capability = {
      id: 'editor.setSelection',
      kind: 'operation',
      version: '1',
      subject: 'editor',
      verb: 'setSelection',
      inputSchema: { type: 'object' },
      outputSchema: null,
      availability: { available: true },
      preconditions: [],
      recoveryActions: [],
    } as const;
    const dispose = bindViewportRuntimeClient(runtime(6), client((request) => {
      requests.push(request);
      return {
        jsonrpc: '2.0',
        version: TRANSPORT_PROTOCOL_VERSION,
        id: request.id,
        correlationId: request.correlationId,
        result: { capabilityManifest: { capabilities: [capability] } },
      };
    }));
    await expect(discoverViewportRuntimeCapabilities()).resolves.toEqual([capability]);
    expect(requests[0]).toMatchObject({ method: 'discover', params: {} });
    dispose();
  });

  test('routes shell UI mutations through the active Runtime capability', async () => {
    const requests: TransportRequest[] = [];
    const dispose = bindViewportRuntimeClient(runtime(7), client((request) => {
      requests.push(request);
      return {
        jsonrpc: '2.0',
        version: TRANSPORT_PROTOCOL_VERSION,
        id: request.id,
        correlationId: request.correlationId,
        result: { status: 'succeeded' },
      };
    }));
    await expect(dispatchActiveEditorOperation({ kind: 'setSelection', id: 12 })).resolves.toEqual({ ok: true });
    expect(requests[0]).toMatchObject({
      method: 'run.dispatch',
      params: {
        operationId: 'editor.setSelection',
        input: { id: 12 },
        actor: { id: 'editor-human', kind: 'human' },
      },
    });
    dispose();
  });

  test('uses the local Gateway when no Runtime carrier is connected', async () => {
    await expect(dispatchActiveEditorOperation({ kind: 'setSelection', id: 18 })).resolves.toEqual({ ok: true });
    expect(Number(getSelection())).toBe(18);
    await dispatchActiveEditorOperation({ kind: 'setSelection', id: null });
  });

  test('preserves a Runtime operation failure as a structured dispatch result', async () => {
    const dispose = bindViewportRuntimeClient(runtime(8), client((request) => ({
      jsonrpc: '2.0',
      version: TRANSPORT_PROTOCOL_VERSION,
      id: request.id,
      correlationId: request.correlationId,
      result: {
        status: 'failed',
        error: { code: 'operation-failed', hint: 'Runtime rejected the mutation.' },
      },
    })));
    await expect(dispatchActiveEditorOperation({ kind: 'setSelection', id: 19 })).resolves.toEqual({
      ok: false,
      error: { code: 'operation-failed', hint: 'Runtime rejected the mutation.' },
    });
    dispose();
  });
});
