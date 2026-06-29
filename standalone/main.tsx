// Standalone editor chrome entry — :15290 host page that self-renders the
// editor shell (DockShell + ep:* iframes + viewport) entirely inside React.
//
// AC-spec-matrix (plan §2 D-14):
//   AC-10 — DockShell mounts; page.frames() >= 3 (viewport + active panel + main)
//   AC-11 — every panel container is in the DOM, primary tabs are visible,
//           first visible panel renders readable text from edit-runtime
//   AC-18 — postMessage source/origin gates remain in app-kit.ts (grep
//           guarded; no setTimeout-based bypass here)
//
// Architecture (plan §2 D-4 R3 + §2 D-10 R3):
//   - The viewport iframe is rendered by `renderEdit` (see standaloneRenderers
//     below), injected into DockShell's Edit panel via PanelRenderersProvider.
//     Its src is `/editor/?viewportOnly=1` — a root-relative URL served through
//     the :15290 vite proxy (→ :15280). There is NO body-level iframe: the
//     viewport lives inside the dock like every other panel.
//   - createRoot()->render(<StandaloneShell />) draws the whole shell inside
//     #root: DockShell reused from @forgeax/interface. DockShell's edit
//     workspace registers EditorPanelFrame for each ep:* panel id; matgraph +
//     launcher were added in 1d061b9 so EDITOR_PANELS SSOT (9 ids) is covered.
//   - hideChatAndForge: true closes the chat panel for the standalone host
//     (BANDAGE; AC-12 keeps studio:18920 EditMode unchanged).
//
// NOTE: an earlier design called app-kit's mountStandalone() here to create the
// viewport as a body-level iframe. That left a cross-origin GHOST iframe
// (direct :15280, URL missing the /editor base, running a 2nd engine instance)
// once renderEdit took over the real viewport. The mountStandalone() call was
// removed; the primitive itself stays a public app-kit API covered by
// interface/src/lib/app-kit.test.ts (bun).
//
// Forbidden by plan §2 D-4 R3 (do NOT reintroduce):
//   - setTimeout >= 1s deferring iframe creation
//   - display:none / visibility:hidden / zero-size plain-DOM iframes
//   - document.createElement('iframe') outside React
//
// Engine subpackage dist must be present — see scripts/bootstrap-worktree.mjs
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
import { useAppStore } from '@forgeax/interface/store';
import { AppKitError } from '@forgeax/editor/app-kit';
import '@forgeax/interface/styles/global.css';

// Injected by vite `define` (vite.config.ts) from FORGEAX_GAME_DIR's basename.
// null when the stack was started without `cli.mjs run --game <dir>` — in that
// case no game is served and the editor shows its built-in demo seed.
declare const __FORGEAX_GAME_SLUG__: string | null;

// Thin-shell renderers — the standalone host renders edit/preview as iframes to
// edit-runtime (:15280, proxied), the same pattern as the ep:* panels, instead
// of mounting EditSurface/PlaySurface in-process (which would drag the engine
// barrel into this bundle). interface stays editor-agnostic; the editor app
// supplies these surfaces through the PanelRenderers injection point.
const SURFACE_IFRAME_STYLE: React.CSSProperties = { width: '100%', height: '100%', border: 'none', display: 'block' };

// Build the edit-runtime iframe query. When a game slug is injected, thread
// ?scene=<slug>&gameRoot=<slug> so edit-runtime's default PathResolver
// (main.tsx:117) takes the ?gameRoot= branch (gameRoot=slug) — matching the host
// middleware's toDiskPath, which strips the <slug>/ prefix. No slug → no params
// → edit-runtime sceneId stays 'default' → demo seed.
function editRuntimeQuery(extra?: Record<string, string>): string {
  const q = new URLSearchParams(extra);
  const slug = __FORGEAX_GAME_SLUG__;
  if (slug) {
    q.set('scene', slug);
    q.set('gameRoot', slug);
  }
  return q.toString();
}

const standaloneRenderers = {
  ...DEFAULT_PANEL_RENDERERS,
  renderEdit: ({ viewportOnly }: { viewportOnly?: boolean }) => (
    <iframe
      title="Edit"
      src={`/editor/?${editRuntimeQuery(viewportOnly ? { viewportOnly: '1' } : undefined)}`}
      style={SURFACE_IFRAME_STYLE}
      allow="autoplay; xr-spatial-tracking *; fullscreen *; pointer-lock *"
    />
  ),
  renderPreview: () => (
    <iframe title="Preview" src={`/editor/?${editRuntimeQuery({ play: '1' })}`} style={SURFACE_IFRAME_STYLE} />
  ),
};

function StandaloneShell() {
  // DockShell's root (.fx-dockwrap) is `flex: 1 1 auto` — it needs a flex
  // parent with a definite height, exactly as studio's .studio-shell/.studio-
  // body chain provides. Without `display:flex` here the dock collapses to 0
  // height and every panel renders as a thin strip. So the wrapper is a
  // full-viewport flex column.
  return (
    <div
      className="forgeax-standalone-shell"
      style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
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

  // Pin the active game BEFORE React mounts so EditorPanelFrame builds its panel
  // iframe src (&scene=) for this game. pinnedSlug MUST be set via the store's
  // setPinnedSlug at runtime — the store reads localStorage lazily at MODULE
  // INIT (store.ts:2446), which already ran during import (before boot()), so
  // writing localStorage here would be too late for pinnedSlug. setPinnedSlug
  // also persists to localStorage. Clearing when no --game guarantees a stale
  // pin from a prior --game run can't make panels request a now-unserved game.
  //
  // forgeax.gameRoot is a separate standalone-only signal read at RENDER time by
  // EditorPanelFrame (so localStorage is fine for it): when present it appends
  // &gameRoot=<value> so the panel-side resolver uses <slug> (matching the host
  // middleware). studio embedded never sets it → panels keep the default.
  try {
    useAppStore.getState().setPinnedSlug(__FORGEAX_GAME_SLUG__ ?? null);
    if (__FORGEAX_GAME_SLUG__) localStorage.setItem('forgeax.gameRoot', __FORGEAX_GAME_SLUG__);
    else localStorage.removeItem('forgeax.gameRoot');
  } catch {
    /* store/localStorage unavailable — fine; demo seed path still works */
  }

  // React tree — DockShell + EditorPanelFrame iframes + the renderEdit viewport
  // all render synchronously through React's commit cycle. No body-level iframe,
  // no setTimeout, no display:none. The viewport is just DockShell's Edit panel.
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
