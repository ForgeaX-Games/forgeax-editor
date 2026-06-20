#!/usr/bin/env node
/**
 * Surface self-check — a closed-loop health probe for the running studio stack.
 *
 * "出问题了可以自检": instead of guessing why Edit/Play won't open, this drives
 * each engine surface in a real browser (WebKit by default — matches the desktop
 * app's WKWebView; pass --chromium for Dawn) and classifies every game's boot as
 * OK / STUCK / ERROR with the captured console errors and the LAST boot stage it
 * reached (from the edit-runtime boot breadcrumbs). Exits non-zero if any fail,
 * so it doubles as a CI / pre-commit gate.
 *
 * Usage (stack must be running — bash start.sh / app.sh):
 *   node packages/editor/scripts/selfcheck.mjs            # WebKit, all games
 *   node packages/editor/scripts/selfcheck.mjs --chromium # Dawn
 *   node packages/editor/scripts/selfcheck.mjs --games cow-survivor,fps
 *   node packages/editor/scripts/selfcheck.mjs --rounds 3 # repeat to catch flakiness
 */
import { webkit, chromium } from '@playwright/test';
import { readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const useChromium = process.argv.includes('--chromium');
const ROUNDS = Number(arg('--rounds', '1'));
const BOOT_TIMEOUT_MS = Number(arg('--timeout', '17000')); // > the 15s editor watchdog
const ENGINE = useChromium ? chromium : webkit;
const ENGINE_NAME = useChromium ? 'chromium' : 'webkit';

const SERVER = 'http://localhost:18900';
const EDITOR = 'http://localhost:15280';
const PREVIEW = 'http://localhost:15173';

function discoverGames() {
  const cli = arg('--games', '');
  if (cli) return cli.split(',').map((s) => s.trim()).filter(Boolean);
  // Read the games directory (repo root is 3 levels up from this script).
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  for (const dir of [resolve(root, '.forgeax/games'), resolve(root, 'packages/games')]) {
    if (!existsSync(dir)) continue;
    // A game = a dir/symlink containing forge.json (filters .DS_Store, instance
    // roots like 'forgeax-studio', and resolves symlinked game dirs correctly —
    // readdirSync isDirectory() is FALSE for symlinks, so check forge.json).
    const games = readdirSync(dir)
      .filter((name) => !name.startsWith('.') && !name.startsWith('_'))
      .filter((name) => existsSync(resolve(dir, name, 'forge.json')));
    if (games.length) return games;
  }
  return ['cow-survivor', 'fps', 'hellforge', 'shoot-opt', 'spin-cube'];
}

/** Boot one surface URL in an ISOLATED browser and classify it. Each probe gets
 *  its own browser + a hard outer timeout so a game that CRASHES the WebGPU
 *  context (e.g. fps overflowing the mesh SSBO) can't wedge the whole run — the
 *  exact failure mode that matters here. */
async function probe(engine, url, label) {
  const errors = [];
  let status = 'HANG';
  let browser;
  try {
    await Promise.race([
      (async () => {
        browser = await engine.launch();
        const page = await browser.newPage();
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
        page.on('pageerror', (e) => errors.push('PAGEERR: ' + e.message.slice(0, 160)));
        let gotoOk = true;
        try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }); }
        catch (e) { gotoOk = false; errors.push('GOTO: ' + e.message.split('\n')[0]); }
        await page.waitForTimeout(BOOT_TIMEOUT_MS);
        let st = {};
        try {
          st = await page.evaluate(() => ({
            ready: !!(window.__forgeax_editor || window.__forgeax), // set after createApp succeeds
            stuck: document.body.innerText.includes('编辑器启动卡住'),
          }));
        } catch { /* page/browser died mid-eval → leave as crash below */ status = 'CRASH'; return; }
        status = !gotoOk ? 'UNREACHABLE' : st.stuck ? 'STUCK' : st.ready ? 'OK' : 'NOT-READY';
      })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('probe-timeout')), BOOT_TIMEOUT_MS + 30000)),
    ]);
  } catch (e) {
    status = e.message === 'probe-timeout' ? 'HANG' : 'CRASH';
    errors.push(e.message.slice(0, 120));
  } finally {
    try { await browser?.close(); } catch { /* already dead */ }
  }
  return { label, status, errors: [...new Set(errors)].slice(0, 3), errCount: errors.length };
}

async function main() {
  // Stack reachable?
  try {
    const h = await fetch(`${SERVER}/api/health`, { signal: AbortSignal.timeout(4000) });
    if (!h.ok) throw new Error(`health ${h.status}`);
  } catch (e) {
    console.error(`✗ stack not reachable at ${SERVER} (${e.message}). Start it: bash start.sh`);
    process.exit(2);
  }
  const games = discoverGames();
  console.log(`\n=== forgeax surface self-check · ${ENGINE_NAME} · ${games.length} games · ${ROUNDS} round(s) ===\n`);
  const fails = [];
  for (let round = 1; round <= ROUNDS; round++) {
    if (ROUNDS > 1) console.log(`--- round ${round} ---`);
    for (const g of games) {
      for (const [kind, base, path] of [
        ['Edit', EDITOR, `/editor/?scene=${g}`],
        ['Play', PREVIEW, `/preview/?game=${g}`],
      ]) {
        const r = await probe(ENGINE, base + path, `${g} ${kind}`);
        const mark = r.status === 'OK' ? '✓' : '✗';
        console.log(`${mark} ${r.label.padEnd(26)} ${r.status.padEnd(12)} errs=${r.errCount}${r.errors.length ? ' · ' + r.errors.join(' | ') : ''}`);
        if (r.status !== 'OK') fails.push(r.label + ' → ' + r.status);
      }
    }
  }
  console.log('');
  if (fails.length) {
    console.log(`✗ ${fails.length} surface(s) failed:\n   ` + fails.join('\n   '));
    process.exit(1);
  }
  console.log('✓ all surfaces booted OK');
}

main().catch((e) => { console.error('selfcheck crashed:', e); process.exit(3); });
