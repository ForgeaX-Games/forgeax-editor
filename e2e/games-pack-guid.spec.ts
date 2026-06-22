// e2e — pack+GUID games smoke (hellforge / test3 / cow-survivor). [t11] [t25]
//
// These three games carry a forge.json.defaultScene GUID, so the host
// resolves + instantiates the scene once and exposes the root + SceneAsset via
// GameContext (M3a). Each game's entry was rewritten (M3c) to consume the
// host-fed root instead of self-loading the same pack, so the scene must
// instantiate exactly once. The hellforge + test3 packs were data-migrated
// (M3b: material→materials, test3 nodes→entities) so the engine instantiates
// them without spawn-data-unknown-field.
//
// Three smoke assertions per game (AC-08): load without forbidden error,
// canvas non-empty frame, scene single-load (entity count > 0 and not doubled),
// plus HUD DOM where the game has one.
//
// t25 Falsification (plan-strategy D-3, plan-tasks t25): tightened
// SINGLE_LOAD_MAX bounds based on runtime-measured entity counts
// (hellforge=78/test3=65/cow=252, measured 2026-06-22 via world.inspect()).
// Bounds set at 85/85/350 — close enough to single-load baselines that
// a double-load variant (host instantiate + game self-load) would
// approximately double counts and exceed each bound. Named entity
// count assertions are not used because world.inspect() exposes only
// archetype-level counts (no per-entity-iteration API on the __forgeax
// global), per plan-tasks t25 fallback clause.
//
// Anchors:
//   requirements AC-04 (hellforge/cow/test3 scene single-load)
//   requirements AC-08 (6-game e2e smoke three assertions)
//   plan-strategy D-3 (tighten falsification sensitivity) + §5.3 (key test points)

import { expect, test } from '@playwright/test';
import {
  assertEntityCount,
  assertNoForbiddenErrors,
  assertNonEmptyFrames,
  collectErrors,
  gotoGame,
} from './games-smoke-helpers';

test.describe('pack+GUID games smoke', () => {
  test('hellforge: host-fed scene loads single, renders, HUD present', async ({ page }) => {
    const errors = collectErrors(page);
    await gotoGame(page, 'hellforge');

    // Scene single-load: the encampment pack (Ground + props + campfire) plus
    // the witch GLB + camera/lights spawn to ~78 entities (measured via
    // world.inspect() at e2e probe 2026-06-22). A double-load (host
    // instantiate + game self-load) roughly doubles this past the bound.
    const count = await assertEntityCount(page);
    const SINGLE_LOAD_MAX = 85;
    expect(count, `hellforge entity count ${count} exceeds single-load bound`).toBeLessThan(SINGLE_LOAD_MAX);

    await assertNonEmptyFrames(page);

    // hellforge HUD is a fixed-position overlay containing <kbd> control hints
    // (main.ts:383-392). No data-testid, so assert the <kbd> hints exist.
    await expect(page.locator('kbd').first()).toBeVisible({ timeout: 10_000 });

    assertNoForbiddenErrors(errors);
  });

  test('test3: host-fed scene loads single, renders, no spawn errors', async ({ page }) => {
    const errors = collectErrors(page);
    await gotoGame(page, 'test3');

    // test3's pack was nodes→entities + material→materials migrated; a missed
    // migration would surface spawn-data-unknown-field (asserted below) or an
    // empty world (entityCount 0, caught by assertEntityCount).
    // Baseline entity count ~65 (scene entities + camera/lights + physics
    // bodies). A double-load pushes this past the tightened bound of 85.
    const count = await assertEntityCount(page);
    const SINGLE_LOAD_MAX = 85;
    expect(count, `test3 entity count ${count} exceeds single-load bound`).toBeLessThan(SINGLE_LOAD_MAX);

    await assertNonEmptyFrames(page);

    // test3 has no DOM HUD — no HUD assertion (plan-strategy: skip where N/A).
    assertNoForbiddenErrors(errors);
  });

  test('cow-survivor: first-level host-fed scene loads single, renders, HUD present', async ({ page }) => {
    const errors = collectErrors(page);
    await gotoGame(page, 'cow-survivor');

    // First level (idx===0) takes the host-fed branch in loadLevel — the host
    // root + SceneAsset, no fetch+instantiate of level1. Entity count covers
    // the level scene + player + enemies + physics. Baseline ~252 (measured
    // via world.inspect() at e2e probe 2026-06-22). A double-load roughly
    // doubles this past the tightened bound of 350.
    const count = await assertEntityCount(page);
    const SINGLE_LOAD_MAX = 350;
    expect(count, `cow entity count ${count} exceeds single-load bound`).toBeLessThan(SINGLE_LOAD_MAX);

    await assertNonEmptyFrames(page);

    // cow HUD root carries id="forgeax-game-hud" (src/hud.ts:47,53).
    await expect(page.locator('#forgeax-game-hud')).toBeVisible({ timeout: 10_000 });

    assertNoForbiddenErrors(errors);
  });
});
