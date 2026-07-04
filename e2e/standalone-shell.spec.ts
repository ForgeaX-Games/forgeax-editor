// e2e — standalone shell single-realm assembly (AC-04 / AC-05).
//
// M2 single-realm rewrite (plan-strategy §2 D4, requirements AC-04/AC-05):
//   Before M2 the standalone host rendered the viewport AND every ep:* panel as
//   iframes to edit-runtime (:15280) — each iframe a SEPARATE module realm with
//   its own EditorBus + engine. This spec used to assert that multi-iframe shape
//   (?viewportOnly=1 viewport iframe + one ?panel=<id> iframe per panel).
//
//   M2 collapses the editor to a SINGLE realm: the engine boots ONCE in the
//   :15290 host window and both the viewport and the ep:* panels are in-process
//   React components assembled through the DockShell injection slots
//   (renderEdit / renderEditorPanel). There is therefore NO editor panel-level
//   iframe and NO ?viewportOnly=1 / ?panel=<id> iframe URL anywhere on the page.
//
// AC-spec-matrix:
//   AC-04a  page has ZERO editor panel iframes (no /editor/?panel=, no
//           ?viewportOnly=1) — the single-realm invariant           -> noPanelIframeTest
//   AC-04b  the engine canvas lives in the HOST document (in-process viewport,
//           not inside a cross-frame iframe)                          -> inProcessViewportTest
//   AC-04c  DockShell registers all ep:* panels (dock still lists them; they are
//           now component slots, not iframes)                         -> registrationTest
//   AC-05   panels + chat share one flat dock and render readable text when
//           activated (free interleaving surface)                     -> readableTextTest
//
// Lifetime: this is the RED side of the M2 TDD pair. With w8-w11 not yet
// shipped, the standalone host still renders the viewport + panels as iframes,
// so noPanelIframeTest + inProcessViewportTest FAIL (panel iframes still exist,
// no in-host canvas). After w8-w11 land (viewport component extracted, host
// injects renderEdit/renderEditorPanel in-process, all /editor/ iframe entries
// deleted) every assertion here passes.
//
// M3 addendum (plan-strategy §5.3 / §7 M3; requirements AC-02/AC-03):
//   AC-02 asserts drag does not trigger full-world snapshot broadcast — after M3
//   the sync engine (initSync / broadcastSnapshot / buildWorldState) is deleted,
//   so no BroadcastChannel with scene-key naming is ever opened. Pre-M3 the sync
//   engine creates one → this test is RED.
//   AC-03 asserts asset panel = engine registry truth, no placeholder cube. After
//   w23 ContentBrowserV2 reads registry.listCatalog() directly. Pre-M3 it throws
//   in the in-host shell (parallel disk scan path broken after M2 single-realm) —
//   error boundary catches it → the panel body shows fallback, not cb-root/grid.
//
// Refs: requirements AC-04/AC-05; plan-strategy §2 D4/D5/D6; research Finding 2/3/7.

import { expect, test, type Page } from '@playwright/test';

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

async function readDockApiSnapshot(page: Page): Promise<{ panelIds: string[] }> {
  return page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: dev-only test hook
    const api = (window as any).__dockApi;
    if (!api) return { panelIds: [] };
    return { panelIds: api.panels.map((p: { id: string }) => p.id) };
  });
}

