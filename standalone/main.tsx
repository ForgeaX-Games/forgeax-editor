// Standalone editor chrome entry — boots the editor app via app-kit's
// mountStandalone for the viewport iframe, then self-renders a thin
// DockShell chrome with ep:* panel iframes.
//
// Architecture (plan §2 D-4 / D-10):
//   - mountStandalone(editorApp) creates exactly 1 iframe (viewport at
//     entryUrl = http://127.0.0.1:15280/?viewportOnly=1). mountStandalone
//     implementation does NOT change (D-4 — it only mounts the entryUrl
//     iframe and does not consume manifest.panels).
//   - The panel iframes (ep:hierarchy, ep:inspector, ep:assets, etc.) are
//     created by React-rendered DockShell from @forgeax/interface (D-10 —
//     dev-only reuse of the studio DockShell component). Since standalone
//     is not published (npm publish only exports src/index.ts + src/app-kit.ts),
//     the @forgeax/interface devDependency is dev-time only.
//   - No layout persistence (E-4) — every page load renders fresh.
//
// Frame count:
//   - 1 viewport iframe (mountStandalone)
//   - 9 panel iframes (DockShell — one per EDITOR_PANELS id)
//   - Total: page.frames() >= 10 (main frame + 9 panel + 1 viewport)
//
// Anchors:
//   requirements AC-10  (standalone mount + page.frames() >= 9)
//   requirements AC-11  (panel iframes with ?panel=<id>, viewport with ?viewportOnly=1)
//   plan §2 D-4          (mountStandalone implementation unchanged)
//   plan §2 D-10         (DockShell reuse from @forgeax/interface)
//   plan §4 R-9          (hideChatAndForge bypasses chat/forge render)

import { mountStandalone } from '@forgeax/editor/app-kit';
import editorApp from '@forgeax/editor';
import { createRoot } from 'react-dom/client';
import { DockShell } from '@forgeax/interface';

// Viewport iframe — mountStandalone creates the iframe at
// editorApp.manifest.entryUrl (= http://127.0.0.1:15280/?viewportOnly=1).
mountStandalone(editorApp, { hideChatAndForge: true });

// DockShell chrome — renders ep:* panel iframes via dockview. The
// hideChatAndForge prop ensures the chat panel is not auto-mounted.
const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <div className="standalone-shell">
      <DockShell hideChatAndForge={true} />
    </div>,
  );
}

// Test hook (e2e parity with the legacy standalone-editor-demo). Bare
// module specifiers do not resolve through a runtime `import()` in a
// browser context, so the playwright spec reaches mountStandalone via
// this window-level handle.
//
// biome-ignore lint/suspicious/noExplicitAny: test hook injection
(window as any).__forgeaxStandaloneTest = { mountStandalone, editorApp };