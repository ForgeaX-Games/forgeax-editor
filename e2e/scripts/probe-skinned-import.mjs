// probe-skinned-import.mjs — end-to-end verification of the skinned/animated
// asset loop (Fox.glb via gltf importer, humanoid.fbx via fbx importer):
//   import (real browser cook) → Add to Scene (nested SceneInstance mount) →
//   Save → reopen → geometry persists.
//
// Drives the REAL content-browser import pipeline (setInputFiles on the CB file
// input → importFiles → cookGltfMeta/cookFbxMeta → write meta.json), then the
// FORGEAX_ADD_ASSET_TO_SCENE shell bridge, then ⌘S save, then reload.
//
// Design note: NO fixed `sleep()` to "wait out" async work — every wait polls a
// real condition (a console log marker, the imported GUID appearing in the
// server catalog, or the on-disk pack byte count changing). Fixed sleeps are
// both flaky and slow; condition-waits are the correct pattern.
//
// Usage:  node e2e/scripts/probe-skinned-import.mjs <abs-path-to-asset>
// Env:    HOST_URL (default http://localhost:15290/)
import { chromium } from '@playwright/test';
import { readFile, stat, readFile as rf } from 'node:fs/promises';
import { basename } from 'node:path';

const URL = process.env.HOST_URL ?? 'http://localhost:15290/';
const ASSET = process.argv[2];
if (!ASSET) { console.error('usage: probe-skinned-import.mjs <asset-path>'); process.exit(2); }
const FILE = basename(ASSET);
const IS_FBX = /\.fbx$/i.test(FILE);
const PACK = 'games/sample/assets/scene.pack.json';
const NOISE = /RhiError|queue-submit|pbr-view-bg|at Object\.draw|at tick|at recordFrame|at queueSubmit|at classify|at RhiWgpu|InvalidResource|Validation|Caused by|In Queue|In a set_bind|BindGroup with|GL Driver|ReadPixels|deprecated/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); // used ONLY inside poll loops as the inter-poll gap

/** Poll `logs` for a regex until timeout. Returns the match or null. */
async function waitLog(logs, re, timeoutMs, gap = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const l of logs) { const m = l.match(re); if (m) return m; }
    await sleep(gap);
  }
  return null;
}

/** Poll an arbitrary async predicate until it returns truthy. Swallows the
 *  "Execution context was destroyed" that a mid-poll vite full-reload throws. */
async function waitFor(fn, timeoutMs, gap = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let v = null;
    try { v = await fn(); } catch (e) { if (!/context was destroyed|Target closed|navigation/i.test(String(e))) throw e; }
    if (v) return v;
    await sleep(gap);
  }
  return null;
}

/** True once the server catalog (pack-index.json) contains `guid`. Fetched over
 *  Node (not page.evaluate) so a full-reload navigation can't destroy it. */
