// probe-city-import-noclobber.mjs — ad-hoc e2e for the "add City_Sample_512 →
// scene.pack.json destroyed (0 bytes)" data-loss bug.
//
// Root cause: serializedPack() did `worldToPack(...) ?? ''` — when the engine
// serializer failed (a spawned/imported entity carries a component the pack
// serializer can't persist), it returned an EMPTY string, and both save paths
// (saveDocToDisk + the pagehide beacon flushPendingSaveBeacon) wrote that empty
// string over the good scene → 0 bytes. Fix: serializedPack returns null on
// failure; callers ABORT the write instead of clobbering.
//
// This probe: load scene, add City_Sample_512 (scene sub-asset) via the shell
// postMessage bridge, then fire the pagehide beacon path and assert the on-disk
// scene.pack.json is NOT emptied. The assertion is done by the CALLER (bash)
// reading the file before/after — this script only drives the browser actions.
//
// Run:  node e2e/scripts/probe-city-import-noclobber.mjs
// Expects the stack up + the file-size check wrapped by the bash caller.

import { chromium } from '@playwright/test';

const URL = process.env.HOST_URL ?? 'http://localhost:15290/';
// The scene sub-asset guid of city_Sample_512.glb (kind=scene, 360 nodes).
const CITY = {
  guid: process.env.CITY_GUID ?? '019f27b9-1009-7977-80e1-f1d992c7b430',
  path: process.env.CITY_META ?? 'assets/city_Sample_512.glb.meta.json',
  name: 'city_Sample_512',
};
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
  console.log(`[probe] loaded entities=${loaded[1]}`);

  const vp = page.frames().find((f) => f.url().includes('viewportOnly'));
  if (!vp) {
    console.error('FAIL: viewport iframe not found');
    await browser.close();
    process.exit(1);
  }

  // Fire the shell "Add to Scene" bridge inside the viewport iframe: this routes
  // to spawnAssetRefToScene(ref), whose whole-scene GLB branch creates a native
  // SceneInstance mount (no legacy /api/assets/import-scene parser).
  await vp.evaluate((city) => {
    window.postMessage(
      {
        type: 'FORGEAX_ADD_ASSET_TO_SCENE',
        ref: { type: 'asset', kind: 'scene', guid: city.guid, name: city.name, path: city.path },
      },
      '*',
    );
  }, CITY);
  await sleep(3000); // let the native scene mount + dirty-mark settle

  // Trigger the unload-time beacon flush (the silent clobber path) by dispatching
  // visibilitychange(hidden) + pagehide — mirrors switching away / reload.
  await vp.evaluate(() => {
    try { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); } catch {}
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
  });
  await sleep(1500);

  // Look for the new guard log (proof the write was aborted on serialize-fail).
  const guardHit = logs.some((l) => l.includes('serialize failed'));
  console.log(`[probe] serialize-guard fired: ${guardHit}`);
  // Dump import/spawn/save-relevant console for diagnosis.
  const relevant = logs.filter((l) =>
    /CB:import|spawn|SceneInstance|worldToPack|serialize|beacon|dirty|reference|full/i.test(l) &&
    !/pbr-view-bg|queue-submit|RhiError/.test(l),
  );
  console.log('[probe] --- import/save console ---');
  for (const l of [...new Set(relevant)].slice(0, 20)) console.log(`   ${l}`);
  console.log('[probe] browser actions done — caller checks on-disk file size');

  await browser.close();
  process.exit(0);
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
