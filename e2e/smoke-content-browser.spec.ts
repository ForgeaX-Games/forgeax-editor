// e2e — Content Browser smoke: right-click context menu (Delete, Add to Scene)
// and basic interaction gating.
//
// Boots the games/sample standalone stack (same as smoke-boot-play.spec.ts)
// and exercises the Content Browser panel's core interactions:
//   1. Asset items render in the Content Browser
//   2. Right-click an asset → context menu appears with Delete / Add to Scene
//   3. Click Delete → DeleteGuardDialog appears
//   4. Cancel delete → dialog dismissed, asset still present
//
// GPU-tolerant by design: inherits the same WebGPU allowlist as the boot smoke.
// The Content Browser is a chrome panel (no WebGPU dependency), so these
// assertions work on any runner.

import { expect, test, type Page } from '@playwright/test';
import { collectErrors } from './games-smoke-helpers';

const STANDALONE_URL = 'http://127.0.0.1:15290/';
const WEBGPU_ALLOW = /RhiError|webgpu|WebGPU|GPUDevice|createBindGroup|requestAdapter|GPUAdapter/i;

const realErrors = (errors: { source: string; text: string }[]): string[] =>
  errors.filter((e) => !WEBGPU_ALLOW.test(e.text)).map((e) => `${e.source}: ${e.text.split('\n')[0]}`);

/**
 * Activate the Assets tab and wait for asset items to render.
 *
 * Default dock layout shows Hierarchy as the active tab; Assets is a sibling
 * tab in the same group. ContentBrowser is lazy-mounted and only populates
 * after engine boot sets the scene ID + registry fills pack-index data.
 * On CI (cold SwiftShader + bun install) this can take 30-60s total,
 * so we use expect.poll with a generous timeout.
 */
async function waitForAssets(page: Page) {
  // Activate Assets tab via DEV-mode __dockApi (set in DockRegion.onReady)
  const activated = await page.evaluate(() => {
    try {
      const api = (window as any).__dockApi;
      if (api) { api.getPanel('ep:assets')?.api.setActive(); return true; }
    } catch { /* noop */ }
    return false;
  });
  // Fallback: click the Assets tab in the dock tab bar
  if (!activated) {
    const tab = page.locator('.dv-tab', { hasText: /^Assets$/ });
    if (await tab.isVisible({ timeout: 3_000 }).catch(() => false)) await tab.click();
  }

  // Wait for ContentBrowser root (lazy Suspense boundary)
  await expect(page.locator('.cb-root')).toBeVisible({ timeout: 30_000 });

  // Poll until at least one asset item appears — registry population is async
  // (engine boot → pack-index fetch → listCatalog → broadcastAssetsChanged)
  await expect
    .poll(
      () => page.locator('[data-testid="cb-asset-item"]').count(),
      { timeout: 60_000, message: 'waiting for Content Browser to populate asset items' },
    )
    .toBeGreaterThan(0);
}

test.describe('smoke — Content Browser context menu interactions', () => {
  test.beforeEach(async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(STANDALONE_URL);
    await expect(page.locator('.fx-dockwrap')).toBeVisible({ timeout: 20_000 });
    // Let editor boot settle — engine init, scene load, registry population
    await page.waitForTimeout(5000);
    await waitForAssets(page);
    // Stash errors ref for test access (beforeEach errors are non-fatal)
    (page as any).__cbErrors = errors;
  });

  test('asset items render in the Content Browser', async ({ page }) => {
    const assetItems = page.locator('[data-testid="cb-asset-item"]');
    const count = await assetItems.count();
    expect(count, 'Content Browser should display at least one asset').toBeGreaterThan(0);
  });

  test('right-click asset shows context menu with Delete and Add to Scene', async ({ page }) => {
    const errors = collectErrors(page);
    const assetItem = page.locator('[data-testid="cb-asset-item"]').first();

    await assetItem.click({ button: 'right' });

    const ctxMenu = page.locator('.forgeax-ctx-menu-panel');
    await expect(ctxMenu).toBeVisible({ timeout: 5_000 });

    await expect(page.locator('[data-testid="ctx-menu-delete"]')).toBeVisible();
    await expect(page.locator('[data-testid="ctx-menu-add-to-scene"]')).toBeVisible();

    expect(realErrors(errors), 'no console errors after context menu open').toEqual([]);
  });

  test('Delete → guard dialog appears → Cancel dismisses it', async ({ page }) => {
    const errors = collectErrors(page);
    const assetItem = page.locator('[data-testid="cb-asset-item"]').first();

    await assetItem.click();
    await assetItem.click({ button: 'right' });

    const ctxMenu = page.locator('.forgeax-ctx-menu-panel');
    await expect(ctxMenu).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="ctx-menu-delete"]').click();

    const deleteDialog = page.locator('[data-testid="cb-delete-guard-modal"]');
    await expect(deleteDialog).toBeVisible({ timeout: 5_000 });

    const cancelBtn = page.locator('[data-testid="cb-delete-guard-cancel"]');
    await expect(cancelBtn).toBeVisible();
    await cancelBtn.click();

    await expect(deleteDialog).not.toBeVisible({ timeout: 3_000 });
    await expect(assetItem).toBeVisible();

    expect(realErrors(errors), 'no console errors during delete flow').toEqual([]);
  });

  test('Add to Scene dispatches without errors', async ({ page }) => {
    const errors = collectErrors(page);
    const anyAsset = page.locator('[data-testid="cb-asset-item"]').first();

    await anyAsset.click({ button: 'right' });

    const ctxMenu = page.locator('.forgeax-ctx-menu-panel');
    await expect(ctxMenu).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="ctx-menu-add-to-scene"]').click();
    await page.waitForTimeout(2000);

    expect(realErrors(errors), 'no console errors after Add to Scene').toEqual([]);
  });
});
