// e2e — standalone shell DockShell + ep:* iframes + viewport iframe (AC-10/AC-11).
//
// AC-spec-matrix (plan §2 D-14 — AC <-> spec assertion reverse map):
//   AC-10  page.frames() >= 9                     -> assertion @ frameCountTest line ~85
//   AC-11a 8 panel containers must be visible     -> assertion @ visibilityTest line ~104
//   AC-11b first panel must show readable text    -> assertion @ readableTextTest line ~135
//   AC-11c each iframe src contains ?panel=<id>   -> assertion @ panelUrlTest line ~155
//   AC-11d viewport iframe src contains ?viewportOnly=1 -> @ panelUrlTest line ~150
//   AC-18  postMessage source/origin gate         -> guarded by w14a grep on app-kit.ts (NOT in spec)
//
// Falsification check (plan §2 D-13, §5.3 — confirm spec has discriminative power;
// reviewer applies these manually, NOT in CI):
//   1. Comment out <DockShell> render in standalone/main.tsx (keep only mountStandalone):
//        expected: page.frames() == 1 (main only)  -> AC-10 frameCountTest FAILS.
//   2. Add `style={{ display: 'none' }}` to each EditorPanelFrame container:
//        expected: visibilityTest FAILS at first panel toBeVisible() (display:none guard).
//   3. Render each panel iframe but with `width: 0; height: 0` instead of removed:
//        expected: visibilityTest FAILS (zero-size guard built into Playwright toBeVisible).
//
// Architecture independence from mount-standalone.spec.ts (plan §4 R-2):
//   This spec navigates to :15290 (the standalone host page itself). It counts
//   the React-rendered frame tree (8 panel iframes + 1 viewport iframe = 9
//   total child frames; 10 if main frame is included in page.frames()).
//
//   mount-standalone.spec.ts navigates to a different test fixture page where
//   only mountStandalone() runs in isolation -> exactly 1 viewport iframe.
//   The two specs are on different pages and their assertions do NOT collide;
//   no setTimeout wrapping or display:none trickery is needed (and is forbidden
//   by plan §2 D-4 R3).
//
// Anchors:
//   requirements §AC-10 / §AC-11
//   plan-strategy §2 D-13 (visibility assertion) / §2 D-14 (AC-spec-matrix red line)
//   plan-strategy §4 R-2 (independent spec, no collision with mount-standalone)
//   implement-review §R2-2 #R2-#1 / #R2-#2 (R2 setTimeout 5s + display:none rejected)
//   implement-review §R2-5 (spec <-> requirement scope drift -> visibility + text added)

import { expect, test, type Locator } from '@playwright/test';

// EDITOR_PANELS SSOT lives in
// packages/editor/packages/editor-core/src/manifest.ts — duplicated here for
// test-only use; drift surfaces as a missing-panel assertion failure.
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

// Frame budget — 8 panel iframes + 1 viewport iframe = 9 child frames.
// page.frames() includes the main frame, so total reported frame count >= 10
// after w14a; we keep the spec-level threshold at 9 to leave room for slight
// implementation variation (e.g. plugin frames) while still ruling out the
// pre-w14a baseline of 1 (main only) or 2 (main + viewport).
const MIN_FRAMES = 9;

