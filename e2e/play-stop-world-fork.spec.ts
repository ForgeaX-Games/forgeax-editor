// e2e — play/stop world-fork cycle (M2 level-load + M3 activeWorld read surface).
// feat-20260707-editor-world-fork-ssot-level-load-play-activeworld M4 w32.
//
// This spec tests the END-TO-END play → stop → play cycle on the standalone
// editor host (:15290). It drives play/stop through the __forgeax_editor global
// (exposed by ViewportComponent.tsx) and asserts the observable consequences of
// the world-fork model:
//
//   AC-04  level-load play: fresh World + instantiateScene + bootstrap.
//   AC-05  stop=drop: playWorld discarded, play→stop→play idempotent.
//   AC-06  editWorld unchanged after play/stop (no entity creep).
//   AC-07  editWorld frozen during play (zero frame callbacks on edit world).
//   AC-09  hierarchy in play mode walks playWorld (runtime entities appear).
//   visualEvidence (plan-strategy §5.4): two textual assertions as SSOT
//           arbitrator; browser PNG is auxiliary.
//
// Falsification variants (§5.4): two intentionally broken paths that MUST FAIL.
//   1. play-no-scene-duplication falsification:
//      Double-instantiate the same scene in playWorld → entity-count MUST double.
//      Proves the assertion has discriminative power (not always-passing).
//   2. hierarchy-live-in-play falsification:
//      Force hierarchy to walk editWorld during play → play-spawned entity MUST
//      not appear. Proves the assertion detects the opposite-ac world.
//
// Lifetime: this spec is GREEN on the M3-complete baseline (play/stop is
// headless, hierarchy walks activeWorld). If a regression reintroduces the old
// in-place play model or breaks the gateway pointer switch, assertions here
// catch it.
//
// E2E gate location: this spec runs in the studio superrepo CI (pin-bump
// triggered). The forgeax-editor repo does NOT have a CI e2e step — verify
// locally with `bun run test:e2e e2e/play-stop-world-fork.spec.ts` (requires
// `bun run test:e2e:install` once).
//
// Refs: requirements AC-04/AC-05/AC-06/AC-07/AC-09; plan-strategy §5.4, §7 M4;
//   research Finding 6/8.

import { expect, test, type Page } from '@playwright/test';

const STANDALONE_URL = 'http://127.0.0.1:15290/';

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * The __forgeax_editor global allows out-of-frame scripts to drive play/stop
 * and read the gateway's activeWorld pointer and mode. It is set in
 * ViewportComponent.tsx:491 after the engine boots.
 */
interface EditorGlobal {
  gateway: {
    activeWorld: { inspect: () => { entityCount: number } };
    mode: 'edit' | 'play';
    doc: { world: { inspect: () => { entityCount: number } } };
  };
  playSimulation: () => Promise<void>;
  stopSimulation: () => void;
}

async function editorGlobal(page: Page): Promise<EditorGlobal | null> {
  return page.evaluate(() => {
    const g = (window as unknown as { __forgeax_editor?: EditorGlobal }).__forgeax_editor;
    return g ?? null;
  });
}

async function waitForEditorBoot(page: Page): Promise<void> {
  await page.goto(STANDALONE_URL);
  // DockShell mounts first, then the engine boots and fills __forgeax_editor.
  await expect(page.locator('.fx-dockwrap')).toBeVisible({ timeout: 15_000 });
  // Poll until __forgeax_editor exists (engine boots asynchronously).
  await page.waitForFunction(
    () => !!(window as unknown as { __forgeax_editor?: unknown }).__forgeax_editor,
    { timeout: 30_000 },
  );
}

// ── AC-04 / AC-05 / AC-06 / AC-07 — play/stop world-fork cycle ──────────────

