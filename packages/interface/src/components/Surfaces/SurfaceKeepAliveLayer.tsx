// SurfaceKeepAliveLayer — always-mounted owner of the Viewport surface.
//
// THE FIX for the Viewport↔AI freeze. Viewport / AI are separate dockview
// *workspaces*; switching tabs rebuilds the dock tree, which previously destroyed +
// cold-rebooted the heavy viewport on EVERY switch (full WebGPU init + the
// editor's top-level-await boot → intermittent WKWebView wedge = the freeze).
//
// 2026-06-30: 'preview'/'edit' merged into single 'viewport'. Only the edit
// surface is kept alive across workspace switches. The play-runtime (/preview)
// is now a standalone fullscreen-only entry point (AC-14).
//
// This layer is a sibling of DockShell (App.tsx, inside `.studio-body`) that never
// unmounts. It mounts the surface ONCE (lazily, on first visit) and keeps it alive
// forever in a stable parent — never re-parented, so it never reloads. On a switch
// we only:
//   - position the ACTIVE surface (fixed) over its dockview anchor's rect, visible;
//   - park the others off-screen + visibility:hidden, which trips the in-process
//     viewport's OWN IntersectionObserver (installVisibilityPause in edit-runtime)
//     → editorApp.pause() in the background (context preserved).
// Switching back is a one-frame composite: zero reload, zero boot, FPS resumes.
//
// Single realm: the edit surface is an in-process React component (ViewportComponent),
// not an iframe. Stays editor-agnostic: the real surface comes from PanelRenderers
// context (studio injects @forgeax/editor's SceneEditor); interface keeps ZERO
// editor imports.
import { useEffect, useReducer, useRef, type ReactNode } from 'react';
import { useShellStore } from '../../store';
import { usePanelRenderers } from '../DockShell/panelRenderers';
import { FatalBanner } from '../StatusBar/FatalBanner';
import {
  getAnchor,
  subscribeAnchors,
  subscribeRelayout,
  type SurfaceKind,
} from '../../lib/surfaceAnchors';
import './SurfaceKeepAlive.css';

// AppMode = shell workspace mode. The engine's edit-time surface kind is still
// 'edit' (see SurfaceKind in ../../lib/surfaceAnchors); the workbench-id / mode-id
// 'edit' was renamed to 'scene' by the v9 workbench-schema migration.
type AppMode = 'scene' | 'ai';

function kindForMode(mode: AppMode): SurfaceKind | null {
  if (mode === 'scene') return 'edit';
  return null; // workbench / custom workspaces show neither surface
}

const ALL_KINDS: SurfaceKind[] = ['edit'];