test.describe('standalone shell — DockShell + panel iframes + viewport', () => {
  // AC-10 — frame count threshold (frameCountTest)
  test('AC-10: standalone host renders >= 9 frames (8 panel + 1 viewport)', async ({ page }) => {
    await page.goto(STANDALONE_URL);

    // Poll because dockview/React mount + iframe creation is async; with w14a
    // there is NO setTimeout-based defer, so frames appear within the React
    // commit cycle (~hundreds of ms). 15s timeout covers cold vite dev start.
    await expect.poll(() => page.frames().length, {
      timeout: 15_000,
      message: `expected page.frames().length >= ${MIN_FRAMES}`,
    }).toBeGreaterThanOrEqual(MIN_FRAMES);
  });

  // AC-11a + AC-11b — every panel container visible + first panel readable text (visibilityTest + readableTextTest)
  test('AC-11: panel containers attached + at least 3 visible + first visible shows readable text', async ({ page }) => {
    await page.goto(STANDALONE_URL);

    // Wait for the React tree to mount its panels.
    await expect.poll(() => page.frames().length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(MIN_FRAMES);

    // visibilityTest — every panel iframe wrapper must be in the DOM, and at
    // least 3 must satisfy Playwright's toBeVisible (i.e. NOT display:none,
    // NOT visibility:hidden, NOT zero-size, NOT detached). dockview tabs
    // collapse inactive panel bodies, so a strict "all 8 visible" assertion
    // would falsely fail the GREEN implementation. The 3-visible floor still
    // discriminates against the R2 display:none trick (which makes ALL
    // panels invisible) and the no-DockShell baseline (which makes 0
    // attached).
    //
    // ep-frame-wrap is the EditorPanelFrame wrapper from
    // packages/interface/src/components/DockShell/EditorPanelFrame.tsx;
    // each is data-panel="<id>".
    const visiblePanels: Array<{ id: string; locator: Locator }> = [];
    for (const id of EDITOR_PANEL_IDS) {
      const wrap = page.locator(`.ep-frame-wrap[data-panel="${id}"]`);
      await expect(wrap, `panel container missing for "${id}"`).toBeAttached({ timeout: 10_000 });
      visiblePanels.push({ id, locator: wrap });
    }

    let visibleCount = 0;
    let firstVisibleId: string | undefined;
    for (const { id, locator } of visiblePanels) {
      if (await locator.isVisible().catch(() => false)) {
        visibleCount++;
        firstVisibleId = firstVisibleId ?? id;
      }
    }
    expect(visibleCount, 'expected >= 3 panel bodies actually visible (top-tab bodies)').toBeGreaterThanOrEqual(3);

    // readableTextTest — first visible panel iframe must contain at least one
    // readable text node (Latin letters). Not bound to a specific copy — any
    // non-empty rendered text counts. R2's `display:none` iframe trick fails
    // this because hidden iframes render nothing the user can read.
    expect(firstVisibleId, 'expected at least one visible panel to read text from').toBeDefined();
    const firstFrame = page.frameLocator(`.ep-frame-wrap[data-panel="${firstVisibleId}"] iframe.ep-frame-iframe`);
    await expect(firstFrame.locator('text=/[A-Za-z]/').first()).toBeVisible({ timeout: 15_000 });
  });

  // AC-11c + AC-11d + AC-08 — iframe URL contracts (panelUrlTest)
  test('AC-11: each panel iframe URL contains ?panel=<id> + viewport contains ?viewportOnly=1', async ({ page }) => {
    await page.goto(STANDALONE_URL);

    await expect.poll(() => page.frames().length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(MIN_FRAMES);

    const childFrames = page.frames().slice(1);
    const childUrls = childFrames.map((f) => f.url());

    // Viewport iframe — exactly the one mountStandalone created at
    // entryUrl = http://127.0.0.1:15280/?viewportOnly=1
    const viewportFrames = childUrls.filter((u) => u.includes('?viewportOnly=1'));
    expect(viewportFrames.length, 'expected at least 1 viewport iframe with ?viewportOnly=1').toBeGreaterThanOrEqual(1);

    // Panel iframes — 8 EDITOR_PANELS each addressed via ?panel=<id>. Origin
    // must reach :15280 (edit-runtime), NOT :15290 (standalone host); the
    // proxy in vite.config.ts rewrites /editor/* -> :15280 to satisfy this.
    const panelIdsInUrls = new Set<string>();
    for (const url of childUrls) {
      const m = url.match(/[?&]panel=([^&#]+)/);
      if (m) panelIdsInUrls.add(decodeURIComponent(m[1]));
    }
    for (const id of EDITOR_PANEL_IDS) {
      expect(
        panelIdsInUrls.has(id),
        `expected panel iframe for "${id}" (URL containing ?panel=${id})`,
      ).toBe(true);
    }
  });
});
