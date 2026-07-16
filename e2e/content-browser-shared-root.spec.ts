// Content Browser shared-root regression — package.json#forgeax.assets.roots is
// the sole scope declaration. The host projects those roots into catalog-source
// space at build time; ContentBrowser then derives its folder view from that map.
// This asserts the visible UX outcome for games/sample's declared Fox root.

import { expect, test } from '@playwright/test';

const STANDALONE_URL = 'http://127.0.0.1:15290/';

async function openAssets(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(STANDALONE_URL);
  await expect(page.locator('.fx-dockwrap')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(
    () => !!(window as unknown as { __forgeax_editor?: { gateway?: { doc?: { registry?: unknown } } } })
      .__forgeax_editor?.gateway?.doc?.registry,
    { timeout: 60_000 },
  );
  await page.evaluate(() => {
    (window as unknown as { __dockApi?: { getPanel: (id: string) => { api?: { setActive: () => void } } | undefined } })
      .__dockApi?.getPanel('ep:assets')?.api?.setActive();
  });
  await expect(page.locator('.cb-root')).toBeVisible({ timeout: 30_000 });
}

test('shows the declared @shared/characters Fox catalog root', async ({ page }) => {
  await openAssets(page);

  // The virtual root is hierarchical (`@shared/characters`), so drill through
  // its immediate `@shared` parent exactly as a person does in the grid.
  const sharedParent = page.locator('[data-testid="cb-folder-item"][data-folder-path="@shared"]');
  await expect(sharedParent).toBeVisible({ timeout: 60_000 });
  await sharedParent.dblclick();

  const sharedRoot = page.locator('[data-testid="cb-folder-item"][data-folder-path="@shared/characters"]');
  await expect(sharedRoot).toBeVisible({ timeout: 30_000 });
  await sharedRoot.dblclick();

  await expect(page.locator('[data-testid="cb-asset-item"][data-asset-name="Fox.glb"]').first())
    .toBeVisible({ timeout: 30_000 });
});
