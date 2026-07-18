import { useEffect, useRef, useState, type ReactElement } from 'react';
import { getLocale, subscribeLocale } from '@/i18n';
import { requestComposerInsert } from '../../lib/composer-bridge';
import { removeExtensionSurfaces, upsertSurface } from '../../lib/surface-store';
import { isTrustedMessageOrigin } from '../../lib/trustedOrigins';
import { usePanelRenderers, type ExtensionPort } from '../DockShell/panelRenderers';

export interface ExtensionIframeHostProps {
  extensionId: string;
  src: string;
  pane?: 'left' | 'center';
  active?: boolean;
  onNavigate?: (targetPluginId: string, payload?: Record<string, unknown>) => void;
  onChatPost?: (event: { text: string; attachments?: unknown[] }) => void;
  onToolCall?: (call: { toolId: string; args?: unknown }) => Promise<
    | { ok: true; result?: unknown }
    | { ok: false; error: string; code?: string }
  >;
  loadErrorText: (error: string) => string;
}

export function ExtensionIframeHost({
  extensionId,
  src,
  pane,
  active = true,
  onNavigate,
  onChatPost,
  onToolCall,
  loadErrorText,
}: ExtensionIframeHostProps): ReactElement {
  const { hostSDK } = usePanelRenderers();
  const createExtensionPort = hostSDK?.createExtensionPort;
  const createWindowTransport = hostSDK?.createWindowTransport;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string | null>(null);
  const portRef = useRef<ExtensionPort | null>(null);
  const activeRef = useRef(active);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !src) return;
    if (!createExtensionPort || !createWindowTransport) return;
    let port: ExtensionPort | null = null;

    const onRawMessage = (ev: MessageEvent) => {
      if (ev.source !== iframe.contentWindow) return;
      if (!isTrustedMessageOrigin(ev.origin)) return;
      const d = ev.data as {
        type?: string;
        targetPluginId?: string;
        payload?: Record<string, unknown>;
        text?: string;
      } | null;
      if (!d) return;
      if (d.type === 'FORGEAX_NAVIGATE' && d.targetPluginId) {
        onNavigate?.(d.targetPluginId, d.payload);
        return;
      }
      // Plugin → host chat composer prefill (e.g. wb-game-video「添加到对话」).
      // Prefills the caret without auto-sending; the author reviews then sends.
      if (d.type === 'FORGEAX_COMPOSER_INSERT' && typeof d.text === 'string' && d.text.trim()) {
        const text = d.text.trim();
        requestComposerInsert({
          kind: 'paste',
          display: text.length > 48 ? `${text.slice(0, 48)}…` : text,
          detail: text,
          tooltip: {
            title: text.length > 64 ? `${text.slice(0, 64)}…` : text,
            lines: [text.length > 200 ? `${text.slice(0, 200)}…` : text],
          },
        });
        return;
      }
    };
    window.addEventListener('message', onRawMessage);

    const onLoad = () => {
      const win = iframe.contentWindow;
      if (!win) {
        setError('iframe contentWindow unavailable');
        return;
      }
      const transport = createWindowTransport({
        target: win,
        targetOrigin: '*',
        expectedSource: () => iframe.contentWindow,
      });
      port = createExtensionPort({
        extensionId,
        transport,
        initial: {
          locale: getLocale(),
          theme: 'dark',
          pane: pane ?? 'center',
        },
        onInvalid: (_, reason) => {
          if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.warn('[ExtensionIframeHost] invalid envelope:', reason);
          }
        },
      });

      if (onChatPost) port.onChat(onChatPost);
      if (onToolCall) port.onToolCall(onToolCall);
      port.surface.subscribe((s) => {
        upsertSurface({
          extensionId,
          surfaceId: s.surfaceId,
          actions: s.actions,
          snapshot: s.snapshot,
          updatedAt: Date.now(),
        });
      });
      if (onNavigate) port.onNavigate((e) => onNavigate(e.targetPluginId, e.payload));

      portRef.current = port;
      port.setVisibility(activeRef.current);
    };

    iframe.addEventListener('load', onLoad);
    return () => {
      iframe.removeEventListener('load', onLoad);
      window.removeEventListener('message', onRawMessage);
      port?.close();
      portRef.current = null;
      removeExtensionSurfaces(extensionId);
    };
  }, [extensionId, src, pane, createExtensionPort, createWindowTransport, onNavigate, onChatPost, onToolCall]);

  useEffect(() => {
    activeRef.current = active;
    portRef.current?.setVisibility(active);
  }, [active]);

  // Host locale → keep-alive plugin iframes (SDK theme.changed + legacy postMessage).
  useEffect(() => {
    return subscribeLocale((loc) => {
      portRef.current?.setTheme({ locale: loc });
      const win = iframeRef.current?.contentWindow;
      if (win) {
        win.postMessage({ type: 'forgeax:locale-changed', locale: loc }, '*');
      }
    });
  }, []);

  return (
    <div
      className="wb-plugin-iframe-wrap"
      data-active={active ? 'true' : 'false'}
      style={active ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
      aria-hidden={active ? undefined : true}
    >
      {error ? <div style={{ padding: 20, color: '#c44' }}>{loadErrorText(error)}</div> : null}
      <iframe
        ref={iframeRef}
        src={src}
        title={extensionId}
        style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
      />
    </div>
  );
}
