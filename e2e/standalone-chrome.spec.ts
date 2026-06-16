// e2e — standalone chrome hideChatAndForge true/false dual-side gate.
//
// Anchors:
//   requirements §AC-09  hideChatAndForge=true hides ChatPanel + Forge entry
//   requirements §AC-14  MountStandaloneOptions exposes hideChatAndForge field
//   requirements §AC-15  testid-only assertions; no text/role lookups (i18n safety)
//   plan-strategy §2 D-4 prop drilling — App.tsx 1 prop, 2 conditional render sites
//   plan-strategy §2 D-9 selector strategy — data-testid not text/role
//   research §fact-8     DOM selector resilience under i18n + theme
//
// Lifetime: this spec is the RED side of the M4 TDD pair. With w11/w12/w13
// not yet shipped, the standalone host (case A) still renders the chat panel
// and forge entry, so the AC-09 assertions fail. After w11-w13 land, both
// case A (hidden when true) and case B (visible when omitted/false) pass.
//
// Topology:
//   case A — :15290 standalone host (`packages/editor/standalone/`) calls
//            mountStandalone(editorApp, { hideChatAndForge: true }).
//            chat-panel testid + forge-entry testid MUST NOT exist anywhere
//            in the host page (the iframe-targeted edit-runtime at :15280
//            is the editor surface and is not expected to carry these
//            testids — they live on the host App.tsx chrome).
//   case B — :18920 studio host (regular `bash start.sh`) renders the full
//            chrome WITHOUT hideChatAndForge. Both testids MUST exist.
//            Case B is best-effort: when the studio dev server is not
//            available the test marks skipped rather than failing — the
//            standalone hide path is the unique behaviour P2 introduces.
//
// Dual-side falsifiability: case A asserts absence, case B asserts presence.
// A bug that left chat visible regardless of the flag would fail case A; a
// bug that hid chat regardless would fail case B.

import { expect, test } from '@playwright/test';

const STANDALONE_URL = 'http://127.0.0.1:15290/';
const STUDIO_URL = 'http://127.0.0.1:18920/';

const CHAT_PANEL_TESTID = '[data-testid="chat-panel"]';
const FORGE_ENTRY_TESTID = '[data-testid="forge-entry"]';

test.describe('standalone chrome — hideChatAndForge dual-side', () => {
  test('case A: hideChatAndForge=true hides chat-panel and forge-entry on :15290', async ({ page }) => {
    await page.goto(STANDALONE_URL);
    // Wait for the mountStandalone-created viewport iframe to attach (it is
    // appended directly under <body>; DockShell's panel iframes live inside
    // #root and are excluded by the `body > iframe` child combinator).
    await expect(page.locator('body > iframe')).toHaveCount(1, { timeout: 10_000 });
    // The hideChatAndForge contract: neither testid exists on the host page.
    // Use locator.count() rather than toBeHidden so a non-rendered branch
    // (the conditional-render path D-4 prescribes) registers as 0, not as
    // a present-but-hidden DOM node.
    await expect(page.locator(CHAT_PANEL_TESTID)).toHaveCount(0);
    await expect(page.locator(FORGE_ENTRY_TESTID)).toHaveCount(0);
  });

  test('case B: hideChatAndForge unset renders chat-panel and forge-entry on :18920', async ({ page }) => {
    // Best-effort: studio dev server may not be running during isolated
    // editor e2e runs. Skip rather than fail when :18920 is unreachable —
    // the standalone hide path (case A) is the unique behaviour gated
    // here; case B is a sanity check that the testids exist on the
    // baseline chrome at all.
    let reachable = false;
    try {
      const res = await page.request.get(STUDIO_URL, { timeout: 5_000 });
      reachable = res.ok();
    } catch {
      reachable = false;
    }
    test.skip(!reachable, 'studio :18920 not reachable in this run; case B is a sanity check, not the gated behaviour');

    await page.goto(STUDIO_URL);
    // Studio chrome boots dockview + many panels; wait until the App shell
    // mounts before asserting either testid.
    await expect(page.locator('.studio-shell')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(CHAT_PANEL_TESTID)).toHaveCount(1);
    await expect(page.locator(FORGE_ENTRY_TESTID)).toHaveCount(1);
  });
});
