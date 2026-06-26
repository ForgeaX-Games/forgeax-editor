// EditorPanelFrame — renders one editor-runtime panel (Hierarchy / Inspector /
// Assets / Material / Timeline / etc.) as an iframe inside an outer DockShell
// panel at the SAME level as ChatPanel / Workbench / Preview.
//
// Architecture (design §flat-dock):
//   Viewport iframe  = /editor/?viewportOnly=1&scene=<slug>
//                      boots the engine + EditorBus; is the BroadcastChannel "main"
//   Panel  iframes   = /editor/?panel=X&scene=<slug>
//                      no engine, mirrors the bus via BroadcastChannel "panel" role
//
// This brings Hierarchy / Inspector / Timeline etc. to the outer dockview level
// so they can be freely docked alongside ChatPanel, Preview, Workbench — and the
// viewport gets its own full panel with maximum space.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/i18n';
import { useAppStore } from '../../store';
import { requestReloadSlot } from '../../lib/reload-coordinator';

export type EditorPanelId =
  | 'hierarchy' | 'assets' | 'inspector' | 'history'
  | 'capabilities' | 'material' | 'timeline' | 'matgraph' | 'launcher'
  | 'asset-inspector';

const PANEL_LABEL_KEYS: Record<EditorPanelId, string> = {
  hierarchy: 'editorPanel.label.hierarchy',
  assets: 'editorPanel.label.assets',
  inspector: 'editorPanel.label.inspector',
  history: 'editorPanel.label.history',
  capabilities: 'editorPanel.label.capabilities',
  material: 'editorPanel.label.material',
  timeline: 'editorPanel.label.timeline',
  matgraph: 'editorPanel.label.matgraph',
  launcher: 'editorPanel.label.launcher',
  'asset-inspector': 'editorPanel.label.assetInspector',
};

interface Props {
  panelId: EditorPanelId;
}

export function EditorPanelFrame({ panelId }: Props) {
  const { t } = useTranslation();
  const pinnedSlug = useAppStore((s) => s.pinnedSlug);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);

  // The scene slug is passed so the panel's BroadcastChannel connects to the
  // right scene's bus (same channel key as the viewport iframe).
  const slug = pinnedSlug ?? '';
  const sceneParam = slug ? `&scene=${encodeURIComponent(slug)}` : '';
  // Standalone-only seam: when the host (editor standalone) serves a game via
  // its own read-only middleware, it writes localStorage['forgeax.gameRoot'] so
  // a panel's resolveGamePath uses <slug> (matching that middleware) instead of
  // the .forgeax/games/<slug> default. studio embedded never sets this key, so
  // this param is absent there and behavior is unchanged.
  let gameRootParam = '';
  try {
    const gr = localStorage.getItem('forgeax.gameRoot');
    if (gr) gameRootParam = `&gameRoot=${encodeURIComponent(gr)}`;
  } catch { /* localStorage unavailable — omit, keep default */ }
  // ?chromeless=1: DetachedPanel hides its own title header + h3 inside the
  // panel body — the dockview tab already shows the panel name.
  const src = `/editor/?panel=${encodeURIComponent(panelId)}${sceneParam}${gameRootParam}&chromeless=1`;

  useEffect(() => {
    let cancelled = false;
    setAvailable(null);
    fetch(src, { method: 'GET' })
      .then((r) => {
        if (!cancelled) setAvailable(r.ok);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => { cancelled = true; };
  }, [src]);

  // Force reload when slug changes (a different game is opened → different scene).
  //
  // Serialized through the reload coordinator: a game switch changes `src` for
  // the viewport AND all ~9 editor sub-panels at once; reloading them in the
  // same frame would spin up that many WebGPU contexts simultaneously and black
  // out WKWebView. The coordinator grants reloads one-at-a-time so only one new
  // context comes up per tick. (Initial mount is handled by the `src` attr in
  // JSX and is NOT routed here — this effect only governs slug-change reloads.)
  useEffect(() => {
    const ifr = iframeRef.current;
    if (!ifr || !ifr.contentWindow) return;
    // If already on the right URL, no reload needed.
    try {
      const cur = new URL(ifr.contentWindow.location.href);
      const want = new URL(src, location.origin);
      if (cur.pathname === want.pathname && cur.search === want.search) return;
    } catch { /* cross-origin or not-yet-loaded — let the src attr handle it */ }
    const cancel = requestReloadSlot(() => {
      // Re-check the ref: the panel may have unmounted while queued.
      const live = iframeRef.current;
      if (live) live.src = src;
    });
    return cancel;
  }, [src]);

  const panelLabel = t(PANEL_LABEL_KEYS[panelId]);

  return (
    <div className="ep-frame-wrap" data-panel={panelId}>
      {available === false ? (
        <div className="ep-frame-unavailable">
          <div className="ep-frame-unavailable-title">{t('editorPanel.notLoaded', { label: panelLabel })}</div>
          <div className="ep-frame-unavailable-desc">
            {t('editorPanel.unavailableDesc')}
          </div>
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          src={src}
          className="ep-frame-iframe"
          title={panelLabel}
          // Permissions-Policy allow-list. Adding `pointer-lock *` explicitly
          // for fps: Chrome 2026 stopped silently inheriting pointer lock from
          // same-origin parents (now emits "root document of this element is
          // not valid for pointer lock" and silently denies the API), so the
          // FPS Click→requestPointerLock chain fails without the allow entry.
          // `webgpu` is still unstandardized (logs "Unrecognized feature"
          // warn) but harmless. xr-spatial-tracking / fullscreen / autoplay
          // are standardized.
          allow="autoplay; xr-spatial-tracking *; fullscreen *; pointer-lock *"
          // No sandbox — same origin, needs localStorage + BroadcastChannel.
        />
      )}
    </div>
  );
}
