// e2e — real-game Play safety net (--game games/sample launch + ▶ Play chain).
//
// PURPOSE (requirements AC-05/AC-06/AC-07; plan-strategy §7 M2, D-7/D-8):
// A mechanical safety net that catches the "single-realm 8-defect" integration
// class (standalone all-white, viewport chrome escape, Play canvas null, Assets
// first-load empty, Hierarchy empty tree) at the verify step rather than after
// delivery. The playwright config's webServer #1 injects FORGEAX_GAME_DIR=
// games/sample, so the standalone :15290 host boots with a REAL game loaded —
// this spec drives ▶ Play on that game and asserts the Play chain mounts.
//
// TWO-TIER PROPOSITION (the core design — AI developers read this header to know
// the run boundary):
//
//   ── LIGHT TIER (default; NO wasm required; enters the ordinary gate) ────────
//   Asserts ONLY the Play-chain mount: after ▶, the engine canvas exists and the
//   GameOverlay FPS readout is attached to the DOM. These signals prove the chain
//   ViewportBar ▶ → playSimulation → run='play' + display='game' → ViewportChrome
//   swaps to GameOverlay → FPS readout mounts — WITHOUT rendering a single frame.
//   Deliberately contains NO non-black / pixel assertion and NO fps>0 poll: those
//   need the wgpu-wasm render loop and would fail in a no-wasm environment. This
//   is the part that catches the no-wasm-observable link-mount defects (canvas
//   null, chrome not swapping, overlay never mounting).
//
//   ── HEAVY TIER (needs wgpu-wasm; belongs to the studio heavy CI) ────────────
//   Real non-black-frame rendering (canvas pixel sampling + fps>0). This needs
//   the engine's wgpu-wasm artefact (built by `bun run setup`; NEVER committed —
//   zero-binary invariant). It is GATED behind FORGEAX_E2E_WASM and skips by
//   default so a no-wasm environment never fails. It reuses the play-mode.spec.ts
//   :52-86 pixel-sampling pattern. This tier is explicitly OUT of the editor's
//   lightweight gate / selfcheck:b2 (AC-07; selfcheck-standalone-b2.mjs stays
//   no-wasm/no-render). Enable it in the studio heavy CI where wasm is prebuilt:
//   FORGEAX_E2E_WASM=1 bun run test:e2e e2e/play-real-game-safety-net.spec.ts
//
// VERIFY-FLOW REFERENCE (D-6 editor-side discoverability anchor):
// This spec is referenced by the verify flow's --game run-list — see the harness
// forgeax-step-verify skill (agents/verify-unified-reviewer.md). The verify
// reviewer runs the LIGHT tier every loop; the HEAVY tier is deferred to studio
// CI. The two-way discoverability (harness run-list → this path; this header →
// verify usage) is the AC-08 carrier.
//
// Anchors:
//   requirements AC-05 (--game launch + enter Play, reuse existing probes)
//   requirements AC-06 (light tier runs in no-wasm env, no pixel assertion)
//   requirements AC-07 (heavy tier marked needs-wasm/studio, not in light gate)
//   requirements AC-08 (verify skill run-list references this spec) via D-6
//   requirements AC-09 (M2 footprint limited to e2e/; zero overlap with M1)
//   plan-strategy D-7 (games/sample sample) + D-8 (light/heavy tier boundary)
//   research Finding A3 (games/sample covers Play-chain mount + FPS scope)

import { expect, test } from '@playwright/test';

// The playwright config's webServer #1 boots `bun run dev` at :15290 with
// FORGEAX_GAME_DIR=games/sample, so navigating here lands on a real game loaded
// in the standalone host (no separate --game flag needed at the spec level —
// the game dir is wired in the webServer env).
const STANDALONE_URL = 'http://127.0.0.1:15290/';

// Heavy tier opt-in. Default OFF → the pixel/fps test skips in any no-wasm
// environment (the editor's ordinary gate). Studio heavy CI sets this after
// building the wgpu-wasm artefact.
const HEAVY_TIER = !!process.env.FORGEAX_E2E_WASM;

