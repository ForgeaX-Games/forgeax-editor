import type { TransportRequest, TransportResponse } from '../contracts/transport';
import {
  createMessagePortCarrier,
  createMessagePortTransportClient,
  type MessagePortCarrier,
  type MessagePortTransportClient,
  type TransportMessagePort,
} from '../transport/message-port-carrier';
import type { TransportService } from '../transport/service';
import { isCurrentViewportRuntime, isViewportRuntimeIdentity, type ViewportRuntimeIdentity } from '../contracts/viewport-runtime';

export const PANEL_POPUP_PROTOCOL_VERSION = 'panel-popup/v1' as const;

export interface PanelPopupIdentity {
  readonly version: typeof PANEL_POPUP_PROTOCOL_VERSION;
  readonly panelId: string;
  readonly windowId: string;
  readonly token: string;
  readonly runtime: ViewportRuntimeIdentity;
}

export interface PanelPopupWindow {
  postMessage(message: unknown, targetOrigin: string, transfer?: readonly Transferable[]): void;
  readonly closed: boolean;
  close(): void;
}

export interface PanelPopupMessageEvent {
  readonly data: unknown;
  readonly origin: string;
  readonly source: PanelPopupWindow | null;
  readonly ports: readonly TransportMessagePort[];
}

export interface PanelPopupEventTarget {
  addEventListener(type: 'message', listener: (event: PanelPopupMessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: PanelPopupMessageEvent) => void): void;
}

export type PanelPopupOpenResult =
  | { readonly ok: true; readonly identity: PanelPopupIdentity }
  | { readonly ok: false; readonly error: { readonly code: 'popup-blocked' | 'popup-handshake-timeout'; readonly hint: string } };

export interface BrowserPanelPopupControllerDeps {
  readonly eventTarget: PanelPopupEventTarget;
  readonly origin: string;
  readonly runtime: ViewportRuntimeIdentity;
  readonly openWindow: (url: string, name: string, features: string) => PanelPopupWindow | null;
  readonly createChannel: () => { readonly port1: TransportMessagePort; readonly port2: TransportMessagePort };
  readonly forward: (request: TransportRequest) => Promise<TransportResponse>;
  readonly makeToken?: () => string;
  readonly timeoutMs?: number;
  readonly pollClosedMs?: number;
  readonly onClosed?: (panelId: string) => void;
}

export interface BrowserPanelPopupController {
  open(panelId: string, title?: string): Promise<PanelPopupOpenResult>;
  close(panelId: string): void;
  isOpen(panelId: string): boolean;
  dispose(): void;
}

type PopupWireMessage = {
  readonly type: 'FORGEAX_PANEL_POPUP_READY' | 'FORGEAX_PANEL_POPUP_CONNECT' | 'FORGEAX_PANEL_POPUP_CONNECTED';
  readonly identity: PanelPopupIdentity;
};

function isIdentity(value: unknown): value is PanelPopupIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<PanelPopupIdentity>;
  return row.version === PANEL_POPUP_PROTOCOL_VERSION
    && typeof row.panelId === 'string' && row.panelId.length > 0
    && typeof row.windowId === 'string' && row.windowId.length > 0
    && typeof row.token === 'string' && row.token.length > 0
    && isViewportRuntimeIdentity(row.runtime);
}

function readWireMessage(value: unknown): PopupWireMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as { type?: unknown; identity?: unknown };
  if (row.type !== 'FORGEAX_PANEL_POPUP_READY'
    && row.type !== 'FORGEAX_PANEL_POPUP_CONNECT'
    && row.type !== 'FORGEAX_PANEL_POPUP_CONNECTED') return null;
  return isIdentity(row.identity) ? { type: row.type, identity: row.identity } : null;
}

function sameIdentity(a: PanelPopupIdentity, b: PanelPopupIdentity): boolean {
  return a.version === b.version && a.panelId === b.panelId && a.windowId === b.windowId && a.token === b.token
    && isCurrentViewportRuntime(a.runtime, b.runtime)
    && a.runtime.carrierId === b.runtime.carrierId && a.runtime.carrierKind === b.runtime.carrierKind;
}

function relayService(forward: BrowserPanelPopupControllerDeps['forward']): TransportService {
  return { handle: forward } as TransportService;
}

