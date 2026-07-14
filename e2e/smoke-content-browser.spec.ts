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
// assertions work on any runner. NOT a required CI check (mirrors smoke-play).

import { expect, test } from '@playwright/test';
import { collectErrors } from './games-smoke-helpers';

const STANDALONE_URL = 'http://127.0.0.1:15290/';
const WEBGPU_ALLOW = /RhiError|webgpu|WebGPU|GPUDevice|createBindGroup|requestAdapter|GPUAdapter/i;

const realErrors = (errors: { source: string; text: string }[]): string[] =>
  errors.filter((e) => !WEBGPU_ALLOW.test(e.text)).map((e) => `${e.source}: ${e.text.split('\n')[0]}`);

test.describe('smoke — Content Browser context menu interactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(STANDALONE_URL);
    await expect(page.locator('.fx-dockwrap')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(3000);
  });

  test('asset items render in the Content Browser', async ({ page }) => {
    const errors = collectErrors(page);
    const assetItems = page.locator('[data-testid="cb-asset-item"]');
    await expect(assetItems.first()).toBeVisible({ timeout: 15_000 });

    const count = await assetItems.count();
    expect(count, 'Content Browser should display at least one asset').toBeGreaterThan(0);
    expect(realErrors(errors), 'no console errors while viewing assets').toEqual([]);
  });

  test('right-click asset shows context menu with Delete and Add to Scene', async ({ page }) => {
    const errors = collectErrors(page);
    const assetItem = page.locator('[data-testid="cb-asset-item"]').first();
    await expect(assetItem).toBeVisible({ timeout: 15_000 });

    await assetItem.click({ button: 'right' });

    const ctxMenu = page.locator('.forgeax-ctx-menu-panel');
    await expect(ctxMenu).toBeVisible({ timeout: 5_000 });

    const deleteItem = page.locator('[data-testid="ctx-menu-delete"]');
    await expect(deleteItem).toBeVisible();

    const addToSceneItem = page.locator('[data-testid="ctx-menu-add-to-scene"]');
    await expect(addToSceneItem).toBeVisible();

    expect(realErrors(errors), 'no console errors after context menu open').toEqual([]);
  });

  test('Delete → guard dialog appears → Cancel dismisses it', async ({ page }) => {
    const errors = collectErrors(page);
    const assetItem = page.locator('[data-testid="cb-asset-item"]').first();
    await expect(assetItem).toBeVisible({ timeout: 15_000 });

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
    const sceneAsset = page.locator('[data-testid="cb-asset-item"][data-asset-kind="scene"]').first();
    const anyAsset = page.locator('[data-testid="cb-asset-item"]').first();

    const target = (await sceneAsset.isVisible().catch(() => false)) ? sceneAsset : anyAsset;
    await expect(target).toBeVisible({ timeout: 15_000 });

    await target.click({ button: 'right' });

    const ctxMenu = page.locator('.forgeax-ctx-menu-panel');
    await expect(ctxMenu).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="ctx-menu-add-to-scene"]').click();
    await page.waitForTimeout(2000);

    expect(realErrors(errors), 'no console errors after Add to Scene').toEqual([]);
  });
});
