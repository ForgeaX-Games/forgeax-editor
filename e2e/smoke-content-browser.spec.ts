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
// The Content Browser is a chrome panel (no WebGPU dependency for UI wiring),
// but the asset LIST comes from AssetRegistry.listCatalog() which is filled via
// pack-index fetch — ContentBrowser.reload() now calls refreshCatalog() so a
// late-mounted Assets tab still populates without relying on a missed broadcast.

import { expect, test, type Page } from '@playwright/test';
import { collectErrors } from './games-smoke-helpers';

const STANDALONE_URL = 'http://127.0.0.1:15290/';
const WEBGPU_ALLOW = /RhiError|webgpu|WebGPU|GPUDevice|createBindGroup|requestAdapter|GPUAdapter/i;

const realErrors = (errors: { source: string; text: string }[]): string[] =>
  errors.filter((e) => !WEBGPU_ALLOW.test(e.text)).map((e) => `${e.source}: ${e.text.split('\n')[0]}`);

/** Vite pack-index is served once pluginPack boots — proves game catalog exists. */
async function waitForPackIndex(page: Page): Promise<number> {
  let count = 0;
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`${STANDALONE_URL}pack-index.json`);
        if (!res.ok()) return 0;
        const body = await res.json();
        const entries = Array.isArray(body) ? body : (body as { assets?: unknown[] })?.assets;
        count = Array.isArray(entries) ? entries.length : 0;
        return count;
      },
      { timeout: 60_000, message: 'waiting for /pack-index.json to serve game assets' },
    )
    .toBeGreaterThan(0);
  return count;
}

/**
 * Activate Assets tab and wait until ContentBrowser renders at least one asset.
 *
 * UE-parity: root path shows folders only (non-recursive). games/sample packs
 * live under `assets/…`, so we drill into that folder before asserting items.
 * Re-clicks Save All while polling so a still-empty first mount re-reads after
 * refreshCatalog settles.
 */
async function waitForAssets(page: Page) {
  const activated = await page.evaluate(() => {
    try {
      const api = (window as any).__dockApi;
      if (api) { api.getPanel('ep:assets')?.api.setActive(); return true; }
    } catch { /* noop */ }
    return false;
  });
  if (!activated) {
    const tab = page.locator('.dv-tab', { hasText: /^Assets$/ });
    if (await tab.isVisible({ timeout: 3_000 }).catch(() => false)) await tab.click();
  }

  await expect(page.locator('.cb-root')).toBeVisible({ timeout: 30_000 });

  // Wait until scoped catalog has content (folder and/or asset at any level)
  await expect
    .poll(
      async () => {
        const saveAll = page.locator('.cb-toolbar-btn', { hasText: 'Save All' });
        if (await saveAll.isVisible().catch(() => false)) await saveAll.click().catch(() => {});
        const folders = await page.locator('[data-testid="cb-folder-item"]').count();
        const assets = await page.locator('[data-testid="cb-asset-item"]').count();
        return folders + assets;
      },
      { timeout: 60_000, message: 'waiting for Content Browser folder/asset entries' },
    )
    .toBeGreaterThan(0);

  // Drill into assets/ if we're still on the root (folders only, no pack files)
  if ((await page.locator('[data-testid="cb-asset-item"]').count()) === 0) {
    const folder = page.locator('[data-testid="cb-folder-item"][data-folder-path="assets"]').first();
    const sourceItem = page.locator('.cb-source-item', { hasText: /assets/ }).first();
    if (await folder.isVisible().catch(() => false)) {
      await folder.dblclick();
    } else if (await sourceItem.isVisible().catch(() => false)) {
      await sourceItem.click();
    }
  }

  await expect
    .poll(
      () => page.locator('[data-testid="cb-asset-item"]').count(),
      { timeout: 30_000, message: 'waiting for Content Browser assets inside assets/ folder' },
    )
    .toBeGreaterThan(0);
}

test.describe('smoke — Content Browser context menu interactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(STANDALONE_URL);
    await expect(page.locator('.fx-dockwrap')).toBeVisible({ timeout: 20_000 });
    // Pack catalog must be served before we expect the Assets panel to fill.
    await waitForPackIndex(page);
    // Engine boot (createApp) sets __forgeax_editor; give it a soft wait so
    // gateway.doc.registry is wired before ContentBrowser's first reload.
    await page.waitForFunction(
      () => !!(window as any).__forgeax_editor?.gateway?.doc?.registry,
      { timeout: 60_000 },
    ).catch(() => {
      // GPU-less runners may fail createApp — pack-index still exists; CB may
      // stay empty. Subsequent poll will surface a clear failure message.
    });
    await waitForAssets(page);
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
