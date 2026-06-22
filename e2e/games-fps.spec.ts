// e2e — fps skip-path smoke. [t12]
//
// fps has NO forge.json.defaultScene field, so the host skips instantiate and
// calls the game entry directly (D-8). fps then runs its own private
// self-loading path (scene.json + codec + colliders projection + GltfRef) that
// exceeds the engine's instantiate capability — deliberately kept out of the
// migration (OOS-8). This smoke proves the skip path works: the scene + weapon
// + colliders spawn, the canvas renders, the HUD mounts, and NO defaultScene /
// forge-scene-unresolved error appears (which would mean the host wrongly tried
// to resolve a scene fps doesn't declare).
//
// Anchors:
//   requirements AC-06 (fps skip path: no error, frame loop runs)
//   requirements AC-08 (canvas render + HUD DOM)
//   plan-strategy D-8 (host skip criterion = forge.json.defaultScene absence)
//   research Finding 8 (fps private self-load preserved, OOS-8)

import { expect, test } from '@playwright/test';
import {
  assertEntityCount,
  assertNoForbiddenErrors,
  assertNonEmptyFrames,
  collectErrors,
  gotoGame,
} from './games-smoke-helpers';

test.describe('fps skip-path smoke', () => {
  test('fps: private self-load runs after host skip, renders, HUD present', async ({ page }) => {
    const errors = collectErrors(page);
    await gotoGame(page, 'fps');

    // fps spawns scene geometry + weapons + colliders via its private path.
    // entityCount > 0 confirms the entry ran and populated the world after the
    // host skipped instantiate.
    await assertEntityCount(page);

    await assertNonEmptyFrames(page);

    // fps HUD is a fixed overlay with a crosshair (#ssCross) and ammo readout
    // (#ssAmmo) built in main.ts buildHud(). Assert the ammo panel exists.
    await expect(page.locator('#ssAmmo')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#ssCross')).toBeAttached({ timeout: 10_000 });

    // No defaultScene/forge-scene-unresolved error → host correctly skipped
    // instantiate and went straight to entry (fps declares no defaultScene).
    assertNoForbiddenErrors(errors);
  });
});
