// Standalone editor chrome entry — boots the editor app via app-kit's
// mountStandalone for the viewport iframe, then self-renders a minimal
// dockview container with ep:* panel iframes (no @forgeax/interface dep).
//
// Architecture (plan §2 D-4 / D-10, fix-up I-1 option b):
//   - mountStandalone(editorApp) creates exactly 1 iframe (viewport at
//     entryUrl = http://127.0.0.1:15280/?viewportOnly=1). mountStandalone
//     implementation does NOT change (D-4 — it only mounts the entryUrl
//     iframe and does not consume manifest.panels).
//   - The panel iframes (ep:hierarchy, ep:inspector, ep:assets, etc.) are
//     created by a self-contained React-rendered dockview layout. Only
//     dockview + its CSS + EDITOR_PANELS SSOT from @forgeax/editor-core/manifest
//     (a zero-transitive-import leaf module) are imported. The
//     @forgeax/interface DockShell is NOT imported — avoids pulling in its
//     entire dependency tree (~13 unresolved path-alias / workspace imports).
//   - No layout persistence (E-4) — every page load renders fresh.
//
// Frame count:
//   - 1 viewport iframe (mountStandalone)
//   - 9 panel iframes (one per EDITOR_PANELS id)
//   - Total: page.frames() >= 10 (main frame + 9 panel + 1 viewport)
//
// Anchors:
//   requirements AC-10  (standalone mount + page.frames() >= 9)
//   requirements AC-11  (panel iframes with ?panel=<id>, viewport with ?viewportOnly=1)
//   plan §2 D-4          (mountStandalone implementation unchanged)
//   plan §4 R-9          (no chat/forge panel)
//
// Fix-ups:
//   I-1 (option b) — self-contained dockview container, no @forgeax/interface
//   I-5 — try/catch + AppKitError on null rootEl (charter P3)

import { mountStandalone, AppKitError } from '@forgeax/editor/app-kit';
import editorApp from '@forgeax/editor';
import { createRoot } from 'react-dom/client';
import React, { useCallback, useMemo, useRef } from 'react';
import {
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewApi,
} from 'dockview';
import 'dockview/dist/styles/dockview.css';

// EDITOR_PANELS SSOT — imported directly from the leaf manifest module
// (zero transitive imports) to avoid pulling in the editor-core barrel
// which transitively loads @forgeax/engine-runtime + @forgeax/engine-gltf.
import { EDITOR_PANELS } from '@forgeax/editor-core/manifest';

const PANEL_LABELS: Record<string, string> = {
  hierarchy: 'Hierarchy',
  inspector: 'Inspector',
  assets: 'Assets',
  history: 'History',
  capabilities: 'Capabilities',
  material: 'Material',
  timeline: 'Timeline',
  matgraph: 'Mat Graph',
  launcher: 'Launcher',
};

/** Minimal iframe wrapper for one editor panel (ep:<id>). */
function PanelFrame({ panelId }: { panelId: string }) {
  const src = `/editor/?panel=${encodeURIComponent(panelId)}&chromeless=1`;
  return (
    <div className="ep-frame-wrap" data-panel={panelId}>
      <iframe
        src={src}
        className="ep-frame-iframe"
        title={PANEL_LABELS[panelId] ?? panelId}
        allow="autoplay; xr-spatial-tracking *; fullscreen *; pointer-lock *"
      />
    </div>
  );
}