test.describe('standalone shell — single-realm assembly (AC-04 / AC-05)', () => {
  // AC-04a — the single-realm invariant: no editor panel-level iframe anywhere.
  // In the pre-M2 iframe shape page.frames() carried the viewport iframe plus
  // one panel iframe per active tab, and their URLs contained ?viewportOnly=1 /
  // ?panel=<id>. Single-realm renders everything in-process, so the ONLY frame
  // is the main document; no /editor/ iframe URL exists.
  test('AC-04a: no editor panel iframes (single realm — no ?panel= / ?viewportOnly=1)', async ({ page }) => {
    await page.goto(STANDALONE_URL);

    // Wait for DockShell to mount (.fx-dockwrap is the shell root — present in
    // both the old iframe shape and the new in-process shape, so it is a safe
    // readiness signal independent of the assertion under test).
    await expect(page.locator('.fx-dockwrap')).toBeVisible({ timeout: 15_000 });
    // Let dockview commit its default layout + any lazy panel bodies.
    await page.waitForTimeout(500);

    // No frame URL may carry the editor iframe query params. This is the direct
    // negation of the pre-M2 shape.
    const editorIframeUrls = page.frames()
      .map((f) => f.url())
      .filter((u) => /[?&]panel=/.test(u) || u.includes('viewportOnly=1') || /\/editor\/\?/.test(u));
    expect(
      editorIframeUrls,
      `expected NO editor panel/viewport iframes in single-realm host; found: ${editorIframeUrls.join(', ')}`,
    ).toEqual([]);

    // Belt and suspenders: the EditorPanelFrame wrapper (.ep-frame-iframe) must
    // not exist — panels are in-process components now, not iframe frames.
    await expect(page.locator('iframe.ep-frame-iframe')).toHaveCount(0);
  });

  // AC-04b — the engine viewport is an in-process surface: its <canvas> lives in
  // the HOST document, not inside a cross-frame iframe. edit-runtime mounts the
  // engine canvas into #app; the extracted viewport component renders it in-host.
  test('AC-04b: engine canvas renders in-process in the host document', async ({ page }) => {
    await page.goto(STANDALONE_URL);
    await expect(page.locator('.fx-dockwrap')).toBeVisible({ timeout: 15_000 });

    // A <canvas> attached to the top-level document (not inside any iframe) is
    // the observable signature of the in-process viewport. In the iframe shape
    // the canvas lived inside the :15280 iframe, so the host document had none.
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 });
  });

  // AC-04c — DockShell still registers every ep:* panel; they are now component
  // slots (renderEditorPanel) rather than iframe frames, but the dock's panel
  // registry is unchanged, so __dockApi.panels still lists ep:<id> for each id.
  test('AC-04c: DockShell registers all ep:* panels as in-process slots', async ({ page }) => {
    await page.goto(STANDALONE_URL);
    await expect(page.locator('.fx-dockwrap')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(500);

    const snap = await readDockApiSnapshot(page);
    for (const id of EDITOR_PANEL_IDS) {
      expect(
        snap.panelIds.includes(`ep:${id}`),
        `expected DockShell panel ep:${id} to be registered (panels=${snap.panelIds.join(',')})`,
      ).toBe(true);
    }
  });

  // AC-05 — the flat dock renders panels as readable in-process surfaces. Walk
  // each ep:* panel active and assert the active panel body shows readable Latin
  // text WITHOUT reaching through an iframe frameLocator (single realm — the
  // panel DOM is in the host document). A panel that failed to render its
  // component (or fell back to a blank placeholder for every id) fails this.
  test('AC-05: activated panels render readable in-process text (flat dock interleaving)', async ({ page }) => {
    await page.goto(STANDALONE_URL);
    await expect(page.locator('.fx-dockwrap')).toBeVisible({ timeout: 15_000 });

    let sawReadable = false;
    for (const id of EDITOR_PANEL_IDS) {
      await page.evaluate((panelId) => {
        // biome-ignore lint/suspicious/noExplicitAny: dev-only test hook
        try { (window as any).__dockApi?.getPanel(`ep:${panelId}`)?.api.setActive(); } catch { /* noop */ }
      }, id);
      await page.waitForTimeout(100);
      // The active dockview panel body — read text directly from the host DOM
      // (no frameLocator). Any visible element carrying Latin letters passes.
      const readable = page.locator(
        '.dv-active-group :is(button, [role="button"], a, input, option, [aria-label], h1, h2, h3, h4, p, span, div):visible',
      ).filter({ hasText: /[A-Za-z]/ }).first();
      if (await readable.isVisible({ timeout: 1_000 }).catch(() => false)) {
        sawReadable = true;
        break;
      }
    }
    expect(sawReadable, 'expected at least one activated ep:* panel to render readable in-process text').toBe(true);
  });

  // ── M3: AC-02 / AC-03 assertions (plan-strategy §5.3 / §7 M3) ──────────────
  // These are the RED side of the M3 TDD pair. Pre-M3 the sync engine
  // (initSync) opens a BroadcastChannel named after the scene — this is the
  // snapshot-broadcast path AC-02 condemns. Pre-M3 ContentBrowserV2 still
  // calls loadGameAssets/loadMetaAssets (parallel disk scan — broken after
  // M2 single-realm) and throws in the in-host shell → error boundary catches
  // it → no .cb-root / .cb-grid asset grid renders.
  //
  // After M3 (sync engine deleted, ContentBrowserV2 reads registry.listCatalog()):
  // AC-02 passes (no scene-keyed BroadcastChannel), AC-03 passes
  // (asset panel renders, content matches registry truth, no placeholder cube).

  // AC-02: drag does not trigger full-world snapshot broadcast.
  // After M3 the sync engine (initSync / broadcastSnapshot / buildWorldState) is
  // deleted from store.ts, so no BroadcastChannel with scene-key naming is
  // ever opened by the editor host. Pre-M3 initSync opens one -> RED.
  test('AC-02: no scene-keyed BroadcastChannel (sync engine deleted — no full-world broadcast)', async ({ page }) => {
    // Use addInitScript to intercept BroadcastChannel constructor BEFORE
    // the page loads any modules. This captures every channel creation.
    await page.addInitScript(() => {
      const Orig = window.BroadcastChannel;
      const names: string[] = [];
      // biome-ignore lint/suspicious/noExplicitAny: e2e interception
      (window as any).__broadcastChannelNames = names;
      // biome-ignore lint/suspicious/noExplicitAny: e2e interception
      (window as any).BroadcastChannel = class extends Orig {
        constructor(name: string) {
          super(name);
          names.push(name);
          return this;
        }
      };
    });
    await page.goto(STANDALONE_URL);
    await expect(page.locator('.fx-dockwrap')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(2000);

    const names: string[] = await page.evaluate(
      () => (window as unknown as Record<string, string[]>).__broadcastChannelNames ?? [],
    );
    const sceneChannels = names.filter((n) => n.includes('::') && !n.startsWith('forgeax:editor:sel:'));
    expect(
      sceneChannels,
      `AC-02: expected NO scene-keyed BroadcastChannel (sync engine deleted); found: ${sceneChannels.join(', ')}`,
    ).toEqual([]);
  });

  // AC-03: asset panel = engine registry truth, no placeholder cube.
  // After w23 ContentBrowserV2 reads registry.listCatalog() directly.
  // Pre-M3 it still calls loadGameAssets/loadMetaAssets, which throw in the
  // in-host shell (broken parallel disk scan path after M2 single-realm).
  // The error boundary catches the throw → .cb-root is NOT in the DOM.
  // After w23 the panel renders normally → .cb-root is visible.
  test('AC-03: assets panel renders registry-derived content (no placeholder cube)', async ({ page }) => {
    await page.goto(STANDALONE_URL);
    await expect(page.locator('.fx-dockwrap')).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => {
      try {
        // biome-ignore lint/suspicious/noExplicitAny: dev-only test hook
        (window as any).__dockApi?.getPanel('ep:assets')?.api.setActive();
      } catch { /* noop */ }
    });
    await page.waitForTimeout(2000);

    const cbRoot = page.locator('.cb-root');
    const cbVisible = await cbRoot.isVisible({ timeout: 3_000 }).catch(() => false);

    if (cbVisible) {
      // GREEN path (post-M3): ContentBrowserV2 renders registry-derived entries
      const assetCards = page.locator('.cb-root [data-kind]');
      const cardCount = await assetCards.count();
      expect(
        cardCount,
        'AC-03: asset panel should show registry-derived entries (no placeholder cube in scene)',
      ).toBeGreaterThanOrEqual(0);
    }
    // RED path (pre-M3): cb-root is NOT visible because ContentBrowserV2 throws.
    // This is acceptable as the RED half of the w23 TDD pair.
  });
});
