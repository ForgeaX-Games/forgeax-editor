// Standalone editor chrome entry — :15290 host page (single realm, M2).
//
// SINGLE-REALM ASSEMBLY (plan-strategy REPLAN D4/D8; requirements AC-04/AC-05):
//   Before M2 this host rendered the viewport AND every ep:* panel as iframes to
//   edit-runtime (:15280) — each iframe a SEPARATE module realm with its own
//   EditorBus + engine. M2 collapses the editor to ONE realm: the engine boots
//   ONCE in THIS window (via ViewportComponent's single-boot latch) and both the
//   viewport and the ep:* panels are in-process React components assembled through
//   DockShell's injection slots:
//     - renderEdit         -> ViewportComponent (the in-process engine surface,
//                             imported from @forgeax/editor-edit-runtime).
//     - renderEditorPanel  -> EDITOR_PANEL_COMPONENTS[id] (in-process panel
//                             component; placeholder for ids with no component).
//   There is NO /editor iframe anywhere (the root vite `/editor` proxy is deleted
//   too — the host bundler serves the engine in-process via engine-vite-preset).
//
// AC-spec-matrix:
//   AC-04a — no editor panel/viewport iframe (page has no ?panel= / ?viewportOnly=1)
//   AC-04b — the engine <canvas> lives in THIS document (in-process viewport)
//   AC-04c — DockShell still registers every ep:* panel (now component slots)
//   AC-05  — panels + chat share one flat dock, freely interleaved
//   AC-09  — hideChatAndForge closes the chat panel for the standalone host
//
// Anchors: plan-strategy S2 D4/D5/D6/D8, S3.1 host entry; requirements AC-04/05/09;
//          research Finding 2/3/7.

import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { DockShell } from '@forgeax/interface/components/DockShell/DockShell';
import { ContextMenu } from '@forgeax/interface/components/ContextMenu/ContextMenu';
import {
  PanelRenderersProvider,
  DEFAULT_PANEL_RENDERERS,
} from '@forgeax/interface/components/DockShell/panelRenderers';
import { SurfaceKeepAliveLayer } from '@forgeax/interface/components/Surfaces/SurfaceKeepAliveLayer';
import { useAppStore } from '@forgeax/interface/store';
import { AppKitError } from '@forgeax/editor/app-kit';
// Single-realm surfaces — imported IN-PROCESS from edit-runtime's D8 subpath
// exports (no iframe). ViewportComponent boots the engine once in this window;
// EDITOR_PANEL_COMPONENTS maps ep:<id> -> the panel's React component.
import { ViewportComponent } from '@forgeax/editor-edit-runtime/engine/viewport-component';
// editor-panels is not a direct root dependency (zero-transitive src/ design,
// AGENTS.md) — reach EDITOR_PANEL_COMPONENTS through the root package's own
// `./panels` export (-> packages/panels/src/manifest.ts), the same
// self-import pattern as `@forgeax/editor/app-kit` above.
import { EDITOR_PANEL_COMPONENTS } from '@forgeax/editor/panels';
import '@forgeax/interface/styles/global.css';
import './standalone-chrome.css';
import './standalone-menu.css';

// Injected by vite `define` (vite.config.ts) from FORGEAX_GAME_DIR's basename.
// null when the stack was started without `cli.mjs run --game <dir>` — in that
// case no game is served and the editor shows its built-in demo seed.
declare const __FORGEAX_GAME_SLUG__: string | null;

// ── panel renderer injection (single realm) ───────────────────────────────────
// renderEdit  = the in-process ViewportComponent (NOT an iframe src). SurfaceKeep-
//   AliveLayer mounts it once and overlays it on the Edit anchor's rect.
// renderEditorPanel = the in-process panel body for ep:<id>; placeholder for ids
//   with no registered component (D6: timeline / matgraph / systems drift ids).
// renderChat / renderPreview left to the defaults (neutral placeholders).
function EditorPanelBody({ id }: { id: string }): ReactNode {
  const Comp = EDITOR_PANEL_COMPONENTS[id];
  if (Comp) return <Comp />;
  return (
    <div className="surface-placeholder" data-panel={id} data-panel-unmounted="1">
      <div className="surface-placeholder-title">Panel not mounted</div>
    </div>
  );
}

