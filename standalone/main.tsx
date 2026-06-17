// Standalone editor chrome entry — :15290 host page that self-renders the
// editor shell (DockShell + ep:* iframes) AND boots the engine via
// app-kit's mountStandalone for the viewport iframe.
//
// AC-spec-matrix (plan §2 D-14):
//   AC-10 — DockShell mounts; page.frames() >= 9 (8 panel iframes + 1 viewport)
//   AC-11 — every panel container is in the DOM, primary tabs are visible,
//           first visible panel renders readable text from edit-runtime
//   AC-18 — postMessage source/origin gates remain in app-kit.ts (grep
//           guarded; no setTimeout-based bypass here)
//
// Architecture (plan §2 D-4 R3 + §2 D-10 R3):
//   - mountStandalone(editorApp) creates the single viewport iframe at
//     entryUrl=http://127.0.0.1:15280/?viewportOnly=1 (mountStandalone
//     implementation unchanged).
//   - createRoot()->render(<App />) draws the chrome inside #root: DockShell
//     reused from @forgeax/interface (no self-rendered dockview, no
//     panelRenderer prop). DockShell's edit workspace registers EditorPanelFrame
//     for each ep:* panel id; matgraph + launcher were added in 1d061b9 so
//     EDITOR_PANELS SSOT (9 ids) is fully covered.
//   - hideChatAndForge: true closes the chat panel for the standalone host
//     (BANDAGE; AC-12 keeps studio:18920 EditMode unchanged).
//
// Forbidden by plan §2 D-4 R3 (do NOT reintroduce):
//   - setTimeout >= 1s deferring iframe creation
//   - display:none / visibility:hidden / zero-size plain-DOM iframes
//   - document.createElement('iframe') outside React
//   - any timer constructed to slip past mount-standalone.spec.ts beforeEach
//     (mount-standalone runs against a different fixture page; this :15290
//     host page does not collide with its 1-iframe assertion).
//
// Engine subpackage dist must be present — see scripts/bootstrap-worktree.sh
// (plan §2 D-12 / w19). Without it, vite cannot resolve
// @forgeax/engine-vite-plugin-{pack,shader} and webServer fails ENOENT.
//
// Refs: implement-review §R2-2 (R2 plain-DOM display:none rejected),
//       §R2-3 (D-4 / D-10 / RL-3 architecture restored).

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DockShell } from '@forgeax/interface/components/DockShell/DockShell';
import {
  PanelRenderersProvider,
  DEFAULT_PANEL_RENDERERS,
} from '@forgeax/interface/components/DockShell/panelRenderers';
import { mountStandalone, AppKitError, defineApp } from '@forgeax/editor/app-kit';
import { EDITOR_PANELS } from '@forgeax/editor-core/manifest';
import '@forgeax/interface/styles/global.css';

// Inline editorApp — avoid pulling the @forgeax/editor barrel which would drag
// the full edit/play surfaces into this bundle. Only the manifest fields
// mountStandalone reads (id + entryUrl) are required.
const editorApp = defineApp({
  id: 'editor',
  entryUrl: 'http://127.0.0.1:15280/?viewportOnly=1',
  panels: EDITOR_PANELS.map((id) => ({ id })),
  surfaces: [],
  routes: [],
});

// Thin-shell renderers — the standalone host renders edit/preview as iframes to
// edit-runtime (:15280, proxied), the same pattern as the ep:* panels, instead
// of mounting EditSurface/PlaySurface in-process (which would drag the engine
// barrel into this bundle). interface stays editor-agnostic; the editor app
// supplies these surfaces through the PanelRenderers injection point.
const SURFACE_IFRAME_STYLE: React.CSSProperties = { width: '100%', height: '100%', border: 'none', display: 'block' };

const standaloneRenderers = {
  ...DEFAULT_PANEL_RENDERERS,
  renderEdit: ({ viewportOnly }: { viewportOnly?: boolean }) => (
    <iframe
      title="Edit"
      src={`/editor/?${viewportOnly ? 'viewportOnly=1' : ''}`}
      style={SURFACE_IFRAME_STYLE}
      allow="autoplay; xr-spatial-tracking *; fullscreen *; pointer-lock *"
    />
  ),
  renderPreview: () => (
    <iframe title="Preview" src="/editor/?play=1" style={SURFACE_IFRAME_STYLE} />
  ),
};

function StandaloneShell() {
  return (
    <div className="forgeax-standalone-shell" style={{ width: '100vw', height: '100vh' }}>
      <PanelRenderersProvider value={standaloneRenderers}>
        <DockShell hideChatAndForge />
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

  // Viewport iframe — mountStandalone owns its own DOM creation; spec
  // mount-standalone.spec.ts asserts it produces exactly 1 iframe in
  // isolation. Wrapped in try/catch so AppKitError surfaces through the
  // browser console even if the iframe append throws.
  try {
    mountStandalone(editorApp, { hideChatAndForge: true });
  } catch (err) {
    console.error('[standalone] mountStandalone failed:', err);
    throw err;
  }

  // React tree — DockShell + EditorPanelFrame iframes render synchronously
  // through React's commit cycle. No setTimeout, no display:none.
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

// Test hook (e2e parity).
// biome-ignore lint/suspicious/noExplicitAny: test hook injection
(window as any).__forgeaxStandaloneTest = { mountStandalone, editorApp };