test.describe('play-real-game-safety-net — --game games/sample Play chain', () => {
  // ── LIGHT TIER ────────────────────────────────────────────────────────────
  // No wasm. Play-chain mount only: canvas exists + GameOverlay FPS attached.
  test('LIGHT: ▶ Play on games/sample mounts canvas + FPS readout (no wasm)', async ({
    page,
  }) => {
    await page.goto(STANDALONE_URL);

    // Standalone chrome shell mounts. The ViewportBar renders at
    // display='scene' (initial) with vp-play / vp-stop / vp-fps.
    await expect(page.locator('.fx-dockwrap')).toBeVisible({ timeout: 15_000 });

    // The in-host engine canvas must exist even before Play — the single-realm
    // "standalone all-white" / "Play canvas null" defects surface as a missing
    // or zero-sized canvas here.
    await expect(page.locator('canvas#app')).toBeAttached({ timeout: 15_000 });

    // Boot-readiness gate (mirrors play-stop-world-fork.spec.ts:66-75). The ▶
    // handler is wired to setViewportQuadrant only AFTER the async host-session
    // init completes (ViewportComponent.tsx:464-467), signalled by the
    // __forgeax_editor global. Clicking before that (the latent race in
    // play-mode.spec.ts, which omits this wait) leaves ▶ a no-op and the overlay
    // never swaps. Wait for the global so the safety net tests the real chain,
    // not the boot race.
    await page.waitForFunction(
      () => !!(window as unknown as { __forgeax_editor?: unknown }).__forgeax_editor,
      { timeout: 60_000 },
    );

    // Click ▶ Play. This sets run='play' + display='game', which makes
    // ViewportChrome swap ViewportBar -> GameOverlay (the "viewport chrome
    // escape" defect would leave ViewportBar mounted / GameOverlay absent).
    await page.locator('[data-testid="vp-play"]').click();

    // GameOverlay renders when display='game'. The FPS readout span is always
    // in the DOM (even when CSS-hidden by the hover gate), so toBeAttached is
    // sufficient and does not depend on hover state OR on a rendered frame.
    // This is the no-wasm-observable proof the Play chain mounted end to end.
    await expect(page.locator('[data-testid="game-overlay-fps"]')).toBeAttached({
      timeout: 10_000,
    });

    // NOTE: intentionally NO fps>0 poll and NO canvas pixel sampling here — both
    // need the wgpu-wasm render loop (heavy tier). Asserting them in the light
    // tier would break AC-06 (light must pass without wasm).
  });

  // ── HEAVY TIER (needs wgpu-wasm; studio heavy CI) ──────────────────────────
  // Reuses the play-mode.spec.ts:52-86 pixel-sampling pattern to prove the
  // engine renders real non-black frames on the real game. Gated: skips unless
  // FORGEAX_E2E_WASM is set, so a no-wasm run never fails (AC-07).
  test('HEAVY: canvas renders non-black frames during Play (needs wgpu-wasm)', async ({
    page,
  }) => {
    test.skip(
      !HEAVY_TIER,
      'heavy tier needs wgpu-wasm (bun run setup); set FORGEAX_E2E_WASM=1 — belongs to studio heavy CI (AC-07)',
    );

    await page.goto(STANDALONE_URL);
    await expect(page.locator('.fx-dockwrap')).toBeVisible({ timeout: 15_000 });

    // Same boot-readiness gate as the light tier (see comment there): the ▶
    // handler is wired only after host-session init sets __forgeax_editor.
    await page.waitForFunction(
      () => !!(window as unknown as { __forgeax_editor?: unknown }).__forgeax_editor,
      { timeout: 60_000 },
    );

    await page.locator('[data-testid="vp-play"]').click();
    await expect(page.locator('[data-testid="game-overlay-fps"]')).toBeAttached({
      timeout: 10_000,
    });

    // Frame-loop accumulator (installFpsReport) samples ~1 Hz; the first
    // non-zero sample appears after ~1 s once the render loop runs.
    await expect
      .poll(() => page.locator('[data-testid="game-overlay-fps"]').textContent(), {
        timeout: 30_000,
      })
      .toMatch(/[1-9]\d* FPS/);

    // Let the render loop produce a few frames before sampling.
    await page.waitForTimeout(2000);

    // Sample downscaled canvas pixels via drawImage → 2D context. WebGPU
    // canvases are composited by the browser; drawImage captures the composited
    // result regardless of the rendering API (same technique as play-mode.spec).
    const nonBlack = await page.evaluate(() => {
      const canvas = document.querySelector('canvas#app') as HTMLCanvasElement | null;
      if (!canvas || canvas.width === 0 || canvas.height === 0) return false;
      const offscreen = document.createElement('canvas');
      const sampleSize = Math.min(Math.min(canvas.width, canvas.height), 64);
      offscreen.width = sampleSize;
      offscreen.height = sampleSize;
      const ctx = offscreen.getContext('2d');
      if (!ctx) return false;
      ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, sampleSize, sampleSize);
      const data = ctx.getImageData(0, 0, sampleSize, sampleSize).data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! > 0 || data[i + 1]! > 0 || data[i + 2]! > 0) return true;
      }
      return false;
    });
    expect(nonBlack, 'canvas should render non-black frames during Play on games/sample').toBe(
      true,
    );
  });
});