/** Build a default standalone layout with all EDITOR_PANELS in a 3-column grid. */
function buildDefault(api: DockviewApi): void {
  // Column 1: hierarchy (top), assets (bottom)
  // Column 2: edit viewport (main area, no panel iframe — mountStandalone's
  //           viewport iframe renders in document.body outside dockview)
  // Column 3: inspector+material+matgraph (top), launcher+history+timeline+
  //           capabilities (bottom)
  api.addPanel({ id: 'ep:hierarchy', component: 'ep:hierarchy', title: PANEL_LABELS['hierarchy'] });
  api.addPanel({ id: 'edit', component: 'edit', title: 'Edit', position: { referencePanel: 'ep:hierarchy', direction: 'right' } });
  api.addPanel({ id: 'ep:inspector', component: 'ep:inspector', title: PANEL_LABELS['inspector'], position: { referencePanel: 'edit', direction: 'right' } });
  api.addPanel({ id: 'ep:material', component: 'ep:material', title: PANEL_LABELS['material'], position: { referencePanel: 'ep:inspector', direction: 'within' } });
  api.addPanel({ id: 'ep:matgraph', component: 'ep:matgraph', title: PANEL_LABELS['matgraph'], position: { referencePanel: 'ep:material', direction: 'within' } });
  api.addPanel({ id: 'ep:assets', component: 'ep:assets', title: PANEL_LABELS['assets'], position: { referencePanel: 'ep:hierarchy', direction: 'below' } });
  api.addPanel({ id: 'ep:launcher', component: 'ep:launcher', title: PANEL_LABELS['launcher'], position: { referencePanel: 'ep:inspector', direction: 'below' } });
  api.addPanel({ id: 'ep:history', component: 'ep:history', title: PANEL_LABELS['history'], position: { referencePanel: 'ep:launcher', direction: 'within' } });
  api.addPanel({ id: 'ep:timeline', component: 'ep:timeline', title: PANEL_LABELS['timeline'], position: { referencePanel: 'ep:history', direction: 'within' } });
  api.addPanel({ id: 'ep:capabilities', component: 'ep:capabilities', title: PANEL_LABELS['capabilities'], position: { referencePanel: 'ep:history', direction: 'within' } });

  try {
    api.getPanel('ep:hierarchy')?.api.setSize({ width: 240 });
    api.getPanel('ep:inspector')?.api.setSize({ width: 340 });
  } catch { /* sizing best-effort */ }
}

/** Top-level standalone shell: mountStandalone + dockview panel host. */
function StandaloneShell() {
  const apiRef = useRef<DockviewApi | null>(null);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;
    buildDefault(api);
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__dockApi = api;
    }
  }, []);

  // Build the dockview components map — one iframe panel per EDITOR_PANELS id.
  const components = useMemo(() => {
    const map: Record<string, React.FC> = {
      // 'edit' is a placeholder container (the real viewport iframe lives
      // outside dockview, created by mountStandalone in document.body).
      edit: () => <div className="standalone-edit-viewport" />,
    };
    for (const id of EDITOR_PANELS) {
      map[`ep:${id}`] = () => <PanelFrame panelId={id} />;
    }
    return map;
  }, []);

  return (
    <div className="standalone-dockwrap">
      <DockviewReact
        className="dockview-theme-abyss fx-dockshell"
        components={components}
        onReady={onReady}
        singleTabMode="fullwidth"
        disableFloatingGroups={false}
      />
    </div>
  );
}

// ── Entry point ───────────────────────────────────────────────────────────

// Viewport iframe — mountStandalone creates the iframe at
// editorApp.manifest.entryUrl (= http://127.0.0.1:15280/?viewportOnly=1).
// Wrapped in try/catch so mount failures surface visibly (charter P3 / I-5).
try {
  mountStandalone(editorApp, { hideChatAndForge: true });
} catch (err) {
  console.error('[standalone] mountStandalone failed:', err);
  throw err;
}

// Render the panel chrome via dockview.
const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new AppKitError(
    'standalone root element #root not found in index.html',
    'INVALID_ROOT_EL',
    'Ensure standalone/index.html contains <div id="root"></div> before the module script.',
  );
}

try {
  createRoot(rootEl).render(<StandaloneShell />);
} catch (err) {
  console.error('[standalone] standalone shell render failed:', err);
  throw err;
}

// Test hook (e2e parity with the legacy standalone-editor-demo). Bare
// module specifiers do not resolve through a runtime `import()` in a
// browser context, so the playwright spec reaches mountStandalone via
// this window-level handle.
//
// biome-ignore lint/suspicious/noExplicitAny: test hook injection
(window as any).__forgeaxStandaloneTest = { mountStandalone, editorApp };