async function guidInCatalog(_page, guid) {
  try { const r = await fetch(`${URL.replace(/\/$/, '')}/pack-index.json`); if (!r.ok) return false; const d = await r.json(); return d.some((x) => x.guid === guid); } catch { return false; }
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => { const t = m.text(); if (!NOISE.test(t)) logs.push(t); });
  page.on('pageerror', (e) => { if (!NOISE.test(e.message)) logs.push(`PAGEERROR: ${e.message}`); });

  console.log(`[probe] === ${FILE} (${IS_FBX ? 'fbx' : 'gltf'} importer) ===`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  // Ready marker: the editor logs the physics gate right after the doc/world boots.
  if (!await waitLog(logs, /physics gate:|CBToolbar\.mount/, 40000)) {
    console.error('FAIL: editor never booted'); console.error(logs.slice(-25).join('\n')); await browser.close(); process.exit(1);
  }
  console.log('[probe] editor booted');
  // Wait until the sample scene's own GUID is catalogued (proves boot settled).
  await waitFor(() => guidInCatalog(page, '2b7c9a10-4d5e-5f60-8a1b-2c3d4e5f6071'), 15000);

  // ── 1. IMPORT via the real content-browser file input ──────────────────────
  const buf = await readFile(ASSET);
  await page.locator('input[type=file]').first().setInputFiles({ name: FILE, mimeType: 'application/octet-stream', buffer: buf });
  console.log(`[probe] setInputFiles(${FILE}) — cooking...`);
  const cooked = await waitLog(logs, /pipeline\.importFiles\.done|processFbx\.done|CBToolbar\.import\.done/, 60000);
  console.log(`[probe] cook signal: ${cooked ? cooked[0] : '(none)'}`);

  // ── 2. Read cooked meta → scene sub-asset GUID ─────────────────────────────
  const metaRel = `sample/assets/${FILE}.meta.json`;
  const metaJson = await waitFor(async () => page.evaluate(async (p) => {
    const r = await fetch(`/api/files/raw?path=${encodeURIComponent(p)}`); return r.ok ? await r.text() : null;
  }, metaRel), 20000);
  if (!metaJson) { console.error(`FAIL: cooked meta not found at ${metaRel}`); await browser.close(); process.exit(1); }
  const subs = JSON.parse(metaJson).subAssets ?? [];
  const sceneSub = subs.find((s) => s.kind === 'scene');
  console.log(`[probe] cooked subAssets total=${subs.length} kinds=[${subs.map(s=>s.kind).join(',')}]`);
  if (!sceneSub) { console.error('FAIL: no kind:scene sub-asset — cannot mount'); await browser.close(); process.exit(1); }

  // Importing wrote a new .meta.json → pluginPack fs.watch rebuilds the catalog +
  // broadcasts a vite full-reload. Rather than race that auto-reload, explicitly
  // reload once the new GUID is in the SERVER catalog, then wait for boot. This
  // mirrors real UX (import → asset appears → Add to Scene) with no fixed sleep.
  if (!await waitFor(() => guidInCatalog(page, sceneSub.guid), 20000)) {
    console.error('FAIL: imported scene GUID never entered server catalog'); await browser.close(); process.exit(1);
  }
  logs.length = 0;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitLog(logs, /physics gate:|CBToolbar\.mount/, 40000);
  // Bridge is installed on ViewportComponent mount; wait until a probe ping echoes.
  await waitFor(() => page.evaluate(() => new Promise((res) => {
    const h = (ev) => { if (ev.data?.type === '__PROBE_PING__') { window.removeEventListener('message', h); res(true); } };
    window.addEventListener('message', h); window.postMessage({ type: '__PROBE_PING__' }, '*');
    setTimeout(() => { window.removeEventListener('message', h); res(false); }, 300);
  })), 15000);

  // ── 3. ADD TO SCENE via the shell bridge (nested SceneInstance mount) ───────
  let sawReq = false;
  for (let i = 0; i < 8 && !sawReq; i++) {
    await page.evaluate((ref) => window.postMessage({ type: 'FORGEAX_ADD_ASSET_TO_SCENE', ref: { type: 'asset', kind: 'scene', guid: ref.guid, name: ref.name, path: ref.path } }, '*'),
      { guid: sceneSub.guid, name: FILE.replace(/\.[^.]+$/, ''), path: metaRel });
    sawReq = !!await waitLog(logs, /spawn\.request/, 2500);
  }
  const mounted = await waitLog(logs, /spawn\.scene-mount|GLB scene mount failed|instantiate failed|NOT falling back/, 20000);
  const mountOk = logs.some((l) => /spawn\.scene-mount/.test(l));
  const mountFail = logs.some((l) => /GLB scene mount failed|instantiate failed|NOT falling back/.test(l));
  console.log(`[probe] add-to-scene: spawn.request=${sawReq} mount=${mountOk} fail=${mountFail} (${mounted?mounted[0]:'no signal'})`);

  // ── 4. SAVE (⌘S) — assert the on-disk pack grows and gains a mounts[] entry ──
  const before = (await stat(PACK).catch(() => null))?.size ?? 0;
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  // Wait for the pack file to actually change on disk (byte size differs), not a sleep.
  const grew = await waitFor(async () => {
    try { const s = (await stat(PACK)).size; return s !== before ? s : false; } catch { return false; }
  }, 15000);
  const saveGuard = logs.some((l) => /serialize failed|aborting write/.test(l));
  let packText; try { packText = await rf(PACK, 'utf8'); } catch { packText = ''; }
  if (!packText.trim()) { console.error('FAIL: scene.pack.json missing/empty after save'); await browser.close(); process.exit(1); }
  let pack; try { pack = JSON.parse(packText); } catch (e) { console.error('FAIL: pack invalid JSON:', e.message); await browser.close(); process.exit(1); }
  // Real structure: assets[<scene>] carries { refs:[guid...], payload:{ entities, mounts } }.
  const sceneAsset = (pack.assets ?? []).find((a) => a.kind === 'scene');
  const refs = sceneAsset?.refs ?? [];
  const mounts = sceneAsset?.payload?.mounts ?? [];
  const sceneIdx = refs.indexOf(sceneSub.guid);
  const mountHit = mounts.some((m) => m.source === sceneIdx || m.source === sceneSub.guid);
  const theMount = mounts.find((m) => m.source === sceneIdx);
  console.log(`[probe] saved pack: bytes=${packText.length} grew=${!!grew} guard=${saveGuard} refs=${refs.length} sceneGuidIdx=${sceneIdx} mounts=${mounts.length} mountRefsScene=${mountHit}`);
  if (theMount) console.log(`[probe] mount: memberCount=${theMount.memberCount} source→refs[${theMount.source}]=${refs[theMount.source]}`);

  // ── 5. REOPEN — mount re-instantiates from the saved refs[]/mounts[] ────────
  logs.length = 0;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitLog(logs, /physics gate:|CBToolbar\.mount/, 40000);
  await waitFor(() => guidInCatalog(page, sceneSub.guid), 15000);
  const reopenErr = await waitLog(logs, /asset-not-imported|loadByGuid.*failed|instantiate failed|mount.*failed|pack-orphan/i, 6000);
  console.log(`[probe] reopen: assetErrors=${!!reopenErr}${reopenErr?' ('+reopenErr[0]+')':''}`);

  // ── VERDICT ─────────────────────────────────────────────────────────────────
  const pass = mountOk && !mountFail && !saveGuard && mountHit && !reopenErr && !!grew;
  console.log(`\n[probe] VERDICT ${FILE}: ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
  if (!pass) {
    console.log('[probe] --- diagnostic ---');
    for (const l of [...new Set(logs.filter(l => /CB:import|spawn|mount|serialize|import|cook|Error|error|fail/i.test(l)))].slice(-20)) console.log('   ' + l);
  }
  await browser.close();
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error('probe crashed:', e); process.exit(1); });
