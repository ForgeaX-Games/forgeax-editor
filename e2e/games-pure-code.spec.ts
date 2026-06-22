// e2e — pure-code games smoke (spin-cube / shoot-opt). [t13]
//
// Neither game declares forge.json.defaultScene, so the host skips instantiate
// and calls the entry directly (D-8). Both build their world entirely in code:
// spin-cube spawns 24 cubes; shoot-opt spawns enemies + projectiles (it also
// instantiates a per-enemy scene-pack at runtime, unrelated to a defaultScene).
// spin-cube has an orphan scene.pack.json on disk that must NOT trigger the
// host (the host keys on the forge.json field, not the disk file — OOS-6).
//
// Smoke per game: load without forbidden error, entityCount > 0, canvas
// non-empty frame. No HUD assertion (shoot-opt has no DOM HUD).
//
// Anchors:
//   requirements AC-06 (pure-code skip path: no error, frame loop runs)
//   requirements AC-08 (canvas render)
//   plan-strategy D-8 (orphan pack does not trigger host) + research Finding 9

import { expect, test } from '@playwright/test';
import {
  assertEntityCount,
  assertNoForbiddenErrors,
  assertNonEmptyFrames,
  collectErrors,
  gotoGame,
} from './games-smoke-helpers';

test.describe('pure-code games smoke', () => {
  test('spin-cube: pure-code world spawns, renders, no defaultScene error', async ({ page }) => {
    const errors = collectErrors(page);
    await gotoGame(page, 'spin-cube');

    // 24 cubes + camera spawned purely in code; the orphan scene.pack.json on
    // disk must not have been instantiated by the host (no defaultScene field).
    await assertEntityCount(page);
    await assertNonEmptyFrames(page);
    assertNoForbiddenErrors(errors);
  });

  test('shoot-opt: pure-code world spawns, renders, no defaultScene error', async ({ page }) => {
    const errors = collectErrors(page);
    await gotoGame(page, 'shoot-opt');

    await assertEntityCount(page);
    await assertNonEmptyFrames(page);
    // No HUD assertion — shoot-opt has no DOM HUD.
    assertNoForbiddenErrors(errors);
  });
});
