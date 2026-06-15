// e2e — standalone shell DockShell + ep:* iframes + viewport iframe gate
// (AC-10 / AC-11). This spec is the RED side of the M2 TDD pair: w15
// writes the failing test, w14 makes it pass by rewriting
// packages/editor/standalone/main.tsx to self-render DockShell + panel
// iframes + mountStandalone viewport iframe.
//
// Architecture:
//   case AC-10 — :15290 standalone host renders DockShell with 8 panel
//     iframes (src = ...?panel=<id>) + 1 viewport iframe (src =
//     ...?viewportOnly=1). Total iframes = 9.
//   case AC-11 — each panel iframe src contains ?panel=<id> where <id>
//     is one of the 9 EDITOR_PANELS (hierarchy, inspector, assets,
//     history, capabilities, material, timeline, matgraph, launcher).
//     The viewport iframe src contains ?viewportOnly=1.
//
// The spec is independent of mount-standalone.spec.ts (which asserts
// mountStandalone creates exactly 1 iframe). This spec accesses the
// :15290 host page directly and counts React-rendered iframes in the
// host DOM, not the mountStandalone-created iframe in isolation.
//
// Falsifiability: with the current standalone/main.tsx (pre-w14), only
// mountStandalone is called which creates exactly 1 iframe. The AC-10
// assertion page.frames() >= 9 will FAIL — confirming the RED phase.
//
// Anchors:
//   requirements §AC-10 (standalone mount + page.frames() >= 9)
//   requirements §AC-11 (panel iframe URLs + viewport iframe URL)
//   plan-strategy §4 R-2 (independent spec, no collision with mount-standalone)
//   plan-strategy §5.4 (spec <= 200 lines)
//   plan-strategy §5.3 (falsification check — RED with current code)

import { expect, test } from '@playwright/test';

// EDITOR_PANELS from forgeax-editor/packages/editor-core/src/manifest.ts
// (SSOT). Duplicated here for test-only consumption — drift between the
// panel list and this spec would surface as a count mismatch or a
// missing-panel assertion failure.
const EDITOR_PANEL_IDS = [
  'hierarchy',
  'inspector',
  'assets',
  'history',
  'capabilities',
  'material',
  'timeline',
  'matgraph',
  'launcher',
] as const;

const STANDALONE_URL = 'http://127.0.0.1:15290/';

test.describe('standalone shell — DockShell + panel iframes', () => {
  test('AC-10: standalone mount produces >= 9 iframes (panels + viewport)', async ({ page }) => {
    await page.goto(STANDALONE_URL);

    // Wait for the standalone host to render. With w14 the DockShell
    // renders 9 panel iframes + 1 viewport iframe = 10 iframes total.
    // The >= 9 threshold guards against the pre-w14 single-iframe
    // baseline, which would produce 1 frame and fail this assertion.
    await expect.poll(() => page.frames().length, {
      timeout: 15_000,
      message: 'expected standalone host to render >= 9 frames (panel iframes + viewport)',
    }).toBeGreaterThanOrEqual(9);
  });

  test('AC-11: each panel iframe URL contains ?panel=<id> and viewport iframe contains ?viewportOnly=1', async ({ page }) => {
    await page.goto(STANDALONE_URL);

    // Wait for frames to appear (same threshold as AC-10).
    await expect.poll(() => page.frames().length, {
      timeout: 15_000,
    }).toBeGreaterThanOrEqual(9);

    const allFrames = page.frames();

    // Collect frame URLs — exclude the main frame (index 0) which is
    // the :15290 host page itself.
    const childFrameUrls = allFrames.slice(1).map((f) => f.url());

    // At least one iframe must be the viewport (src contains ?viewportOnly=1).
    const viewportFrameUrls = childFrameUrls.filter((url) =>
      url.includes('?viewportOnly=1'),
    );
    expect(viewportFrameUrls.length, 'expected at least 1 viewport iframe with ?viewportOnly=1').toBeGreaterThanOrEqual(1);

    // Each EDITOR_PANELS id must appear in at least one iframe URL as ?panel=<id>.
    const panelUrlSet = new Set(
      childFrameUrls
        .filter((url) => url.includes('?panel='))
        .map((url) => {
          const m = url.match(/[?&]panel=([^&]+)/);
          return m ? m[1] : '';
        })
        .filter(Boolean),
    );

    for (const panelId of EDITOR_PANEL_IDS) {
      expect(
        panelUrlSet.has(panelId),
        `expected panel iframe for "${panelId}" (URL containing ?panel=${panelId})`,
      ).toBe(true);
    }
  });
});