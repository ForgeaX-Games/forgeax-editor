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
  cancelViewportRuntimeOperationRun,
  discoverViewportRuntimeCapabilities,
  dispatchViewportRuntimeOperation,
  getViewportRuntimeClientSnapshot,
  getViewportRuntimeSelectionSnapshot,
  getViewportRuntimeOperationRun,
  queryViewportRuntimeProjection,
  retryViewportRuntimeOperationRun,
  waitViewportRuntimeOperationRun,
} from '../viewport-runtime-client';
import { dispatchActiveEditorOperation } from '../../store/active-operation';

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
    expect(getViewportRuntimeClientSnapshot()).toEqual({ status: 'disconnected', runtime: null, catalogRoots: null });
  });

  test('publishes the active runtime catalog-root projection with its generation', () => {
    const catalogRoots = [{ root: 'assets', catalogPrefix: 'host-games/fps/assets' }] as const;
    const dispose = bindViewportRuntimeClient(runtime(3), client(() => ({})), catalogRoots);
    expect(getViewportRuntimeClientSnapshot()).toMatchObject({
      status: 'ready',
      runtime: { runtimeGeneration: 3 },
      catalogRoots,
    });
    dispose();
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

  test('does not let a late old-generation query overwrite a replacement Runtime', async () => {
    let resolveOld!: (value: unknown) => void;
    const oldResponse = new Promise((resolve) => { resolveOld = resolve; });
    const disposeOld = bindViewportRuntimeClient(runtime(11), client(() => oldResponse));
    const pending = queryViewportRuntimeProjection({ kind: 'selection.current' });
    const disposeNew = bindViewportRuntimeClient(runtime(12), client(() => ({})));
    resolveOld({
      jsonrpc: '2.0',
      version: TRANSPORT_PROTOCOL_VERSION,
      id: 'late',
      correlationId: 'late',
      result: {
        version: VIEWPORT_RUNTIME_CONTRACT_VERSION,
        runtime: runtime(11),
        revision: 1,
        status: 'ready',
        value: { entityIds: [99], assets: [], paths: [], lastDomain: 'entity' },
      },
    });
    await expect(pending).rejects.toThrow('viewport-runtime-stale-generation');
    expect(getViewportRuntimeClientSnapshot()).toMatchObject({ runtime: { runtimeGeneration: 12 } });
    disposeOld();
    disposeNew();
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

  test('gets, waits, and cancels the Runtime-owned run through the same transport', async () => {
    const requests: TransportRequest[] = [];
    const dispose = bindViewportRuntimeClient(runtime(9), client((request) => {
      requests.push(request);
      return { jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id: request.id, correlationId: request.correlationId, result: { status: 'running' } };
    }));
    await getViewportRuntimeOperationRun('asset-run');
    await waitViewportRuntimeOperationRun('asset-run');
    await cancelViewportRuntimeOperationRun('asset-run');
    expect(requests.map((request) => [request.method, request.params])).toEqual([
      ['run.get', { requestId: 'asset-run' }],
      ['run.wait', { requestId: 'asset-run' }],
      ['run.cancel', { requestId: 'asset-run' }],
    ]);
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

  test('refreshes selection from Runtime authority and clears it on disconnect', async () => {
    const selected = {
      entityIds: [],
      assets: [{ guid: 'material-1', kind: 'material', name: 'Material 1', packPath: 'assets/material.pack.json' }],
      paths: [],
      lastDomain: 'asset',
    } as const;
    const dispose = bindViewportRuntimeClient(runtime(10), client((request) => request.method === 'query'
      ? {
          jsonrpc: '2.0',
          version: TRANSPORT_PROTOCOL_VERSION,
          id: request.id,
          correlationId: request.correlationId,
          result: {
            version: VIEWPORT_RUNTIME_CONTRACT_VERSION,
            runtime: runtime(10),
            revision: 1,
            status: 'ready',
            value: selected,
          },
        }
      : {
          jsonrpc: '2.0',
          version: TRANSPORT_PROTOCOL_VERSION,
          id: request.id,
          correlationId: request.correlationId,
          result: { status: 'succeeded' },
        }));

    await expect(dispatchActiveEditorOperation({
      kind: 'setAssetSelectionOne',
      asset: { ...selected.assets[0], payload: {} },
    })).resolves.toEqual({ ok: true });
    expect(getViewportRuntimeSelectionSnapshot()).toEqual(selected);

    dispose();
    expect(getViewportRuntimeSelectionSnapshot()).toEqual({
      entityIds: [], assets: [], paths: [], lastDomain: null,
    });
  });

  test('fails closed instead of promoting the shell Gateway when disconnected', async () => {
    await expect(dispatchActiveEditorOperation({ kind: 'setSelection', id: 18 })).resolves.toEqual({
      ok: false,
      error: {
        code: 'operation-failed',
        hint: 'Viewport Runtime is disconnected; reconnect before retrying the operation.',
      },
    });
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
