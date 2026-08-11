import { useEffect, useRef, useState, type ReactElement } from 'react';
import { getLocale, subscribeLocale } from '@/i18n';
import { useHost } from '../../core/app-shell';
import type { ContentBrowserRevealTarget } from '../../core/app-shell/types';
import { requestComposerInsert } from '../../lib/composer-bridge';
import { removeExtensionSurfaces, upsertSurface } from '../../lib/surface-store';
import { isTrustedMessageOrigin } from '../../lib/trustedOrigins';
import { usePanelRenderers, type ExtensionPort } from '../DockShell/panelRenderers';

// The Content Browser lives in the global footer under this id (see
// DockShell/builtinWorkbenches GLOBAL_FOOTER_EXTRA_IDS).
const CONTENT_BROWSER_PANEL_ID = 'ep:assets';

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

// Sanitize an untrusted iframe payload into the neutral reveal contract. A
// target without an identity is dropped (the Content Browser would no-op).
function revealTargetFromMessage(raw: unknown): ContentBrowserRevealTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;
  const path = str(r.path);
  const guid = str(r.guid);
  if (!path && !guid) return null;
  const packPath = str(r.packPath);
  const assetKind = str(r.assetKind);
  const name = str(r.name);
  return {
    ...(guid ? { guid } : {}),
    ...(path ? { path, pathKind: r.pathKind === 'dir' ? 'dir' as const : 'file' as const } : {}),
    ...(packPath ? { packPath } : {}),
    ...(assetKind ? { assetKind } : {}),
    ...(name ? { name } : {}),
  };
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
  const host = useHost();
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
        target?: unknown;
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
      // Plugin → host "locate this file in the Content Browser". Mirrors the
      // editor page tab's locate action: reveal the footer panel first (it may be
      // a collapsed drawer), then hand the target to whichever Content Browser is
      // mounted over the neutral bus. The double rAF gives a freshly-expanded
      // drawer a frame to mount + subscribe before the target arrives.
      if (d.type === 'FORGEAX_CONTENT_BROWSER_REVEAL') {
        const target = revealTargetFromMessage(d.target);
        if (!target) return;
        void host.commands
          .execute('app.panel.reveal', { id: CONTENT_BROWSER_PANEL_ID })
          .catch(() => {})
          .finally(() => {
            requestAnimationFrame(() => requestAnimationFrame(() => {
              host.bus.emit('content-browser:reveal', { target });
            }));
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
  }, [extensionId, src, pane, createExtensionPort, createWindowTransport, onNavigate, onChatPost, onToolCall, host]);

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
