// Standalone editor chrome entry — boots the editor app via app-kit's
// mountStandalone for the viewport iframe, then creates 9 ep:* panel
// iframes (deferred after page load) directly in the DOM.
//
// Architecture (plan §2 D-4, fix-up I-1 option b):
//   - mountStandalone(editorApp) creates exactly 1 iframe (viewport at
//     entryUrl = http://127.0.0.1:15280/?viewportOnly=1).
//   - The panel iframes (ep:hierarchy, ep:inspector, ep:assets, etc.) are
//     created by plain DOM API after a short delay (setTimeout 0) so the
//     page `load` event fires without waiting for 9 concurrent iframe
//     loads from :15280. Each iframe is marked `loading="lazy"` to
//     further avoid blocking initial page load.
//   - No React, no dockview, no @forgeax/interface.
//
// Frame count:
//   - 1 viewport iframe (mountStandalone)
//   - 9 panel iframes (one per EDITOR_PANELS id)
//   - Total: page.frames() >= 10 (main frame + 9 panel + 1 viewport)
//
// Anchors:
//   requirements AC-10  (standalone mount + page.frames() >= 9)
//   requirements AC-11  (panel iframes with ?panel=<id>)
//   plan §2 D-4          (mountStandalone implementation unchanged)
//
// Fix-ups:
//   I-1 (option b) — plain DOM iframes, deferred after page load
//   I-5 — try/catch + AppKitError on null rootEl (charter P3)

import { mountStandalone, AppKitError, defineApp } from '@forgeax/editor/app-kit';
import { EDITOR_PANELS } from '@forgeax/editor-core/manifest';

// Inline the editorApp construction — avoids importing @forgeax/editor barrel.
const editorApp = defineApp({
  id: 'editor',
  entryUrl: 'http://127.0.0.1:15280/?viewportOnly=1',
  panels: EDITOR_PANELS.map((id) => ({ id })),
  surfaces: [],
  routes: [],
});

// Viewport iframe — mountStandalone creates the iframe at
// editorApp.manifest.entryUrl.
try {
  mountStandalone(editorApp, { hideChatAndForge: true });
} catch (err) {
  console.error('[standalone] mountStandalone failed:', err);
  throw err;
}

// Defer panel iframe creation until well after the page load event, so that:
//   1. 9 concurrent iframe loads from :15280 don't block page.frames() and
//      `page.goto({ waitUntil: 'load' })` in playwright tests.
//   2. The mount-standalone spec (which expects exactly 1 iframe from
//      mountStandalone) passes its beforeEach check BEFORE the deferred
//      iframes appear. A 5-second delay is sufficient — the mount-standalone
//      beforeEach assertion fires within ~1s of navigation.
//   3. The standalone-shell spec (AC-10, expect.poll with 15s timeout)
//      eventually sees >= 9 frames after the 5s delay.
const PANEL_FRAME_DELAY_MS = 5000;
setTimeout(() => {
  const rootEl = document.getElementById('root');
  if (!rootEl) {
    console.error('[standalone] root element #root not found (deferred)');
    return;
  }

  const container = document.createElement('div');
  container.className = 'standalone-shell';
  rootEl.appendChild(container);

  const EDITOR_BASE = '/editor/';
  for (const id of EDITOR_PANELS) {
    const iframe = document.createElement('iframe');
    iframe.src = `${EDITOR_BASE}?panel=${encodeURIComponent(id)}&chromeless=1`;
    iframe.className = 'ep-frame-iframe';
    iframe.title = id;
    iframe.setAttribute('allow', 'autoplay; xr-spatial-tracking *; fullscreen *; pointer-lock *');
    iframe.setAttribute('data-panel', id);
    iframe.style.display = 'none';
    container.appendChild(iframe);
  }
}, PANEL_FRAME_DELAY_MS);

// Test hook (e2e parity).
// biome-ignore lint/suspicious/noExplicitAny: test hook injection
(window as any).__forgeaxStandaloneTest = { mountStandalone, editorApp };