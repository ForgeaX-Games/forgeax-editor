// e2e — standalone Play mode (▶/FPS/canvas/■ chain + falsification check).
//
// AC-04 (plan-strategy D-2): the standalone :15290 host loads games/sample
// (webServer #1 injects FORGEAX_GAME_DIR) and the Play chain proceeds:
//   ViewportBar ▶ click → playSimulation → run='play' + display='game' →
//   ViewportChrome switches to GameOverlay → FPS readout appears →
//   engine render loop produces non-black canvas frames →
//   ■ click → stopSimulation → run='edit' + display='scene' → ViewportBar returns.
//
// Falsification variants (§5.4): two expected-to-fail tests prove assertion
// discrimination — (a) asserting Play state without clicking Play fails,
// (b) asserting non-black canvas after stopping Play fails. These are NOT
// CI gates; they document that the assertions are sensitive to actual Play
// state vs a degenerate "always passes" check.
//
// The engine requires wasm artefacts (wgpu-wasm via bun run setup) to render
// any non-black frames. In environments without wasm the canvas assertion may
// not pass; the spec is designed to be run in CI where wasm is prebuilt.
//
// Ref: requirements AC-04; plan-strategy §5.4; research Finding "e2e spec + Play trigger".

import { expect, test } from '@playwright/test';

const STANDALONE_URL = 'http://127.0.0.1:15290/';

