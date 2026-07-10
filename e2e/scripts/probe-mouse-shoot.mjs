// probe-mouse-shoot.mjs — ad-hoc e2e for #9 (mouse left-click shooting in Play).
//
// Root cause: #ui (full-screen overlay above the engine canvas) had
// pointer-events:auto, swallowing every viewport click before it reached the
// game canvas in #app. F-key shooting worked (a window keydown) but left-click
// did not. Fix: #ui is pointer-events:none; interactive chrome opts back in.
//
// This probe drives the LIVE standalone host (:15290) headless: ▶ Play, then
// dispatches a REAL left-click at viewport center on the canvas and asserts the
// world entity count grows (game-default's top-down click spawns a bullet
// entity). Also confirms the hit-test target under center is the CANVAS, not #ui.
//
// Run directly (not part of the Playwright suite):
//   node e2e/scripts/probe-mouse-shoot.mjs
// Expects the stack up: bun fx start --game <dir>

import { chromium } from '@playwright/test';

const URL = process.env.HOST_URL ?? 'http://localhost:15290/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}`));
  await page.addInitScript(() => {
    window.addEventListener('message', (ev) => {
      const d = ev.data;
      if (d && d.type === 'forgeax:health') console.log(`[health] ${d.message}`);
    });
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const loaded = await waitFor(logs, /scene ▸ loaded entities=(\d+)/, 30000);
  if (!loaded) {
    console.error('FAIL: scene never loaded');
    console.error(logs.slice(-20).join('\n'));
    await browser.close();
    process.exit(1);
  }

  const vp = page.frames().find((f) => f.url().includes('viewportOnly'));
  if (!vp) {
    console.error('FAIL: viewport iframe not found');
    await browser.close();
    process.exit(1);
  }

  // 1) Hit-test: the element under viewport center must be the canvas (proves the
  //    #ui pointer-events fix — clicks reach the canvas, not the overlay).
  const centerTarget = await vp.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    return el ? el.tagName : 'none';
  });
  console.log(`[probe] center hit-test target = ${centerTarget}`);
  let ok = true;
  if (centerTarget !== 'CANVAS') {
    console.error(`FAIL: center target is ${centerTarget}, expected CANVAS (#ui still swallows clicks)`);
    ok = false;
  }

  // 2) ▶ Play, snapshot entity count, dispatch a real canvas left-click, verify
  //    the world grew (a bullet entity spawned).
  await vp.evaluate(() => window.__forgeax_editor?.playSimulation?.());
  await sleep(1200);
  const before = await vp.evaluate(() => window.__forgeax_editor?.world?.inspect?.().entityCount ?? -1);

  // Dispatch a genuine mouse click at center on whatever canvas is there. The
  // game's top-down click listener reads clientX/Y for aim, so a real
  // pointer event (mousedown+mouseup+click) at a concrete point is required.
  const cx = await vp.evaluate(() => window.innerWidth / 2);
  const cy = await vp.evaluate(() => window.innerHeight / 2);
  await vp.locator('#app canvas').first().dispatchEvent('mousedown', { button: 0, clientX: cx, clientY: cy });
  await vp.locator('#app canvas').first().dispatchEvent('mouseup', { button: 0, clientX: cx, clientY: cy });
  await vp.locator('#app canvas').first().dispatchEvent('click', { button: 0, clientX: cx, clientY: cy });
  await sleep(800);
  const after = await vp.evaluate(() => window.__forgeax_editor?.world?.inspect?.().entityCount ?? -1);

  console.log(`[probe] entityCount before click = ${before}, after = ${after}`);
  if (before < 0 || after < 0) {
    console.error('FAIL: could not read world.inspect().entityCount (world hook missing)');
    ok = false;
  } else if (after <= before) {
    console.error(`FAIL: entity count did not grow on click (${before} → ${after}) — click did not shoot`);
    ok = false;
  }

  await browser.close();
  if (ok) {
    console.log(`PASS: left-click shoots — center target=CANVAS, entities ${before} → ${after} (bullet spawned)`);
    process.exit(0);
  }
  process.exit(1);
}

async function waitFor(logs, re, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const l of logs) {
      const m = l.match(re);
      if (m) return m;
    }
    await sleep(200);
  }
  return null;
}

main().catch((e) => {
  console.error('probe crashed:', e);
  process.exit(1);
});
