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
import { useAppStore } from '../../store';

export type EditorPanelId =
  | 'hierarchy' | 'assets' | 'inspector' | 'history'
  | 'capabilities' | 'material' | 'timeline' | 'matgraph' | 'launcher';

const PANEL_LABELS: Record<EditorPanelId, string> = {
  hierarchy: '层级',
  assets: '资产',
  inspector: '检查器',
  history: '历史',
  capabilities: '组件',
  material: '材质',
  timeline: '时间轴',
  matgraph: '材质图',
  launcher: '启动器',
};

interface Props {
  panelId: EditorPanelId;
}

export function EditorPanelFrame({ panelId }: Props) {
  const pinnedSlug = useAppStore((s) => s.pinnedSlug);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);

  // The scene slug is passed so the panel's BroadcastChannel connects to the
  // right scene's bus (same channel key as the viewport iframe).
  const slug = pinnedSlug ?? '';
  const sceneParam = slug ? `&scene=${encodeURIComponent(slug)}` : '';
  // ?chromeless=1: DetachedPanel hides its own title header + h3 inside the
  // panel body — the dockview tab already shows the panel name.
  const src = `/editor/?panel=${encodeURIComponent(panelId)}${sceneParam}&chromeless=1`;

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
  useEffect(() => {
    const ifr = iframeRef.current;
    if (!ifr || !ifr.contentWindow) return;
    // If already on the right URL, no reload needed.
    try {
      const cur = new URL(ifr.contentWindow.location.href);
      const want = new URL(src, location.origin);
      if (cur.pathname === want.pathname && cur.search === want.search) return;
    } catch { /* cross-origin or not-yet-loaded — let the src attr handle it */ }
    ifr.src = src;
  }, [src]);

  return (
    <div className="ep-frame-wrap" data-panel={panelId}>
      {available === false ? (
        <div className="ep-frame-unavailable">
          <div className="ep-frame-unavailable-title">{PANEL_LABELS[panelId]} 未加载</div>
          <div className="ep-frame-unavailable-desc">
            Editor runtime 未启动或缺少 engine wasm 产物。已阻止嵌套 Studio 页面。
          </div>
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          src={src}
          className="ep-frame-iframe"
          title={PANEL_LABELS[panelId]}
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
