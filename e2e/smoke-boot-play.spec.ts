// e2e — boot + ▶ Play smoke: no console errors on load, no console errors on Play.
//
// The three things this gates (user request):
//   1. the standalone stack boots (playwright webServer boots the games/sample
//      3-process stack — same as `bun run start --game=games/sample`);
//   2. opening http://localhost:15290 produces no console/page errors;
//   3. clicking ▶ Play produces no console/page errors.
//
// This is the permanent guard on the SharedRefReleasedError-on-Play class: that
// crash is a plain JS error thrown during scene instantiate, so it lands in the
// console/pageerror stream this spec asserts is empty. (Fixed in
// play-assemble.ts by routing defaultScene instantiate through the AssetRegistry
// spine; the edit-runtime unit test run-lifecycle-level-load.test.ts is the
// GPU-free gate, this spec is the real-browser gate.)
//
// WebGPU-tolerant by design (plan Part C decision): headless runners may have no
// working GPU. We (a) ALLOWLIST WebGPU/RhiError console noise (same regex as
// scripts/e2e-console-scan.mjs) so a SwiftShader hiccup doesn't red the gate, and
// (b) do NOT wait for a rendered frame / FPS readout — that would couple the Play
// check to a working GPU. We click Play, let assemble + scene instantiate run,
// then assert no non-allowlisted console/page errors. Consequence: this spec does
// NOT gate WebGPU-init regressions (studio-superrepo e2e does); it DOES catch
// every non-GPU JS error, including the SharedRefReleasedError this fix removed
// (it surfaces as a console.error via the ViewportComponent console bridge).
//
// LOCAL vs CI discriminating power (important): assemblePlayWorld runs createApp
// (needs WebGPU) BEFORE loadDefaultScene + scene instantiate. On a runner with NO
// working GPU (e.g. a dev macOS headless chromium), createApp fails first and play
// falls back to edit — the instantiate path never runs, so this spec passes even
// on the buggy code. It only exercises the SharedRefReleasedError path where
// WebGPU actually initializes (Linux CI SwiftShader). The AIRTIGHT, GPU-free gate
// for that bug is the unit test run-lifecycle-level-load.test.ts (proven to fail
// on the raw-instantiate regression). This spec is the end-to-end boot+play
// complement, not the primary regression proof.
//
// Ref: plan-strategy Part C; scripts/e2e-console-scan.mjs (allowlist SSOT-by-copy).

import { expect, test } from '@playwright/test';
import { collectErrors } from './games-smoke-helpers';

const STANDALONE_URL = 'http://127.0.0.1:15290/';

// Headless-WebGPU allowlist — kept in sync with scripts/e2e-console-scan.mjs:53.
// SwiftShader software WebGPU can throw these without indicating a real editor bug.
const WEBGPU_ALLOW = /RhiError|webgpu|WebGPU|GPUDevice|createBindGroup|requestAdapter|GPUAdapter/i;

const realErrors = (errors: { source: string; text: string }[]): string[] =>
  errors.filter((e) => !WEBGPU_ALLOW.test(e.text)).map((e) => `${e.source}: ${e.text.split('\n')[0]}`);

test.describe('smoke — boot + ▶ Play produce no console errors', () => {
  test('loads :15290 and clicks Play with a clean (non-WebGPU) console', async ({ page }) => {
    // Attach collectors BEFORE goto so nothing is missed (helpers pattern).
    const errors = collectErrors(page);

    // ── check 1 & 2: boot + open :15290, no errors ──
    await page.goto(STANDALONE_URL);
    // The standalone chrome shell mounted → host booted + first render happened.
    await expect(page.locator('.fx-dockwrap')).toBeVisible({ timeout: 20_000 });
    // Let lazy effects / engine boot settle so late errors are captured.
    await page.waitForTimeout(3000);

    expect(
      realErrors(errors),
      'console/page errors after loading :15290 (WebGPU-headless noise excluded)',
    ).toEqual([]);

    // ── check 3: click ▶ Play, no errors ──
    // Deliberately GPU-TOLERANT: we do NOT wait for game-overlay-fps (that only
    // attaches once the play world assembles AND the WebGPU frame loop starts, so
    // it couples the check to a working GPU — the coupling this gate avoids). On a
    // GPU-less runner createApp fails on WebGPU and play falls back to edit with a
    // console.warn (WebGPU-allowlisted) — tolerated. On a SwiftShader/GPU runner
    // play proceeds into scene instantiate, where the SharedRefReleasedError bug
    // would throw → routed to console.error (ViewportComponent console bridge) →
    // caught by collectErrors. Either way, click + settle + assert-no-real-errors
    // is what requirement #3 ("clicking Play has no console errors") means.
    await page.locator('[data-testid="vp-play"]').click();
    // Settle: enough for assemble + defaultScene instantiate + a few frames so any
    // deferred instantiate/spawn error surfaces on either GPU path.
    await page.waitForTimeout(6000);

    expect(
      realErrors(errors),
      'console/page errors after clicking ▶ Play (WebGPU-headless noise excluded)',
    ).toEqual([]);
  });

  // NOTE on the external-asset-root (`@shared/…`) gate: this webServer boots the
  // standalone host with GAME_DIR=null (demo-seed — see playwright.config.ts:60),
  // so games/sample's scene (which references the shared @shared/characters Fox)
  // is never loaded here. The airtight, GPU-free gate for the external-root fold
  // lives in the unit tests instead:
  //   - packages/core/src/__tests__/asset-roots.test.ts (@shared alias resolution)
  //   - packages/play-runtime/src/__tests__/pack-catalog-external-root.test.ts
  //     (a shared GLB folds into the catalog with a serveable /preview URL).
  // Adding a Fox assertion here would require booting this shared webServer with
  // --game games/sample, which the sibling console-error test deliberately avoids.
});
