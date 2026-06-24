// e2e — shared helpers for the 6-game play-runtime smoke specs (M5, AC-08).
//
// Topology (plan-strategy D-6): the engine vite dev server on :15173 serves
// play-runtime at /preview/?game=<slug>. The host (play-runtime main.ts)
// resolves forge.json.defaultScene, instantiates it once, exposes the root +
// SceneAsset via GameContext, then calls the game entry. These helpers drive a
// directly-loaded preview page (window.parent === window, so the host's
// VAG_FPS_STATS postMessage to window.parent self-delivers and we can observe
// the render loop without an embedding shell).
//
// Probes (research Finding 11):
//   window.__forgeax = { app, world, renderer }  — main.ts:170
//     world.inspect().entityCount → single-load assertion (no doubling)
//   VAG_FPS_STATS postMessage { type, fps }      — main.ts:428
//     fps > 0 → canvas is producing non-empty frames
//
// Forbidden console/page errors (AC-04 / AC-06): a scene that double-loads,
// fails the pack-data migration, or fails defaultScene resolution surfaces one
// of these substrings. Absence is asserted by every spec.
//
// Anchors:
//   requirements AC-08 (6-game e2e smoke: load / canvas / HUD / no double-load)
//   requirements AC-04 (no double instantiate) + AC-06 (skip-path no errors)
//   plan-strategy D-6 (server topology + probes) + §5.4 (falsification structure)
//   research Finding 11 (__forgeax + VAG_FPS_STATS probes)

import { expect, type Page } from '@playwright/test';

export const PREVIEW_BASE = 'http://localhost:15173/preview/';

// Substrings whose appearance in a page/console error means the asset-first
// startup path is broken. These are the failure signatures the migration +
// host-fed rewrite must eliminate (plan-strategy §5.3).
export const FORBIDDEN_ERROR_SUBSTRINGS = [
  'spawn-data-unknown-field', // pack material→materials / nodes→entities miss
  'forge-scene-unresolved', // host could not resolve forge.json defaultScene
  'defaultScene', // any defaultScene-tagged engine/host error
] as const;

// Substrings the host (play-runtime main.ts) logs ONLY when it falls back to
// the bare 2-entity camera scene instead of calling the game's named bootstrap
// entry. These are the smoking gun for the regression M7 fixes: the pre-bump
// nested engine's loadGame read `module.default`, rejected the 6 named-only
// `bootstrap` games, and the host took this fallback branch
// (main.ts:399 `loadGame: <code> — using fallback`, main.ts:415 `using
// fallback scene`). After the bump, loadGame resolves the named bootstrap and
// the host calls `entry(world, ctx)` — so NONE of these markers must appear.
//
// AC-04 non-fallback invariant (plan-strategy §5.4, implement-review concern
// 1c): a directly-observable proof, from the e2e side alone, that bootstrap was
// really invoked rather than the loader silently degrading to a fallback scene.
export const FALLBACK_MARKER_SUBSTRINGS = [
  'using fallback', // main.ts:399 `loadGame: <code> — using fallback`
  'fallback scene', // main.ts:362 / main.ts:415 fallback-scene branch
] as const;

// A real game scene always spawns far more than the fallback branch's two
// entities (a single Transform + Camera, main.ts:416-419). Any count at or
// below this floor means the host rendered the bare fallback, not the game.
export const FALLBACK_ENTITY_FLOOR = 2;

/** A page/console error captured during a smoke run, with its origin. */
export interface CapturedError {
  source: 'pageerror' | 'console';
  text: string;
}

/** A console message captured at any level (used for fallback-marker checks). */
export interface CapturedLog {
  type: string;
  text: string;
}

/**
 * Attach pageerror + console-error listeners and return the live array they
 * push into. Call before page.goto so nothing is missed.
 */
export function collectErrors(page: Page): CapturedError[] {
  const errors: CapturedError[] = [];
  page.on('pageerror', (e) => errors.push({ source: 'pageerror', text: e.message }));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push({ source: 'console', text: m.text() });
  });
  return errors;
}

/**
 * Attach a console listener that captures EVERY console message (not just
 * errors) and return the live array. The host logs its fallback-scene decision
 * at `log` level, so assertNonFallbackScene needs the full stream — collectErrors
 * (error-only) would miss it. Call before page.goto so nothing is missed.
 */
export function collectConsoleLogs(page: Page): CapturedLog[] {
  const logs: CapturedLog[] = [];
  page.on('console', (m) => logs.push({ type: m.type(), text: m.text() }));
  return logs;
}

/**
 * Navigate to a game preview and wait for its canvas. Install the
 * VAG_FPS_STATS message tap *before* the render loop starts emitting so early
 * frames are not missed (the host emits every 100 ms once app.start() runs).
 */
