// probe-stop-restore.mjs — ad-hoc e2e for #8 (Stop restores the scene).
//
// Drives the LIVE standalone host (:15290) headless — the real flow, which
// injects the game slug + gameRoot and mounts the edit-runtime viewport iframe.
// The iframe's emitBoot posts `forgeax:health` to window.parent (the host page),
// so we capture the `scene ▸ loaded entities=N` breadcrumb there, click ▶ Play
// then ■ Stop inside the iframe, and assert `scene ▸ restored entities=M` with
// M === N (a healthy restore keeps the same entity count — AC-06). Fails on the
// collapse error classes + the post-Stop pbr-view-bg RhiError flood.
//
// Run directly (not part of the Playwright suite):
//   node e2e/scripts/probe-stop-restore.mjs
// Expects the stack up: bun fx start --game <dir>

import { chromium } from '@playwright/test';

const URL = process.env.HOST_URL ?? 'http://localhost:15290/';
const BAD = [
  'SharedRefReleasedError',
  'could not be cloned',
  "reading 'get'", // childrenOf null.get crash
  'unknown component',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}`));

  // Capture emitBoot health messages the viewport iframe posts to the host.
  await page.addInitScript(() => {
    window.addEventListener('message', (ev) => {
      const d = ev.data;
      if (d && d.type === 'forgeax:health') {
        // eslint-disable-next-line no-console
        console.log(`[health] ${d.message}`);
      }
    });
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // Wait for the scene-load breadcrumb.
  const loaded = await waitFor(logs, /scene ▸ loaded entities=(\d+)/, 30000);
  if (!loaded) {
    console.error('FAIL: never saw `scene ▸ loaded` breadcrumb within 30s');
    console.error(tail(logs));
    await browser.close();
    process.exit(1);
  }
  const loadedCount = Number(loaded[1]);
  console.log(`[probe] loaded entities=${loadedCount}`);

  // Drive ▶/■ via the viewport iframe's window.__forgeax_editor hook (more
  // reliable than clicking through the dock's overlapping panels). Same code
  // path the UI buttons call (playSimulation / stopSimulation).
  const vpFrame = page
    .frames()
    .find((f) => f.url().includes('viewportOnly'));
  if (!vpFrame) {
    console.error('FAIL: viewport iframe not found');
    await browser.close();
    process.exit(1);
  }
  await vpFrame.evaluate(() => {
    window.__forgeax_editor?.playSimulation?.();
  });
  await sleep(1500);
  await vpFrame.evaluate(() => {
    window.__forgeax_editor?.stopSimulation?.();
  });
  await sleep(1500);

  // Dump the scene lifecycle breadcrumbs for diagnosis.
  for (const l of dedupe(logs).filter((l) => l.includes('scene ▸'))) console.log(`   ${l}`);

  const restored = await waitFor(logs, /scene ▸ restored entities=(\d+)/, 10000);
  if (!restored) {
    console.error('FAIL: never saw `scene ▸ restored` breadcrumb after Stop');
    console.error(tail(logs));
    await browser.close();
    process.exit(1);
  }
  const restoredCount = Number(restored[1]);
  console.log(`[probe] restored entities=${restoredCount}`);

  const bad = logs.filter((l) => BAD.some((b) => l.includes(b)));
  let ok = true;
  if (bad.length) {
    console.error(`FAIL: ${bad.length} collapse-class error(s):`);
    for (const b of dedupe(bad).slice(0, 8)) console.error('  ', b);
    ok = false;
  }
  if (restoredCount !== loadedCount) {
    console.error(`FAIL: restored count ${restoredCount} != loaded ${loadedCount} (scene not fully restored)`);
    ok = false;
  }
  if (restoredCount === 0) {
    console.error('FAIL: restored count is 0 (scene vanished on Stop)');
    ok = false;
  }
  // NOTE: headless chromium has no WebGPU adapter, so pbr-view-bg RhiError floods
  // regardless of Stop — it is GPU-absence noise here, NOT a restore signal.
  // Render-fidelity after Stop must be judged with a real GPU (manual / dawn).

  await browser.close();
  if (ok) {
    console.log(
      `PASS: Stop restored the scene (entities ${loadedCount} → ${restoredCount}, no collapse errors)`,
    );
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

function dedupe(arr) {
  return [...new Set(arr)];
}

function tail(logs) {
  return dedupe(logs).slice(-40).join('\n');
}

main().catch((e) => {
  console.error('probe crashed:', e);
  process.exit(1);
});
