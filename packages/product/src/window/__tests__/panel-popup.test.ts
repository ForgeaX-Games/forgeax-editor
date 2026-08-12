import { describe, expect, test } from 'bun:test';
import type { TransportRequest, TransportResponse } from '../../contracts/transport';
import { createMessagePortTransportClient } from '../../transport/message-port-carrier';
import {
  createBrowserPanelPopupController,
  installPanelPopupClient,
  readPanelPopupIdentity,
  type PanelPopupIdentity,
  type PanelPopupMessageEvent,
  type PanelPopupWindow,
} from '../panel-popup';

class FakeEventTarget {
  readonly listeners = new Set<(event: PanelPopupMessageEvent) => void>();
  addEventListener(_type: 'message', listener: (event: PanelPopupMessageEvent) => void): void { this.listeners.add(listener); }
  removeEventListener(_type: 'message', listener: (event: PanelPopupMessageEvent) => void): void { this.listeners.delete(listener); }
  emit(event: PanelPopupMessageEvent): void { for (const listener of [...this.listeners]) listener(event); }
}

describe('browser Panel popup controller', () => {
  const runtime = {
    version: 'viewport-runtime/v1', runtimeId: 'runtime-a', runtimeGeneration: 1,
    carrierId: 'viewport-a', carrierKind: 'iframe',
  } as const;

  test('fails closed when the browser blocks the popup', async () => {
    const events = new FakeEventTarget();
    const controller = createBrowserPanelPopupController({
      eventTarget: events,
      origin: 'https://editor.test',
      runtime,
      openWindow: () => null,
      createChannel: () => new MessageChannel(),
      forward: async (request) => ({ ...request, result: null }),
      makeToken: () => 'token-a',
    });
    expect(await controller.open('hierarchy')).toEqual({
      ok: false,
      error: { code: 'popup-blocked', hint: 'The browser blocked the panel popup; the docked panel remains active.' },
    });
    expect(controller.isOpen('hierarchy')).toBe(false);
  });

  test('times out an unauthenticated popup and closes the disposable window', async () => {
    const events = new FakeEventTarget();
    let closed = false;
    const controller = createBrowserPanelPopupController({
      eventTarget: events,
      origin: 'https://editor.test',
      runtime,
      openWindow: () => ({
        get closed() { return closed; },
        close() { closed = true; },
        postMessage() {},
      }),
      createChannel: () => new MessageChannel(),
      forward: async (request) => ({ ...request, result: null }),
      makeToken: () => 'token-timeout',
      timeoutMs: 1,
    });

    expect(await controller.open('history')).toEqual({
      ok: false,
      error: { code: 'popup-handshake-timeout', hint: 'The panel popup did not complete its authenticated handshake.' },
    });
    expect(closed).toBe(true);
    expect(events.listeners.size).toBe(0);
  });

  test('relays the canonical transport and drops the disposable popup cache on close', async () => {
    const events = new FakeEventTarget();
    let popupClient: ReturnType<typeof createMessagePortTransportClient> | null = null;
    const closed: string[] = [];
    const forwarded: string[] = [];
    const popup: PanelPopupWindow = {
      closed: false,
      close() { (this as { closed: boolean }).closed = true; },
      postMessage(message, _origin, transfer) {
        const wire = message as { type: string; identity: unknown };
        if (wire.type !== 'FORGEAX_PANEL_POPUP_CONNECT') return;
        popupClient = createMessagePortTransportClient(transfer?.[0] as MessagePort, { defaultTimeoutMs: 500 });
        queueMicrotask(() => events.emit({
          data: { type: 'FORGEAX_PANEL_POPUP_CONNECTED', identity: wire.identity },
          origin: 'https://editor.test',
          source: popup,
          ports: [],
        }));
      },
    };
    const controller = createBrowserPanelPopupController({
      eventTarget: events,
      origin: 'https://editor.test',
      runtime,
      openWindow: () => popup,
      createChannel: () => new MessageChannel(),
      forward: async (request: TransportRequest): Promise<TransportResponse> => {
        forwarded.push(request.method);
        return { ...request, result: { relayed: true } };
      },
      makeToken: () => 'token-b',
      pollClosedMs: 5,
      onClosed: (panelId) => closed.push(panelId),
    });
    const opening = controller.open('inspector');
    await Promise.resolve();
    events.emit({
      data: {
        type: 'FORGEAX_PANEL_POPUP_READY',
        identity: { version: 'panel-popup/v1', panelId: 'inspector', windowId: 'panel-inspector', token: 'token-b', runtime },
      },
      origin: 'https://editor.test',
      source: popup,
      ports: [],
    });
    const opened = await opening;
    expect(opened.ok).toBe(true);
    expect(controller.isOpen('inspector')).toBe(true);
    expect(await controller.open('inspector')).toEqual(opened);

    const response = await popupClient!.request({
      jsonrpc: '2.0', version: 'editor-transport/v1', id: 'p1', correlationId: 'p1',
      scope: 'viewport:runtime:1', method: 'query', params: { kind: 'inspector.selection' },
    });
    expect(response.result).toEqual({ relayed: true });
    expect(forwarded).toEqual(['query']);

    (popup as { closed: boolean }).closed = true;
    await Bun.sleep(15);
    expect(controller.isOpen('inspector')).toBe(false);
    expect(closed).toEqual(['inspector']);
    popupClient!.dispose();
    controller.dispose();
  });

  test('installs the popup-side authenticated client and parses only complete identities', () => {
    const events = new FakeEventTarget();
    const sent: unknown[] = [];
    const opener: PanelPopupWindow = {
      closed: false,
      close() {},
      postMessage(message) { sent.push(message); },
    };
    const identity: PanelPopupIdentity = {
      version: 'panel-popup/v1', panelId: 'inspector', windowId: 'panel-inspector', token: 'token-client', runtime,
    };
    const clients: ReturnType<typeof createMessagePortTransportClient>[] = [];
    const dispose = installPanelPopupClient({
      eventTarget: events,
      opener,
      origin: 'https://editor.test',
      identity,
      onClient: (client) => clients.push(client),
    });
    expect((sent[0] as { type: string }).type).toBe('FORGEAX_PANEL_POPUP_READY');

    const channel = new MessageChannel();
    events.emit({
      data: { type: 'FORGEAX_PANEL_POPUP_CONNECT', identity },
      origin: 'https://editor.test',
      source: opener,
      ports: [channel.port1],
    });
    expect(clients).toHaveLength(1);
    expect((sent[1] as { type: string }).type).toBe('FORGEAX_PANEL_POPUP_CONNECTED');

    const params = new URLSearchParams({
      panelId: identity.panelId,
      windowId: identity.windowId,
      token: identity.token,
      runtime: JSON.stringify(identity.runtime),
    });
    expect(readPanelPopupIdentity(`?${params}`)).toEqual(identity);
    expect(readPanelPopupIdentity('?panelId=inspector&runtime=not-json')).toBeNull();
    dispose();
    channel.port2.close();
    expect(events.listeners.size).toBe(0);
  });
});