test.describe('play-mode — standalone ▶ Play / FPS / canvas / ■ Stop chain (AC-04)', () => {
  test('▶ Play activates play mode and shows FPS readout', async ({ page }) => {
    await page.goto(STANDALONE_URL);
    // Wait for the standalone chrome shell to mount. The ViewportBar renders
    // at display='scene' (initial state) with vp-play / vp-stop / vp-fps.
    await expect(page.locator('.fx-dockwrap')).toBeVisible({ timeout: 15_000 });

    // Click ▶ Play in ViewportBar. This sets run='play' + display='game',
    // which causes ViewportChrome to swap ViewportBar -> GameOverlay.
    await page.locator('[data-testid="vp-play"]').click();

    // GameOverlay renders when display='game'. The FPS readout span is always
    // in the DOM (even when CSS-hidden by the hover gate), so toBeAttached is
    // sufficient and does not depend on hover state.
    await expect(page.locator('[data-testid="game-overlay-fps"]'))
      .toBeAttached({ timeout: 10_000 });

    // Poll FPS value — the frame-loop accumulator (installFpsReport) updates
    // every ~1 s. The text format is "{fps} FPS" (GameOverlay.tsx:72-73).
    // Initial fps is 0; the first non-zero sample appears after ~1 s.
    await expect.poll(
      () => page.locator('[data-testid="game-overlay-fps"]').textContent(),
      { timeout: 30_000 },
    ).toMatch(/[1-9]\d* FPS/);
  });

  test('Canvas renders non-black frames during Play', async ({ page }) => {
    await page.goto(STANDALONE_URL);
    await expect(page.locator('.fx-dockwrap')).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-testid="vp-play"]').click();
    await expect(page.locator('[data-testid="game-overlay-fps"]'))
      .toBeAttached({ timeout: 10_000 });

    // Let the render loop produce at least a few frames before sampling.
    await page.waitForTimeout(2000);

    // Sample downscaled canvas pixels via drawImage → 2D context. WebGPU
    // canvases are composited by the browser; drawImage captures the
    // composited result regardless of the rendering API.
    const nonBlack = await page.evaluate(() => {
      const canvas = document.querySelector('canvas#app') as HTMLCanvasElement | null;
      if (!canvas || canvas.width === 0 || canvas.height === 0) return false;
      const offscreen = document.createElement('canvas');
      const sampleSize = Math.min(Math.min(canvas.width, canvas.height), 64);
      offscreen.width = sampleSize;
      offscreen.height = sampleSize;
      const ctx = offscreen.getContext('2d');
      if (!ctx) return false;
      // Draw the full canvas scaled down to sampleSize x sampleSize.
      ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height,
        0, 0, sampleSize, sampleSize);
      const data = ctx.getImageData(0, 0, sampleSize, sampleSize).data;
      for (let i = 0; i < data.length; i += 4) {
        // Check if any RGB component is non-zero.
        if (data[i]! > 0 || data[i + 1]! > 0 || data[i + 2]! > 0) return true;
      }
      return false;
    });
    expect(nonBlack, 'canvas should render non-black frames during Play').toBe(true);
  });

  test('Escape releases Play input to editor controls without stopping simulation', async ({ page }) => {
    await page.goto(STANDALONE_URL);
    await expect(page.locator('.fx-dockwrap')).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-testid="vp-play"]').click();
    await expect(page.locator('[data-testid="game-overlay-fps"]'))
      .toBeAttached({ timeout: 10_000 });

    // Play starts as observation. Exercise the actual possession path before
    // asking Escape to exit it.
    await page.locator('canvas#app').click({ position: { x: 8, y: 80 } });
    await expect.poll(() => page.evaluate(() => {
      const editor = (window as unknown as {
        __forgeax_editor?: { getViewportQuadrant: () => { inputTarget: string } };
      }).__forgeax_editor;
      return editor?.getViewportQuadrant().inputTarget;
    })).toBe('game');

    // Escape must un-possess play·game → play·scene. The restored ■ control (not
    // ▶) proves the simulation continues while editor controls are available.
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="vp-stop"]'))
      .toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="vp-play"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="game-overlay-fps"]')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => {
      const editor = (window as unknown as {
        __forgeax_editor?: {
          getViewportQuadrant: () => {
            run: string;
            display: string;
            inputTarget: string;
          };
        };
      }).__forgeax_editor;
      return editor?.getViewportQuadrant();
    })).toMatchObject({ run: 'play', display: 'scene', inputTarget: 'editor' });
  });

  test('clicking a dock panel revokes game input control', async ({ page }) => {
    await page.goto(STANDALONE_URL);
    await expect(page.locator('.fx-dockwrap')).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-testid="vp-play"]').click();
    await expect(page.locator('[data-testid="game-overlay-fps"]'))
      .toBeAttached({ timeout: 10_000 });

    // Play starts as observation. A trusted canvas click explicitly grants the
    // game lease; a later dock-panel click must revoke it before that panel
    // receives its own interaction.
    await page.locator('canvas#app').click({ position: { x: 8, y: 80 } });
    await expect.poll(() => page.evaluate(() => {
      const editor = (window as unknown as {
        __forgeax_editor?: { getViewportQuadrant: () => { inputTarget: string } };
      }).__forgeax_editor;
      return editor?.getViewportQuadrant().inputTarget;
    })).toBe('game');

    await page.getByRole('heading', { name: /^Hierarchy/ }).click();
    await expect.poll(() => page.evaluate(() => {
      const editor = (window as unknown as {
        __forgeax_editor?: {
          getViewportQuadrant: () => { control: string; inputTarget: string };
        };
      }).__forgeax_editor;
      return editor?.getViewportQuadrant();
    })).toMatchObject({ control: 'editor', inputTarget: 'editor' });
  });

  test('■ Stop returns to Edit mode', async ({ page }) => {
    await page.goto(STANDALONE_URL);
    await expect(page.locator('.fx-dockwrap')).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-testid="vp-play"]').click();
    await expect(page.locator('[data-testid="game-overlay-fps"]'))
      .toBeAttached({ timeout: 10_000 });

    // Click ■ Stop. The GameOverlay renders the same button element for
    // Play/Stop; its label switches ▶/■ based on quadrant.run. Use force:true
    // because the GameOverlay has a hover gate (CSS opacity 0 when cursor is
    // outside the ~40px trigger zone).
    await page.locator('[data-testid="game-overlay-play"]')
      .click({ force: true });

    // After Stop, the quadrant returns to run='edit' + display='scene'.
    // ViewportChrome swaps back to ViewportBar, which renders vp-play (▶).
    await expect(page.locator('[data-testid="vp-play"]'))
      .toBeVisible({ timeout: 10_000 });
  });

  // ── Falsification variants (plan-strategy §5.4) ──────────────────────────
  // These MUST FAIL to prove the assertions above have discrimination power.
  // They use test.fail() so Playwright reports them as "expected to fail"
  // rather than as CI failures. The key insight: if these variants PASSED,
  // the real assertions above would be vacuous (always passing regardless of
  // Play state).

  test.fail('FALSIFICATION: Play-state assertion fails without clicking Play', async ({ page }) => {
    await page.goto(STANDALONE_URL);
    await expect(page.locator('.fx-dockwrap')).toBeVisible({ timeout: 15_000 });

    // Assert GameOverlay FPS exists WITHOUT ever clicking Play.
    // This MUST fail — GameOverlay is only rendered when display='game',
    // and display stays 'scene' until Play is pressed. If this passed,
    // the "FPS readout" assertion in the Play test above would be vacuous
    // (the element would exist regardless of Play state).
    await expect(page.locator('[data-testid="game-overlay-fps"]'))
      .toBeAttached({ timeout: 5_000 });
  });

  test.fail('FALSIFICATION: Canvas non-black fails when Play stopped', async ({ page }) => {
    await page.goto(STANDALONE_URL);
    await expect(page.locator('.fx-dockwrap')).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-testid="vp-play"]').click();
    await expect(page.locator('[data-testid="game-overlay-fps"]'))
      .toBeAttached({ timeout: 10_000 });
    await page.waitForTimeout(1500);

    // Stop Play — the simulation halts and the canvas may freeze.
    await page.locator('[data-testid="game-overlay-play"]')
      .click({ force: true });
    await expect(page.locator('[data-testid="vp-play"]'))
      .toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(500);

    // Now sample canvas pixels. After stopping Play, the render loop is
    // paused — the canvas frame is frozen. The non-black assertion MUST FAIL
    // (the frozen frame might still contain color, so this falsification
    // relies on the canvas being cleared or going dark after stop — if it
    // passes, the canvas pixel check in the Play test is non-discriminating
    // and would also pass on a static/frozen canvas).
    const nonBlack = await page.evaluate(() => {
      const canvas = document.querySelector('canvas#app') as HTMLCanvasElement | null;
      if (!canvas || canvas.width === 0 || canvas.height === 0) return true;
      const offscreen = document.createElement('canvas');
      const sampleSize = Math.min(Math.min(canvas.width, canvas.height), 64);
      offscreen.width = sampleSize;
      offscreen.height = sampleSize;
      const ctx = offscreen.getContext('2d');
      if (!ctx) return true;
      ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height,
        0, 0, sampleSize, sampleSize);
      const data = ctx.getImageData(0, 0, sampleSize, sampleSize).data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! > 0 || data[i + 1]! > 0 || data[i + 2]! > 0) return true;
      }
      return false;
    });
    expect(nonBlack, 'falsification: canvas should not be non-black after stopping Play')
      .toBe(true);
  });
});
