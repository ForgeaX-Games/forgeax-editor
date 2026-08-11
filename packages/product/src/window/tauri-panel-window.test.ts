import { describe, expect, test } from 'bun:test';
import type { TransportRequest, TransportResponse } from '../contracts/transport';
import { createMessagePortTransportClient } from '../transport/message-port-carrier';
import {
  createTauriPanelTransportPort,
  createTauriPanelWindowController,
  type TauriPanelChannel,
} from './tauri-panel-window';

function channelPair(): readonly [TauriPanelChannel, TauriPanelChannel] {
  const listeners: [Set<(message: unknown) => void>, Set<(message: unknown) => void>] = [
    new Set<(message: unknown) => void>(),
    new Set<(message: unknown) => void>(),
  ];
  const channel = (own: 0 | 1, peer: 0 | 1): TauriPanelChannel => ({
    send(message) { queueMicrotask(() => { for (const listener of [...listeners[peer]]) listener(message); }); },
    subscribe(listener) { listeners[own].add(listener); return () => listeners[own].delete(listener); },
    close() { listeners[own].clear(); },
  });
  return [channel(0, 1), channel(1, 0)];
}

describe('Tauri Panel window adapter', () => {
  test('uses the canonical transport request without a Tauri-specific command table', async () => {
    const [hostChannel, childChannel] = channelPair();
    const forwarded: string[] = [];
    let notifyClosed = () => {};
    const controller = createTauriPanelWindowController({
      appOrigin: 'tauri://localhost',
      runtime: {
        version: 'viewport-runtime/v1', runtimeId: 'runtime-a', runtimeGeneration: 3,
        carrierId: 'viewport-a', carrierKind: 'tauri-webview',
      },
      host: {
        async open() {
          return {
            channel: hostChannel,
            close() {},
            onClosed(listener) { notifyClosed = listener; return () => { notifyClosed = () => {}; }; },
          };
        },
      },
      forward: async (request: TransportRequest): Promise<TransportResponse> => {
        forwarded.push(request.method);
        return { ...request, result: { sameSchema: true } };
      },
      makeToken: () => 'tauri-token',
    });
    expect((await controller.open('inspector')).ok).toBe(true);
    const client = createMessagePortTransportClient(createTauriPanelTransportPort(childChannel), { defaultTimeoutMs: 500 });
    const response = await client.request({
      jsonrpc: '2.0', version: 'editor-transport/v1', id: 't1', correlationId: 't1',
      scope: 'viewport:runtime-a:3', method: 'run.dispatch', params: { operationId: 'editor.setComponent' },
    });
    expect(response.result).toEqual({ sameSchema: true });
    expect(forwarded).toEqual(['run.dispatch']);
    notifyClosed();
    expect(controller.isOpen('inspector')).toBe(false);
    client.dispose();
    await controller.dispose();
  });

  test('closes an owned session explicitly and reports host-open failures', async () => {
    const [hostChannel] = channelPair();
    const events: string[] = [];
    const controller = createTauriPanelWindowController({
      appOrigin: 'tauri://localhost',
      runtime: {
        version: 'viewport-runtime/v1', runtimeId: 'runtime-b', runtimeGeneration: 4,
        carrierId: 'viewport-b', carrierKind: 'tauri-webview',
      },
      host: {
        async open() {
          return {
            channel: hostChannel,
            close() { events.push('session:close'); },
            onClosed() { return () => events.push('session:unlisten'); },
          };
        },
      },
      forward: async (request) => ({ ...request, result: null }),
      onClosed: (panelId) => events.push(`closed:${panelId}`),
    });
    expect((await controller.open('history')).ok).toBe(true);
    await controller.close('history');
    await controller.close('history');
    expect(events).toEqual(['session:unlisten', 'session:close', 'closed:history']);
    expect(controller.isOpen('history')).toBe(false);

    const unavailable = createTauriPanelWindowController({
      appOrigin: 'tauri://localhost',
      runtime: {
        version: 'viewport-runtime/v1', runtimeId: 'runtime-b', runtimeGeneration: 4,
        carrierId: 'viewport-b', carrierKind: 'tauri-webview',
      },
      host: { async open() { throw new Error('webview unavailable'); } },
      forward: async (request) => ({ ...request, result: null }),
    });
    expect(await unavailable.open('history')).toEqual({
      ok: false,
      error: { code: 'tauri-window-unavailable', hint: 'webview unavailable' },
    });
  });
});
