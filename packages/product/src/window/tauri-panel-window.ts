import type { TransportRequest, TransportResponse } from '../contracts/transport';
import { createMessagePortCarrier, type MessagePortCarrier, type TransportMessageEvent, type TransportMessagePort } from '../transport/message-port-carrier';
import type { TransportService } from '../transport/service';
import type { ViewportRuntimeIdentity } from '../contracts/viewport-runtime';
import { PANEL_POPUP_PROTOCOL_VERSION, type PanelPopupIdentity } from './panel-popup';

/** Minimal typed-channel shape supplied by a Tauri host adapter; no Tauri command names live here. */
export interface TauriPanelChannel {
  send(message: unknown): void | Promise<void>;
  subscribe(listener: (message: unknown) => void): () => void;
  close?(): void;
}

export function createTauriPanelTransportPort(channel: TauriPanelChannel): TransportMessagePort {
  const listeners = new Set<(event: TransportMessageEvent) => void>();
  const unsubscribe = channel.subscribe((data) => {
    for (const listener of [...listeners]) listener({ data });
  });
  return {
    postMessage(message) { void channel.send(message); },
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
    close() { unsubscribe(); channel.close?.(); listeners.clear(); },
  };
}

export interface TauriPanelWindowSession {
  readonly channel: TauriPanelChannel;
  close(): void | Promise<void>;
  onClosed(listener: () => void): () => void;
}

export interface TauriPanelWindowHost {
  open(input: { readonly label: string; readonly url: string; readonly title: string }): Promise<TauriPanelWindowSession>;
}

export interface TauriPanelWindowController {
  open(panelId: string, title?: string): Promise<{ ok: true; identity: PanelPopupIdentity } | { ok: false; error: { code: 'tauri-window-unavailable'; hint: string } }>;
  close(panelId: string): Promise<void>;
  isOpen(panelId: string): boolean;
  dispose(): Promise<void>;
}

/** Tauri host adapter over the same editor-transport/v1 request schema used by browser popups. */
export function createTauriPanelWindowController(deps: {
  readonly host: TauriPanelWindowHost;
  readonly appOrigin: string;
  readonly runtime: ViewportRuntimeIdentity;
  readonly forward: (request: TransportRequest) => Promise<TransportResponse>;
  readonly makeToken?: () => string;
  readonly onClosed?: (panelId: string) => void;
}): TauriPanelWindowController {
  const active = new Map<string, { session: TauriPanelWindowSession; carrier: MessagePortCarrier; unlisten: () => void }>();

  async function close(panelId: string): Promise<void> {
    const entry = active.get(panelId);
    if (entry === undefined) return;
    active.delete(panelId);
    entry.unlisten();
    entry.carrier.dispose();
    await entry.session.close();
    deps.onClosed?.(panelId);
  }

  async function open(panelId: string, title = panelId) {
    if (active.has(panelId)) await close(panelId);
    const identity: PanelPopupIdentity = {
      version: PANEL_POPUP_PROTOCOL_VERSION,
      panelId,
      windowId: `panel-${panelId}`,
      token: deps.makeToken?.() ?? crypto.randomUUID(),
      runtime: deps.runtime,
    };
    const url = new URL('/panel-host/', deps.appOrigin);
    url.searchParams.set('panelId', panelId);
    url.searchParams.set('windowId', identity.windowId);
    url.searchParams.set('token', identity.token);
    url.searchParams.set('runtime', JSON.stringify(identity.runtime));
    try {
      const session = await deps.host.open({ label: identity.windowId, url: url.href, title });
      const service = { handle: deps.forward } as TransportService;
      const carrier = createMessagePortCarrier(createTauriPanelTransportPort(session.channel), service);
      const unlisten = session.onClosed(() => {
        const entry = active.get(panelId);
        if (entry?.session !== session) return;
        active.delete(panelId);
        entry.carrier.dispose();
        deps.onClosed?.(panelId);
      });
      active.set(panelId, { session, carrier, unlisten });
      return { ok: true as const, identity };
    } catch (error) {
      return { ok: false as const, error: {
        code: 'tauri-window-unavailable' as const,
        hint: error instanceof Error ? error.message : String(error),
      } };
    }
  }

  return {
    open,
    close,
    isOpen: (panelId) => active.has(panelId),
    async dispose() { for (const panelId of [...active.keys()]) await close(panelId); },
  };
}