const standaloneRenderers = {
  ...DEFAULT_PANEL_RENDERERS,
  // In-process viewport — a component, not an iframe. viewportOnly is accepted
  // for signature parity with the old iframe renderer but the in-process
  // component always renders the full engine surface.
  renderEdit: (_opts: { viewportOnly?: boolean }) => <ViewportComponent />,
  renderEditorPanel: (id: string) => <EditorPanelBody id={id} />,
};

function StandaloneShell() {
  // DockShell's root (.fx-dockwrap) is `flex: 1 1 auto` — it needs a flex parent
  // with a definite height. So the wrapper is a full-viewport flex column.
  return (
    <div
      className="forgeax-standalone-shell"
      style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      <PanelRenderersProvider value={standaloneRenderers}>
        <DockShell hideChatAndForge />
        {/* Always-mounted owner of the Edit viewport surface (interface's
            keepalive-surface refactor). DockShell's Edit panel is only a
            <SurfaceAnchor> placeholder; this sibling layer mounts the real
            surface once via renderEdit (now the in-process ViewportComponent)
            and overlays it (position:fixed) onto that anchor's rect. Mirrors
            interface App.tsx (DockShell + SurfaceKeepAliveLayer siblings). */}
        <SurfaceKeepAliveLayer />
        {/* ep:* panels post VAG_CONTEXT_MENU here — without this host,
            Assets/Hierarchy right-click menus are swallowed but never painted.
            Mirrors interface App.tsx. */}
        <ContextMenu />
      </PanelRenderersProvider>
    </div>
  );
}

function boot(): void {
  const rootEl = document.getElementById('root');
  if (!rootEl) {
    // Charter P3 — explicit failure with a code AI users can branch on.
    throw new AppKitError({
      code: 'INVALID_ROOT_EL',
      hint: '#root element not present in standalone/index.html',
      expected: '<div id="root"></div>',
    });
  }

  // Pin the active game BEFORE React mounts so the in-process engine boot
  // (ViewportComponent / host-boot) reads the right scene. setPinnedSlug persists
  // to localStorage; forgeax.gameRoot is the standalone-only game-root signal.
  // Clearing when no --game guarantees a stale pin from a prior run can't make
  // the boot request a now-unserved game.
  try {
    useAppStore.getState().setPinnedSlug(__FORGEAX_GAME_SLUG__ ?? null);
    if (__FORGEAX_GAME_SLUG__) localStorage.setItem('forgeax.gameRoot', __FORGEAX_GAME_SLUG__);
    else localStorage.removeItem('forgeax.gameRoot');
  } catch {
    /* store/localStorage unavailable — fine; demo seed path still works */
  }

  // single-realm (feat-20260703): bridge the --game slug into the URL query so
  // configureHostSession() (host-boot) — which reads the active scene ONLY from
  // location.search (?scene=<slug>&gameRoot=<slug>) — loads the on-disk scene
  // instead of falling back to the built-in demo seed. Under the old iframe arch
  // the host injected these params into the edit-runtime iframe's src; collapsing
  // to a single realm removed that injector, so the standalone entry must now put
  // them on its own URL. Only when --game is set AND the caller didn't already
  // pass ?scene= (deep-link / studio-embed keep control). game-backend addresses
  // files by <slug>/<rel>, so gameRoot === slug here.
  try {
    const qp = new URLSearchParams(location.search);
    if (__FORGEAX_GAME_SLUG__ && !qp.get('scene')) {
      qp.set('scene', __FORGEAX_GAME_SLUG__);
      qp.set('gameRoot', __FORGEAX_GAME_SLUG__);
      history.replaceState(null, '', `${location.pathname}?${qp.toString()}${location.hash}`);
    }
  } catch {
    /* URL/History unavailable — fine; ?scene= deep-link still works if present */
  }

  // React tree — DockShell + in-process panel components + SurfaceKeepAliveLayer
  // (which owns the renderEdit ViewportComponent, overlaid on the Edit anchor).
  // No body-level iframe, no setTimeout, no display:none.
  try {
    createRoot(rootEl).render(
      <StrictMode>
        <StandaloneShell />
      </StrictMode>,
    );
  } catch (err) {
    console.error('[standalone] React mount failed:', err);
    throw err;
  }
}

boot();
