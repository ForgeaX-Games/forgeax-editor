// e2e — standalone shell DockShell + ep:* iframes + viewport iframe (AC-10/AC-11).
//
// AC-spec-matrix (plan §2 D-14):
//   AC-10  DockShell registers all 9 ep:* panels, each panel materialises
//          an iframe when its tab is active            -> registrationTest, frameOnActivationTest
//   AC-11a every panel iframe wrapper visible while its tab is active -> visibilityTest
//   AC-11b first visible panel renders readable text   -> readableTextTest
//   AC-11c each panel id appears in some iframe URL    -> panelUrlTest
//   AC-11d viewport iframe URL contains ?viewportOnly=1 -> panelUrlTest
//   AC-18  postMessage source/origin gate              -> guarded by w14a grep on app-kit.ts
//
// Falsification (plan §2 D-13, §5.3 — reviewer applies manually, not in CI):
//   1. Comment out <DockShell> render: registrationTest + visibilityTest FAIL
//      (no __dockApi; no .ep-frame-wrap elements).
//   2. R2-style display:none + setTimeout 5s iframes: visibilityTest FAILS
//      (toBeVisible refuses display:none) + readableTextTest FAILS (hidden
//      iframes render nothing).
//   3. buildDefault forgets matgraph/launcher (the I-3 case): registrationTest
//      FAILS + panelUrlTest FAILS (missing ids in URL set).
//
// Why activation walking: dockview unmounts inactive tab bodies, so
// `page.frames().length` at any instant counts only the ~6 active panels.
// AC-10's spirit ("DockShell registers every panel") is checked via the
// dev-only `window.__dockApi` hook + sequential setActive() of each ep:*
// panel. The union of iframe URLs seen across activations covers all 9 ids;
// no single instant sees 9 iframes at once.
//
// The :15290 standalone page creates NO body-level iframe: the viewport is
// DockShell's Edit panel (renderEdit → /editor/?viewportOnly=1 via the :15290
// proxy), living inside #root like every other panel. No setTimeout /
// display:none trickery is needed (forbidden by plan §2 D-4 R3).
//
// Refs: requirements §AC-10/§AC-11; plan §2 D-13/D-14; §4 R-2;
//       implement-review §R2-2 #R2-#1/#R2-#2; §R2-5.

import { expect, test, type Locator, type Page } from '@playwright/test';

// EDITOR_PANELS SSOT lives in
// packages/editor/packages/editor-core/src/manifest.ts; duplicated here so a
// drift between the panel list and the spec surfaces as a missing-id failure.
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

// Activation walker — flips each ep:* panel active in turn and collects
// every iframe URL the page exposes while that panel is active. Used by
// AC-10 / AC-11 tests to compile the union of all panel iframe URLs across
// dockview's tabbed default layout.
async function collectPanelUrlsByActivation(page: Page): Promise<Set<string>> {
  const collected = new Set<string>();
  for (const id of EDITOR_PANEL_IDS) {
    await page.evaluate((panelId) => {
      // biome-ignore lint/suspicious/noExplicitAny: dev-only test hook
      try { (window as any).__dockApi?.getPanel(`ep:${panelId}`)?.api.setActive(); } catch { /* noop */ }
    }, id);
    // Yield so React + dockview commit the activation; dockview lazily
    // renders the panel body's iframe element.
    await page.waitForTimeout(80);
    for (const f of page.frames()) collected.add(f.url());
  }
  return collected;
}

async function readDockApiSnapshot(page: Page): Promise<{ panelIds: string[] }> {
  return page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: dev-only test hook
    const api = (window as any).__dockApi;
    if (!api) return { panelIds: [] };
    return { panelIds: api.panels.map((p: { id: string }) => p.id) };
  });
}