export function SurfaceKeepAliveLayer(): ReactNode {
  const mode = useShellStore((s) => s.mode) as AppMode;
  const { surfaces } = usePanelRenderers();
  const SceneEditor = surfaces?.SceneEditor;
  const activeKind = kindForMode(mode);

  // Visited set only grows — a surface, once mounted, is never torn down. Seeded
  // with the boot mode's kind so the first surface mounts immediately; later kinds
  // are added (and re-rendered) the first time their workspace becomes active.
  const visitedRef = useRef<Set<SurfaceKind>>(new Set(activeKind ? [activeKind] : []));
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (activeKind && !visitedRef.current.has(activeKind)) {
      visitedRef.current.add(activeKind);
      bump();
    }
  }, [activeKind]);

  // Per-kind item DOM nodes — styled imperatively (fixed rect / display) so dock
  // resize/drag ticks don't churn React.
  const itemRefs = useRef<Map<SurfaceKind, HTMLDivElement | null>>(new Map());

  // Imperative layout sync: overlay the active surface on its anchor's rect; hide
  // the rest. Cheap enough to call on every resize/relayout tick.
  const syncLayout = (): void => {
    for (const kind of ALL_KINDS) {
      const el = itemRefs.current.get(kind);
      if (!el) continue;
      const anchor = kind === activeKind ? getAnchor(kind) : null;
      if (!anchor) {
        // Inactive, or active-but-no-anchor (workbench mode / panel closed / popped
        // to an OS window). DO NOT use display:none — on WKWebView (the desktop
        // Studio app) display:none on a WebGPU <canvas> DROPS the GPU device, so
        // flipping back finds a dead context and the re-create wedges WKWebView's
        // GPU process (the "来回切换就死掉" Play↔Edit freeze). Instead park the
        // surface OFF-SCREEN + visibility:hidden: the GPU context stays alive, the
        // surface is invisible + click-through, and being outside the viewport still
        // trips the surface's IntersectionObserver so its render loop pauses (no
        // double-render). Switch-back just moves it back onto the anchor — no
        // context re-create, so no wedge. Keep a real (non-zero) size so the
        // swap-chain stays valid while parked.
        el.style.display = 'flex';
        el.style.visibility = 'hidden';
        el.style.pointerEvents = 'none';
        el.style.top = '0px';
        el.style.left = '-100000px';
        if (!el.style.width || el.style.width === '0px') el.style.width = '1280px';
        if (!el.style.height || el.style.height === '0px') el.style.height = '720px';
        continue;
      }
      const r = anchor.getBoundingClientRect();
      el.style.display = 'flex';
      el.style.visibility = 'visible';
      el.style.pointerEvents = '';
      el.style.top = `${r.top}px`;
      el.style.left = `${r.left}px`;
      el.style.width = `${r.width}px`;
      el.style.height = `${r.height}px`;
    }
  };

  // Re-sync on: active-kind change (mode), anchor add/remove, dock relayout ping,
  // window resize/scroll, and ResizeObserver of whichever anchors currently exist.
  useEffect(() => {
    syncLayout();
    let layoutRaf = 0;
    const scheduleSync = () => {
      if (layoutRaf) return;
      layoutRaf = requestAnimationFrame(() => {
        layoutRaf = 0;
        syncLayout();
      });
    };
    const onWin = () => scheduleSync();
    window.addEventListener('resize', onWin);
    window.addEventListener('scroll', onWin, true);

    let ro: ResizeObserver | null = null;
    const observeCurrentAnchors = () => {
      if (!ro) return;
      ro.disconnect();
      for (const kind of ALL_KINDS) {
        const a = getAnchor(kind);
        if (a) ro.observe(a);
      }
    };

    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => scheduleSync());
      observeCurrentAnchors();
    }
    const offAnchors = subscribeAnchors(() => {
      observeCurrentAnchors();
      syncLayout();
    });
    const offRelayout = subscribeRelayout(scheduleSync);

    // A short rAF burst right after a switch catches the dockview rebuild settling
    // (anchor mounts a frame or two after the workspace flips) without a permanent
    // loop. Each tick is a single getBoundingClientRect — negligible.
    let frames = 0;
    let burstRaf = 0;
    const tick = () => {
      syncLayout();
      if (++frames < 30) burstRaf = requestAnimationFrame(tick);
    };
    burstRaf = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener('resize', onWin);
      window.removeEventListener('scroll', onWin, true);
      offAnchors();
      offRelayout();
      ro?.disconnect();
      if (layoutRaf) cancelAnimationFrame(layoutRaf);
      if (burstRaf) cancelAnimationFrame(burstRaf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKind]);

  const renderSurface = (kind: SurfaceKind): ReactNode => {
    // Single-kind surface today ('edit'); the preview/edit merge (2026-06-30)
    // collapsed both into one viewport. Kept the kind-switch so future modes
    // (play, debug) can add sibling branches without restructuring.
    if (kind !== 'edit') return <NoEditor kind={kind} />;
    return SceneEditor ? (
      <div data-fx-slot="SceneEditor" style={{ display: 'contents' }}><SceneEditor viewportOnly={true} /></div>
    ) : (
      <NoEditor kind="edit" />
    );
  };

  return (
    <div className="fx-surface-keepalive-root" aria-hidden={activeKind ? undefined : true}>
      {[...visitedRef.current].map((kind) => (
        // Stable key + stable parent → the in-process surface is reconciled in
        // place across every render: never remounted, never reloaded.
        <div
          key={kind}
          ref={(el) => { itemRefs.current.set(kind, el); }}
          className="fx-surface-keepalive-item surface-region"
          data-surface-kind={kind}
          style={{ display: 'none' }}
        >
          {/* ALL_KINDS is ['edit'] today — the only kept-alive surface is the edit
              viewport. FatalBanner is fixed to 'edit' accordingly. */}
          <FatalBanner source="edit" />
          {renderSurface(kind)}
        </div>
      ))}
    </div>
  );
}

function NoEditor({ kind }: { kind: SurfaceKind }) {
  return (
    <div className={`surface-placeholder surface-placeholder--${kind}`}>
      <div className="surface-placeholder-title">No editor configured</div>
    </div>
  );
}