export async function gotoGame(page: Page, slug: string): Promise<void> {
  await page.goto(`${PREVIEW_BASE}?game=${slug}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 20_000 });
  // Tap the host's VAG_FPS_STATS heartbeat into a window-scoped counter so
  // assertFrames can read the max fps observed so far without racing a single
  // message. window.parent === window for a directly-loaded preview page, so
  // the host's postMessage(..., window.parent) self-delivers here.
  await page.evaluate(() => {
    const w = window as unknown as { __smokeMaxFps?: number };
    w.__smokeMaxFps = 0;
    // sendVagMessage wraps the body as { type, payload }, so the fps lives at
    // ev.data.payload.fps (not ev.data.fps) — see editor-core/protocol.ts.
    window.addEventListener('message', (ev: MessageEvent) => {
      const d = ev.data as { type?: string; payload?: { fps?: number } } | undefined;
      const fps = d?.payload?.fps;
      if (d && d.type === 'VAG_FPS_STATS' && typeof fps === 'number') {
        w.__smokeMaxFps = Math.max(w.__smokeMaxFps ?? 0, fps);
      }
    });
  });
  // Wait for the host's __forgeax global to be set before probing
  // (headless WebGPU init can take tens of seconds on cold cache).
  await page.waitForFunction(() => {
    const fx = (window as any).__forgeax;
    return !!(fx?.world?.inspect);
  }, { timeout: 60_000 });
}

/**
 * Assert the world reports a non-zero entity count, returning it so callers can
 * apply game-specific upper bounds (the single-load / no-doubling assertion).
 * expect.poll absorbs the cold-start gap before entry() finishes spawning.
 */
export async function assertEntityCount(page: Page): Promise<number> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const fx = (window as unknown as { __forgeax?: { world?: { inspect?: () => { entityCount: number } } } }).__forgeax;
          try {
            return fx?.world?.inspect?.().entityCount ?? 0;
          } catch {
            return 0;
          }
        }),
      { timeout: 90_000 },
    )
    .toBeGreaterThan(0);
  return page.evaluate(() => {
    const fx = (window as unknown as { __forgeax?: { world?: { inspect?: () => { entityCount: number } } } }).__forgeax;
    return fx?.world?.inspect?.().entityCount ?? 0;
  });
}

/**
 * Assert the canvas is producing non-empty frames: the host's render loop has
 * emitted at least one VAG_FPS_STATS with fps > 0. The fps averaging is 1 Hz so
 * the first non-zero sample appears ~1 s after app.start(); poll covers that.
 */
export async function assertNonEmptyFrames(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __smokeMaxFps?: number }).__smokeMaxFps ?? 0), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
}

/**
 * Assert none of the captured errors contain a forbidden substring. On failure
 * the full offending error text is surfaced (not just a boolean) so a broken
 * migration / host path is debuggable from the test output alone.
 */
export function assertNoForbiddenErrors(errors: CapturedError[]): void {
  const offending = errors.filter((e) =>
    FORBIDDEN_ERROR_SUBSTRINGS.some((sub) => e.text.includes(sub)),
  );
  expect(
    offending,
    `forbidden errors present:\n${offending.map((e) => `[${e.source}] ${e.text}`).join('\n')}`,
  ).toEqual([]);
}

/**
 * Assert the game ran via its named `bootstrap` entry, NOT the host's fallback
 * scene (AC-04 non-fallback invariant; the regression M7 fixes). Two
 * independent, e2e-observable signals must both hold:
 *
 *   1. No fallback-decision marker appeared in the console stream
 *      (FALLBACK_MARKER_SUBSTRINGS) — the host only logs these when loadGame
 *      rejects the entry (the pre-bump nested-engine `module.default` reject of
 *      named-only bootstrap) and it degrades to the bare camera scene.
 *   2. The live world holds more than the fallback floor of entities — a
 *      fallback renders exactly a Transform + Camera (2 entities), whereas
 *      every real game's bootstrap spawns its own scene/systems well above it.
 *
 * `count` is the entity count already read by assertEntityCount, so callers do
 * not re-poll. Pass the same value to keep the single-load upper bound and the
 * non-fallback lower bound consistent.
 */
export function assertNonFallbackScene(logs: CapturedLog[], count: number): void {
  const fallbackHits = logs.filter((l) =>
    FALLBACK_MARKER_SUBSTRINGS.some((sub) => l.text.includes(sub)),
  );
  expect(
    fallbackHits,
    `host took the fallback-scene path (bootstrap NOT called):\n${fallbackHits
      .map((l) => `[${l.type}] ${l.text}`)
      .join('\n')}`,
  ).toEqual([]);

  expect(
    count,
    `entity count ${count} <= fallback floor ${FALLBACK_ENTITY_FLOOR} — host likely rendered the bare fallback camera, not the game's bootstrap scene`,
  ).toBeGreaterThan(FALLBACK_ENTITY_FLOOR);
}