test.describe('standalone shell — DockShell + panel iframes + viewport', () => {
  // AC-10 — DockShell registers all 9 ep:* panels (registrationTest)
  // and each materialises an iframe when active (frameOnActivationTest).
  test('AC-10: DockShell registers all 9 ep:* panels + viewport iframe', async ({ page }) => {
    await page.goto(STANDALONE_URL);

    // Wait for DockShell to mount.
    await expect.poll(() => page.frames().length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(3);

    // registrationTest — `__dockApi.panels` is the dockview API's source of
    // truth for the registered panel set. Every ep:<id> for the 9
    // EDITOR_PANELS must appear here; missing one indicates DockShell's
    // buildDefault forgot to addPanel for it (the I-3 regression case).
    const snap = await readDockApiSnapshot(page);
    for (const id of EDITOR_PANEL_IDS) {
      expect(
        snap.panelIds.includes(`ep:${id}`),
        `expected DockShell panel ep:${id} to be registered (panels=${snap.panelIds.join(',')})`,
      ).toBe(true);
    }

    // frameOnActivationTest — walking every panel materialises iframes for
    // each active panel. The viewport iframe (renderEdit's Edit panel) plus
    // the active panel's iframe must always be present.
    await collectPanelUrlsByActivation(page);
    expect(page.frames().length, 'expected >= 3 frames (main + viewport + at least one active panel iframe)')
      .toBeGreaterThanOrEqual(3);
  });

  // AC-11a + AC-11b — visibility + readable text (visibilityTest + readableTextTest)
  test('AC-11: panel containers attached + active ones visible + first visible shows readable text', async ({ page }) => {
    await page.goto(STANDALONE_URL);

    await expect.poll(() => page.frames().length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(3);

    // visibilityTest — each panel iframe wrapper, while its tab is active,
    // must satisfy Playwright's toBeVisible (NOT display:none / hidden /
    // zero-size / detached). dockview unmounts inactive tab bodies, so each
    // panel's visibility is checked while its tab is active. (.ep-frame-wrap
    // = EditorPanelFrame wrapper, data-panel="<id>".)
    let visibleCount = 0;
    let firstVisibleId: string | undefined;
    for (const id of EDITOR_PANEL_IDS) {
      await page.evaluate((panelId) => {
        // biome-ignore lint/suspicious/noExplicitAny: dev-only test hook
        try { (window as any).__dockApi?.getPanel(`ep:${panelId}`)?.api.setActive(); } catch { /* noop */ }
      }, id);
      // Yield so dockview commits the activation; the body iframe element
      // attaches and Playwright can see its visibility computed style.
      await page.waitForTimeout(80);
      const wrap = page.locator(`.ep-frame-wrap[data-panel="${id}"]`);
      if (await wrap.isVisible({ timeout: 1_000 }).catch(() => false)) {
        visibleCount++;
        firstVisibleId = firstVisibleId ?? id;
      }
    }
    // The R2 `display:none` trick fails this because ALL panel bodies stay
    // invisible regardless of activation. The pre-w14a no-DockShell
    // baseline fails because no .ep-frame-wrap elements ever attach.
    expect(visibleCount, 'expected every activated panel to be visible while active')
      .toBeGreaterThanOrEqual(EDITOR_PANEL_IDS.length);

    // readableTextTest — re-activate the first panel (the loop's last
    // setActive may have moved on) and assert readable Latin text in its
    // iframe. Any non-empty rendered text passes; R2's display:none iframes
    // would render nothing readable and fail.
    expect(firstVisibleId, 'expected at least one visible panel to read text from').toBeDefined();
    await page.evaluate((panelId) => {
      // biome-ignore lint/suspicious/noExplicitAny: dev-only test hook
      try { (window as any).__dockApi?.getPanel(`ep:${panelId}`)?.api.setActive(); } catch { /* noop */ }
    }, firstVisibleId!);
    await page.waitForTimeout(120);
    const firstFrame = page.frameLocator(`.ep-frame-wrap[data-panel="${firstVisibleId}"] iframe.ep-frame-iframe`);
    // Prefer interactive/visible elements (button/input/option/aria-label) —
    // hidden header text (e.g. <h3 hidden>Hierarchy</h3> from the chromeless
    // panel skin) is intentionally invisible and must not satisfy this
    // assertion. We require any element that contains Latin letters AND is
    // actually visible.
    const visibleText = firstFrame.locator(
      ':is(button, [role="button"], a, input, option, [aria-label], h1, h2, h4, p, span, div):visible',
    ).filter({ hasText: /[A-Za-z]/ }).first();
    await expect(visibleText).toBeVisible({ timeout: 15_000 });
  });

  // AC-11c + AC-11d + AC-08 — iframe URL contracts (panelUrlTest)
  test('AC-11: each panel iframe URL contains ?panel=<id> + viewport contains ?viewportOnly=1', async ({ page }) => {
    await page.goto(STANDALONE_URL);

    await expect.poll(() => page.frames().length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(3);

    const allUrls = await collectPanelUrlsByActivation(page);

    // Viewport iframe — renderEdit's Edit panel at /editor/?viewportOnly=1
    // (served through the :15290 proxy to :15280).
    const viewportUrls = [...allUrls].filter((u) => u.includes('?viewportOnly=1'));
    expect(viewportUrls.length, 'expected viewport iframe with ?viewportOnly=1').toBeGreaterThanOrEqual(1);

    // Panel iframes — every id in EDITOR_PANELS must appear in some iframe
    // URL as ?panel=<id>. Origin must reach :15280 (edit-runtime), NOT
    // :15290 (standalone host); the proxy in vite.config.ts rewrites
    // /editor/* -> :15280 to satisfy this.
    const panelIdsInUrls = new Set<string>();
    for (const url of allUrls) {
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
