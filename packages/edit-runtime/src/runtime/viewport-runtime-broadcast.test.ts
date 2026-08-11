import { describe, expect, test } from 'bun:test';
import {
  TRANSPORT_PROTOCOL_VERSION,
  VIEWPORT_RUNTIME_CONTRACT_VERSION,
  type TransportRequest,
  type TransportService,
  type ViewportRuntimeIdentity,
} from '@forgeax/editor-product';
import {
  createBroadcastViewportRuntimeClient,
  installBroadcastViewportRuntimeHost,
  subscribeBroadcastViewportRuntimeReady,
} from './viewport-runtime-broadcast';

interface TestChannel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  close(): void;
}

function createChannelHub(): () => TestChannel {
  const endpoints = new Set<{
    readonly listeners: Set<(event: MessageEvent<unknown>) => void>;
    closed: boolean;
  }>();
  return () => {
    const endpoint = { listeners: new Set<(event: MessageEvent<unknown>) => void>(), closed: false };
    endpoints.add(endpoint);
    return {
      postMessage(message): void {
        for (const peer of endpoints) {
          if (peer === endpoint || peer.closed) continue;
          const event = { data: message } as MessageEvent<unknown>;
          queueMicrotask(() => {
            for (const listener of peer.listeners) listener(event);
          });
        }
      },
      addEventListener(_type, listener): void { endpoint.listeners.add(listener); },
      removeEventListener(_type, listener): void { endpoint.listeners.delete(listener); },
      close(): void { endpoint.closed = true; endpoints.delete(endpoint); },
    };
  };
}

const runtime: ViewportRuntimeIdentity = {
  version: VIEWPORT_RUNTIME_CONTRACT_VERSION,
  runtimeId: 'edit-runtime',
  runtimeGeneration: 8,
  carrierId: 'tauri-window-8',
  carrierKind: 'tauri-webview',
};

const request: TransportRequest = {
  jsonrpc: '2.0',
  version: TRANSPORT_PROTOCOL_VERSION,
  id: 'request-1',
  correlationId: 'request-1',
  scope: 'viewport:edit-runtime:8',
  method: 'query',
  params: { kind: 'viewport.status' },
};

describe('Tauri Viewport Runtime broadcast carrier', () => {
  test('discovers the live generation and carries the canonical service response', async () => {
    const createChannel = createChannelHub();
    const seen: ViewportRuntimeIdentity[] = [];
    const unsubscribe = subscribeBroadcastViewportRuntimeReady((identity) => seen.push(identity), { createChannel });
    const service = {
      handle: async (received: TransportRequest) => ({
        jsonrpc: '2.0',
        version: TRANSPORT_PROTOCOL_VERSION,
        id: received.id,
        correlationId: received.correlationId,
        result: { status: 'ready' },
      }),
    } as never as TransportService;
    const disposeHost = installBroadcastViewportRuntimeHost({ runtime, service, createChannel });
    const client = createBroadcastViewportRuntimeClient({ runtime, createChannel, timeoutMs: 100 });

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(seen).toEqual([runtime]);
    await expect(client.request(request)).resolves.toMatchObject({ result: { status: 'ready' } });

    client.dispose();
    disposeHost();
    unsubscribe();
  });

  test('fences another generation and rejects requests after disposal', async () => {
    const createChannel = createChannelHub();
    const stale = { ...runtime, runtimeGeneration: 7, carrierId: 'tauri-window-7' };
    const disposeHost = installBroadcastViewportRuntimeHost({
      runtime: stale,
      service: { handle: async () => { throw new Error('stale service must not run'); } } as never,
      createChannel,
    });
    const client = createBroadcastViewportRuntimeClient({ runtime, createChannel, timeoutMs: 5 });
    await expect(client.request(request)).rejects.toThrow('viewport-runtime-request-timeout');
    client.dispose();
    await expect(client.request(request)).rejects.toThrow('viewport-runtime-client-disposed');
    disposeHost();
  });
});
