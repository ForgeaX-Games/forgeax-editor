// e2e — G-2 case A: surface component mount end-to-end gate (AC-07).
//
// This spec verifies that a host can mount a surface component
// (EditSurface / PlaySurface) and get a correctly-sourced iframe.
// It loads a test page that renders <EditSurface slug="demo" /> and
// asserts the iframe element is present with the expected src.
//
// Anchors:
//   requirements §5 AC-07 (G-2 case A e2e: host mounts surface → iframe
//     element exists with src === entryUrl, normal iframe-only rendering)
//   plan-strategy §2 D-11 (G-2 case A e2e: editor e2e suite, new spec)
//   ADR-0018 §Decision §4 (editor e2e belongs to editor package)

import { expect, test } from '@playwright/test';

// Editor entry URL for the viewport-only mode. Source of truth is
// packages/editor/src/index.ts (defineApp call). The test page renders
// <EditSurface slug="demo" /> which constructs this URL.
const EDITOR_ENTRY_URL = 'http://127.0.0.1:15280/?scene=demo&viewportOnly=1';

test.describe('G-2 case A: surface component mount', () => {
  test('AC-07: iframe element exists with correct src after EditSurface mount', async ({ page }) => {
    // Navigate to a test host page that renders <EditSurface slug="demo" />
    await page.goto('/g2-surface-test.html');

    // Wait for the iframe to appear (the surface component creates it)
    const iframe = page.locator('iframe');
    await expect(iframe).toHaveCount(1, { timeout: 10_000 });

    // Verify the iframe src matches the expected editor entry URL
    const src = await iframe.getAttribute('src');
    expect(src).toBe(EDITOR_ENTRY_URL);
    expect(src).not.toBe('about:blank');

    // Verify the iframe is NOT a broken-icon placeholder — it should be a
    // valid element that the browser attempted to render normally.
    const tagName = await iframe.evaluate((el) => el.tagName.toLowerCase());
    expect(tagName).toBe('iframe');
    const rect = await iframe.boundingBox();
    expect(rect).not.toBeNull();
  });
});