/** Browser popup adapter. It relays the existing Runtime transport; it owns no panel or scene facts. */
export function createBrowserPanelPopupController(deps: BrowserPanelPopupControllerDeps): BrowserPanelPopupController {
  const active = new Map<string, { identity: PanelPopupIdentity; window: PanelPopupWindow; carrier: MessagePortCarrier; poll: ReturnType<typeof setInterval> }>();
  const timeoutMs = deps.timeoutMs ?? 5_000;

  function close(panelId: string): void {
    const entry = active.get(panelId);
    if (entry === undefined) return;
    active.delete(panelId);
    clearInterval(entry.poll);
    entry.carrier.dispose();
    if (!entry.window.closed) entry.window.close();
    deps.onClosed?.(panelId);
  }

  async function open(panelId: string, title = panelId): Promise<PanelPopupOpenResult> {
    const existing = active.get(panelId);
    if (existing !== undefined && !existing.window.closed) {
      return { ok: true, identity: existing.identity };
    }
    if (existing !== undefined) close(panelId);

    const identity: PanelPopupIdentity = {
      version: PANEL_POPUP_PROTOCOL_VERSION,
      panelId,
      windowId: `panel-${panelId}`,
      token: deps.makeToken?.() ?? crypto.randomUUID(),
      runtime: deps.runtime,
    };
    const url = new URL('/panel-host/', deps.origin);
    url.searchParams.set('panelId', panelId);
    url.searchParams.set('windowId', identity.windowId);
    url.searchParams.set('token', identity.token);
    url.searchParams.set('hostOrigin', deps.origin);
    url.searchParams.set('runtime', JSON.stringify(identity.runtime));
    let popup: PanelPopupWindow | null = null;
    let finishBlocked = () => {};
    const handshake = new Promise<PanelPopupOpenResult>((resolve) => {
      let settled = false;
      let carrier: MessagePortCarrier | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: PanelPopupOpenResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        deps.eventTarget.removeEventListener('message', onMessage);
        if (!result.ok) {
          carrier?.dispose();
          if (popup !== null && !popup.closed) popup.close();
        }
        resolve(result);
      };
      const onMessage = (event: PanelPopupMessageEvent): void => {
        const current = popup;
        if (current === null || event.source !== current || event.origin !== deps.origin) return;
        const message = readWireMessage(event.data);
        if (message === null || !sameIdentity(identity, message.identity)) return;
        if (message.type === 'FORGEAX_PANEL_POPUP_READY') {
          const channel = deps.createChannel();
          carrier = createMessagePortCarrier(channel.port1, relayService(deps.forward));
          current.postMessage({ type: 'FORGEAX_PANEL_POPUP_CONNECT', identity }, deps.origin, [channel.port2 as unknown as Transferable]);
          return;
        }
        if (message.type !== 'FORGEAX_PANEL_POPUP_CONNECTED' || carrier === null) return;
        const poll = setInterval(() => {
          if (!current.closed) return;
          const entry = active.get(panelId);
          if (entry === undefined || entry.window !== current) return;
          active.delete(panelId);
          clearInterval(entry.poll);
          entry.carrier.dispose();
          deps.onClosed?.(panelId);
        }, deps.pollClosedMs ?? 250);
        active.set(panelId, { identity, window: current, carrier, poll });
        finish({ ok: true, identity });
      };
      deps.eventTarget.addEventListener('message', onMessage);
      finishBlocked = () => finish({
        ok: false,
        error: { code: 'popup-blocked', hint: 'The browser blocked the panel popup; the docked panel remains active.' },
      });
      timer = setTimeout(() => finish({
        ok: false,
        error: { code: 'popup-handshake-timeout', hint: 'The panel popup did not complete its authenticated handshake.' },
      }), timeoutMs);
    });
    popup = deps.openWindow(url.href, identity.windowId, 'popup,width=480,height=680');
    if (popup === null) {
      finishBlocked();
    }
    return handshake;
  }

  return {
    open,
    close,
    isOpen: (panelId) => active.has(panelId),
    dispose() { for (const panelId of [...active.keys()]) close(panelId); },
  };
}

export interface PanelPopupClientDeps {
  readonly eventTarget: PanelPopupEventTarget;
  readonly opener: PanelPopupWindow;
  readonly origin: string;
  readonly identity: PanelPopupIdentity;
  readonly onClient: (client: MessagePortTransportClient) => void;
}

/** Popup-side handshake. Cache lifetime equals the popup window lifetime. */
export function installPanelPopupClient(deps: PanelPopupClientDeps): () => void {
  let client: MessagePortTransportClient | null = null;
  const onMessage = (event: PanelPopupMessageEvent): void => {
    if (event.source !== deps.opener || event.origin !== deps.origin) return;
    const message = readWireMessage(event.data);
    if (message?.type !== 'FORGEAX_PANEL_POPUP_CONNECT' || !sameIdentity(deps.identity, message.identity)) return;
    const port = event.ports[0];
    if (port === undefined || client !== null) return;
    client = createMessagePortTransportClient(port, { defaultTimeoutMs: 5_000 });
    deps.onClient(client);
    deps.opener.postMessage({ type: 'FORGEAX_PANEL_POPUP_CONNECTED', identity: deps.identity }, deps.origin);
  };
  deps.eventTarget.addEventListener('message', onMessage);
  deps.opener.postMessage({ type: 'FORGEAX_PANEL_POPUP_READY', identity: deps.identity }, deps.origin);
  return () => {
    deps.eventTarget.removeEventListener('message', onMessage);
    client?.dispose();
  };
}

export function readPanelPopupIdentity(search: string): PanelPopupIdentity | null {
  const params = new URLSearchParams(search);
  const candidate = {
    version: PANEL_POPUP_PROTOCOL_VERSION,
    panelId: params.get('panelId'),
    windowId: params.get('windowId'),
    token: params.get('token'),
    runtime: (() => {
      const raw = params.get('runtime');
      if (raw === null) return null;
      try { return JSON.parse(raw) as unknown; } catch { return null; }
    })(),
  };
  return isIdentity(candidate) ? candidate : null;
}