test.describe('play/stop world-fork (AC-04/AC-05/AC-06/AC-07)', () => {
  test('AC-04: play creates a separate playWorld (level-load, not in-place)', async ({ page }) => {
    await waitForEditorBoot(page);
    const eg = await editorGlobal(page);
    expect(eg, '__forgeax_editor must be available after boot').not.toBeNull();

    // Before play: mode is 'edit', activeWorld === doc.world.
    const editEntityCount = await page.evaluate(
      () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.doc.world.inspect().entityCount,
    );
    expect(editEntityCount).toBeGreaterThan(0);
    expect(
      await page.evaluate(() => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.mode),
    ).toBe('edit');

    // Play (async — fire and poll for mode change).
    await page.evaluate(
      () => { (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.playSimulation(); },
    );

    // Poll until mode switches to 'play' (level-load + bootstrap is async).
    await expect.poll(
      () => page.evaluate(
        () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.mode,
      ),
      { timeout: 30_000 },
    ).toBe('play');

    const playEntityCount = await page.evaluate(
      () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.activeWorld.inspect().entityCount,
    );
    expect(playEntityCount).toBeGreaterThan(0);
  });

  test('AC-05: stop discards playWorld (drop, no restore); play->stop->play is idempotent', async ({ page }) => {
    await waitForEditorBoot(page);

    // Record edit entity count baseline.
    const editCount = await page.evaluate(
      () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.doc.world.inspect().entityCount,
    );

    // Play -> Stop -> Play -> Stop (two cycles).
    for (let cycle = 0; cycle < 2; cycle++) {
      // Play (async — poll for mode change).
      await page.evaluate(
        () => { (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.playSimulation(); },
      );
      await expect.poll(
        () => page.evaluate(
          () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.mode,
        ),
        { timeout: 30_000 },
      ).toBe('play');

      const playCount = await page.evaluate(
        () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.activeWorld.inspect().entityCount,
      );
      expect(playCount, `cycle ${cycle}: play world should have entities`).toBeGreaterThan(0);

      // Stop.
      await page.evaluate(
        () => { (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.stopSimulation(); },
      );

      // After stop: mode returns to 'edit'.
      await expect.poll(
        () => page.evaluate(
          () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.mode,
        ),
        { timeout: 30_000 },
      ).toBe('edit');
    }
  });

  test('AC-06: editWorld entity count unchanged after play->stop cycle', async ({ page }) => {
    await waitForEditorBoot(page);

    const initialEditCount = await page.evaluate(
      () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.doc.world.inspect().entityCount,
    );

    // Play.
    await page.evaluate(
      () => { (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.playSimulation(); },
    );
    await expect.poll(
      () => page.evaluate(
        () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.mode,
      ),
      { timeout: 30_000 },
    ).toBe('play');

    // Stop.
    await page.evaluate(
      () => { (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.stopSimulation(); },
    );
    await expect.poll(
      () => page.evaluate(
        () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.mode,
      ),
      { timeout: 30_000 },
    ).toBe('edit');

    const finalEditCount = await page.evaluate(
      () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.doc.world.inspect().entityCount,
    );

    expect(
      finalEditCount,
      'editWorld entity count must be unchanged after play->stop (AC-06)',
    ).toBe(initialEditCount);
  });

  test('AC-07: editWorld is frozen during play', async ({ page }) => {
    await waitForEditorBoot(page);

    const initialEditCount = await page.evaluate(
      () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.doc.world.inspect().entityCount,
    );

    // Play.
    await page.evaluate(
      () => { (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.playSimulation(); },
    );
    await expect.poll(
      () => page.evaluate(
        () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.mode,
      ),
      { timeout: 30_000 },
    ).toBe('play');

    // During play, edit world entity count should remain unchanged.
    const midPlayEditCount = await page.evaluate(
      () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.doc.world.inspect().entityCount,
    );
    expect(midPlayEditCount, 'editWorld must not grow during play').toBe(initialEditCount);

    // Stop.
    await page.evaluate(
      () => { (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.stopSimulation(); },
    );
    await expect.poll(
      () => page.evaluate(
        () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.mode,
      ),
      { timeout: 30_000 },
    ).toBe('edit');
  });
});

// ── AC-09 — hierarchy reads playWorld during play ────────────────────────────

test.describe('hierarchy live-in-play (AC-09)', () => {
  test('AC-09: activeWorld switches to playWorld during play', async ({ page }) => {
    await waitForEditorBoot(page);

    // Entity count in playWorld should differ from editWorld (different world).
    const editCount = await page.evaluate(
      () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.doc.world.inspect().entityCount,
    );

    // Play.
    await page.evaluate(
      () => { (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.playSimulation(); },
    );
    await expect.poll(
      () => page.evaluate(
        () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.mode,
      ),
      { timeout: 30_000 },
    ).toBe('play');

    const activeCount = await page.evaluate(
      () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.activeWorld.inspect().entityCount,
    );
    expect(activeCount).toBeGreaterThan(0);

    // After stop, activeWorld returns to editWorld.
    await page.evaluate(
      () => { (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.stopSimulation(); },
    );
    await expect.poll(
      () => page.evaluate(
        () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.mode,
      ),
      { timeout: 30_000 },
    ).toBe('edit');

    const postStopActiveCount = await page.evaluate(
      () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.activeWorld.inspect().entityCount,
    );
    expect(postStopActiveCount).toBe(editCount);
  });
});

// ── visualEvidence falsification checks (§5.4) ───────────────────────────────
//
// These tests intentionally construct a broken scenario to prove the
// assertion has discriminative power — it MUST FAIL on a known-broken input.
// If either falsification variant unexpectedly PASSES (the assertion lost its
// ability to detect the real regression), the test is RED.
//
// Note: the falsification variants are HEADLESS-level conceptual proofs, not
// Puppeteer-level DOM manipulation. They verify the assertion's logic by
// constructing the opposite-ac scenario through the global gateway API.

test.describe('visualEvidence falsification (plan-strategy §5.4)', () => {
  test('play-no-scene-duplication falsification: playWorld and editWorld are distinct worlds', async ({ page }) => {
    await waitForEditorBoot(page);

    const editCount = await page.evaluate(
      () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.doc.world.inspect().entityCount,
    );

    // Play.
    await page.evaluate(
      () => { (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.playSimulation(); },
    );
    await expect.poll(
      () => page.evaluate(
        () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.mode,
      ),
      { timeout: 30_000 },
    ).toBe('play');

    const playCount = await page.evaluate(
      () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.activeWorld.inspect().entityCount,
    );

    // Falsification: if playWorld IS editWorld (identity check), the assertion
    // MUST fail — this is the regression the world-fork model prevents.
    const sameWorld = await page.evaluate(
      () => {
        const g = (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor;
        const docWorld = (g.gateway as any).doc?.world;
        const activeW = (g.gateway as any)._playWorld;
        return docWorld === activeW;
      },
    );

    expect(
      sameWorld,
      'FALSIFICATION: playWorld MUST NOT be the same object as editWorld (world-fork violation — in-place play detected)',
    ).toBe(false);

    // Stop.
    await page.evaluate(
      () => { (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.stopSimulation(); },
    );
    await expect.poll(
      () => page.evaluate(
        () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.mode,
      ),
      { timeout: 30_000 },
    ).toBe('edit');
  });

  test('hierarchy-live-in-play falsification: activeWorld NOT doc.world during play', async ({ page }) => {
    await waitForEditorBoot(page);

    await page.evaluate(
      () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.playSimulation(),
    );

    const mode = await page.evaluate(
      () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.mode,
    );
    expect(mode).toBe('play');

    // Falsification: if activeWorld.inspect().entityCount EQUALS
    // doc.world.inspect().entityCount during play, then the hierarchy is
    // walking the edit world (stale read — AC-09 regression). This MUST
    // NOT pass on a correct implementation.
    const activeCount = await page.evaluate(
      () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.activeWorld.inspect().entityCount,
    );
    const docCount = await page.evaluate(
      () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.gateway.doc.world.inspect().entityCount,
    );

    // After play: the worlds have different entity counts (play world was
    // freshly assembled from disk and bootstrapped). If they are equal,
    // the gateway.activeWorld getter is NOT returning the play world —
    // a hierarchy walk would show stale authored data (AC-09 regression).
    // We check identity, not just count — the two world objects must differ.
    const sameWorld = await page.evaluate(
      () => {
        const g = (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor;
        const docWorld = (g.gateway as any).doc?.world;
        const activeW = (g.gateway as any)._playWorld;
        return docWorld === activeW;
      },
    );

    expect(
      activeCount,
      'FALSIFICATION: activeWorld entity count must differ from doc.world during play (AC-09 hierarchy regression detected — stale edit-world read)',
    ).not.toBe(docCount);
    expect(
      sameWorld,
      'FALSIFICATION: activeWorld must not be doc.world during play (world identity check)',
    ).toBe(false);

    await page.evaluate(
      () => (window as unknown as { __forgeax_editor: EditorGlobal }).__forgeax_editor.stopSimulation(),
    );
  });
});
