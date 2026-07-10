// probe-inspector-select.mjs — ad-hoc e2e for the Inspector popout select crash.
//
// Root cause (same class as childrenOf #5): the Inspector's on-select useEffect
// called bus.doc.world.get(handle, Transform) directly. In a popout window
// bus.doc.world is null (snapshot revive keeps it inert), so selecting any entity
// NPE'd with "Cannot read properties of null (reading 'get')". Fix: read Transform
// through entComponent (the dead-world-aware SSOT reader).
//
// This probe drives the LIVE standalone host (:15290): selects an entity via the
// viewport iframe's bus, then asserts NO frame logged the null-get crash.
//
// Run directly:  node e2e/scripts/probe-inspector-select.mjs
// Expects the stack up: bun fx start --game <dir>

import { chromium } from '@playwright/test';

const URL = process.env.HOST_URL ?? 'http://localhost:15290/';
const CRASH = ["reading 'get'", 'Cannot read properties of null'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const logs = [];
  // Capture console + page errors from ALL frames (the inspector is a popout iframe).
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}`));
  await page.addInitScript(() => {
    window.addEventListener('message', (ev) => {
      const d = ev.data;
      if (d && d.type === 'forgeax:health') console.log(`[health] ${d.message}`);
    });
    // Surface uncaught errors from inside every frame.
    window.addEventListener('error', (e) => console.log(`WINERR: ${e.message}`));
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

  // Select a real entity by its legacy id through the editor bus. The viewport
  // owns the live bus; the inspector popout mirrors it over BroadcastChannel.
  // Pick a mid-scene id that exists (e.g. 4 = RedBox) rather than the root.
  const selResult = await vp.evaluate(() => {
    const ed = window.__forgeax_editor;
    const bus = ed?.bus;
    if (!bus) return { ok: false, why: 'no bus' };
    // entIds via the bus doc? Use setSelection through the exported store if present.
    // Fall back to bus.select if available.
    const ids = ed?.entIds ? ed.entIds() : null;
    return { ok: true, hasBus: !!bus, ids };
  });

  // Drive selection: dispatch through the store's setSelection if reachable,
  // else click the hierarchy row. Simplest reliable path: use the hierarchy
  // popout row for a known entity name.
  const hier = page.frames().find((f) => f.url().includes('panel=hierarchy'));
  const insp = page.frames().find((f) => f.url().includes('panel=inspector'));
  if (!hier || !insp) {
    console.error(`FAIL: hierarchy(${!!hier}) or inspector(${!!insp}) popout not found`);
    await browser.close();
    process.exit(1);
  }

  const errBefore = logs.filter((l) => CRASH.some((c) => l.includes(c))).length;

  // Click an entity row in the Hierarchy popout (drives selection over the bus).
  const row = hier.locator('text=RedBox').first();
  const rowCount = await row.count();
  if (rowCount === 0) {
    console.error('FAIL: RedBox row not found in Hierarchy popout');
    console.error('hierarchy text sample:', (await hier.locator('body').innerText()).slice(0, 300));
    await browser.close();
    process.exit(1);
  }
  await row.click({ force: true });
  await sleep(1200);

  const errAfter = logs.filter((l) => CRASH.some((c) => l.includes(c))).length;
  console.log(`[probe] null-get crash count: before=${errBefore} after=${errAfter}`);

  // Confirm the inspector actually rendered the selected entity (not the empty
  // "No selection" state) — proves selection propagated AND the panel survived.
  const inspText = await insp.locator('body').innerText().catch(() => '');
  const showsEntity = /RedBox/.test(inspText) || /Transform/.test(inspText);
  console.log(`[probe] inspector shows selected entity: ${showsEntity}`);

  await browser.close();
  let ok = true;
  if (errAfter > errBefore) {
    console.error(`FAIL: null-get crash on select (${errBefore} → ${errAfter})`);
    ok = false;
  }
  if (!showsEntity) {
    console.error('FAIL: inspector did not render the selected entity (Transform/name absent)');
    ok = false;
  }
  if (ok) {
    console.log('PASS: selecting an entity does not crash the Inspector popout; panel renders it');
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
