// e2e — mountStandalone end-to-end gate (AC-07 / AC-08 / AC-09).
//
// This spec is the sole real-consumer verification of mountStandalone:
// it loads the demo (which calls mountStandalone(editorApp) on module
// load), then asserts the iframe attached, that the host receives at
// least one VAG_* postMessage whose payload zod safeParse succeeds,
// and that re-invoking mountStandalone does not duplicate the iframe.
//
// Pattern: research F-4 mode C — context.exposeFunction + context-level
// addInitScript.  Schema validation stays in Node (zod schemas are not
// JSON-serializable across the browser boundary).  The captured array
// is closed over at module scope of beforeEach so each test resets
// cleanly without the schema crossing the wire.
//
// AC-09 second-mount drive: bare specifier `import()` in browser does
// not resolve through Vite's compile-time rewrite, so the demo's
// main.ts attaches mountStandalone + editorApp to a window test hook
// (`window.__forgeaxStandaloneTest`).  page.evaluate reads from there.
//
// Anchors:
//   requirements §AC-07 (iframe attached + src equals entryUrl)
//   requirements §AC-08 (host receives ≥1 VAG_* + safeParse success)
//   requirements §AC-09 (idempotent mount keeps iframe count at 1)
//   plan-strategy §2 D-9 (mode C selected)
//   plan-strategy §5.3 (best-effort key VAG_* — FPS_STATS / EDITOR_REF / CONSOLE)
//   research §F-4 (context.addInitScript before first goto; no frame-locator evaluate API)
//   research §F-6 C-1 (entryUrl literal: http://127.0.0.1:15280/?viewportOnly=1)
//
// Knowledge: knowledge-base/wiki/playwright-iframe-postmessage-e2e.md §2.3 §5.

import { expect, test } from '@playwright/test';
import {
  VagAssetsChangedSchema,
  VagConsoleSchema,
  VagDeviceLostSchema,
  VagEditorFlushSchema,
  VagEditorOpenSourceSchema,
  VagEditorPopoutSchema,
  VagEditorRedockSchema,
  VagEditorRefSchema,
  VagFpsStatsSchema,
  VagPreviewDisposeSchema,
  VagPreviewPauseSchema,
  VagPreviewPlaySchema,
  VagPreviewReloadSchema,
  VagSpawnEntitySchema,
} from '@forgeax/editor/protocol';

// editor-edit-runtime entry under viewportOnly=1.  Source of truth is
// packages/editor/src/index.ts — duplicated here only for the AC-07
// equality assertion.  Drift would surface as a string-compare failure.
const ENTRY_URL = 'http://127.0.0.1:15280/?viewportOnly=1';

// All VAG_* schemas in a type-keyed lookup so the AC-08 assertion can
// dispatch the right schema for whichever message arrives first.  Any
// unmatched type triggers the assertion (we never fall through to a
// permissive passthrough — drift must surface).
const VAG_SCHEMAS = {
  VAG_ASSETS_CHANGED: VagAssetsChangedSchema,
  VAG_CONSOLE: VagConsoleSchema,
  VAG_DEVICE_LOST: VagDeviceLostSchema,
  VAG_EDITOR_FLUSH: VagEditorFlushSchema,
  VAG_EDITOR_OPEN_SOURCE: VagEditorOpenSourceSchema,
  VAG_EDITOR_POPOUT: VagEditorPopoutSchema,
  VAG_EDITOR_REDOCK: VagEditorRedockSchema,
  VAG_EDITOR_REF: VagEditorRefSchema,
  VAG_FPS_STATS: VagFpsStatsSchema,
  VAG_PREVIEW_DISPOSE: VagPreviewDisposeSchema,
  VAG_PREVIEW_PAUSE: VagPreviewPauseSchema,
  VAG_PREVIEW_PLAY: VagPreviewPlaySchema,
  VAG_PREVIEW_RELOAD: VagPreviewReloadSchema,
  VAG_SPAWN_ENTITY: VagSpawnEntitySchema,
} as const;

type Captured = { data: unknown; origin: string };

function isVagMessage(m: Captured): boolean {
  if (typeof m.data !== 'object' || m.data === null) return false;
  const t = (m.data as { type?: unknown }).type;
  return typeof t === 'string' && t.startsWith('VAG_');
}

test.describe('mountStandalone', () => {
  let captured: Captured[] = [];

  test.beforeEach(async ({ page, context }) => {
    captured = [];
    // (1) Node-side capture sink — research F-4 mode C: zod stays in Node,
    //     each window.message landing fires this exposed function.
    await context.exposeFunction('__onMsg', (m: Captured) => {
      captured.push(m);
    });
    // (2) Context-level init script registered BEFORE first goto so that
    //     both the host page and the iframe (editor-edit-runtime) install
    //     the listener at navigation time.  A page-level init script
    //     would only hit the main frame — wiki §2.2 / §4.
    await context.addInitScript(() => {
      window.addEventListener('message', (e) => {
        try {
          // biome-ignore lint/suspicious/noExplicitAny: window injection bridge to Node-side capture
          (window as any).__onMsg({ data: e.data, origin: e.origin });
        } catch {
          // ignore — bridge unavailable during teardown
        }
      });
    });
    await page.goto('/');
    // Wait for demo module evaluation + initial mountStandalone() call.
    await expect(page.locator('iframe')).toHaveCount(1);
  });

  test('AC-07: iframe attached at root and src equals app.entryUrl', async ({ page }) => {
    const iframe = page.locator('iframe');
    await expect(iframe).toHaveCount(1);
    const src = await iframe.getAttribute('src');
    expect(src).toBe(ENTRY_URL);
    expect(src).not.toBe('about:blank');
  });

  test('AC-08: host receives at least one VAG_* and safeParse succeeds', async () => {
    // The editor-edit-runtime under ?viewportOnly=1 emits VAG_FPS_STATS
    // every frame and VAG_CONSOLE for every console.* call (main.tsx).
    // We tolerate any message in our schema map — first match wins.
    await expect.poll(() => captured.filter(isVagMessage).length, { timeout: 10_000 }).toBeGreaterThan(0);

    const vag = captured.find(isVagMessage);
    expect(vag).toBeDefined();
    const payload = vag!.data as { type: string };
    const schema = VAG_SCHEMAS[payload.type as keyof typeof VAG_SCHEMAS];
    expect(schema, `no schema registered for ${payload.type}`).toBeDefined();
    const parsed = schema.safeParse(payload);
    expect(parsed.success, `safeParse failed: ${JSON.stringify(parsed)}`).toBe(true);
  });

  test('AC-09: re-invoking mountStandalone keeps iframe count at 1', async ({ page }) => {
    // Demo's main.ts already mounted once.  Drive a second mount via
    // the demo-side test hook on window — bare specifier `import()` in
    // browser is not resolvable through Vite's compile-time rewrite.
    // app-kit's idempotent overwrite drops the prior iframe before
    // creating the new one (interface/src/app-kit.ts:213-216).
    await page.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: test hook contract
      const hook = (window as any).__forgeaxStandaloneTest as {
        // biome-ignore lint/suspicious/noExplicitAny: minimal shape for test
        mountStandalone: (app: any) => void;
        // biome-ignore lint/suspicious/noExplicitAny: minimal shape for test
        editorApp: any;
      };
      hook.mountStandalone(hook.editorApp);
    });
    // Even after the second call, exactly one iframe lives at the root.
    await expect(page.locator('iframe')).toHaveCount(1);
    const src = await page.locator('iframe').getAttribute('src');
    expect(src).toBe(ENTRY_URL);
  });
});
