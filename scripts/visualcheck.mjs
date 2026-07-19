#!/usr/bin/env node
/**
 * Visual self-check — screenshots each surface and classifies RENDERED vs BLACK,
 * so a change can be verified by what the viewport ACTUALLY shows (not just
 * engineReady, which is true even when the canvas renders nothing). Produces
 * full-res PNGs for a human/AI to eyeball + a coarse luminance stat.
 *
 * Usage (stack running):
 *   node packages/editor/scripts/visualcheck.mjs --engine webkit --games cow-survivor
 *   node packages/editor/scripts/visualcheck.mjs --engine chromium
 * Output PNGs: /tmp/forgeax-visual/<game>-<surface>-<engine>.png
 */
import { webkit, chromium } from '@playwright/test';
import { readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const ENGINE_NAME = arg('--engine', 'webkit');
const ENGINE = ENGINE_NAME === 'chromium' ? chromium : webkit;
const WAIT_MS = Number(arg('--wait', '13000'));
const OUT = '/tmp/forgeax-visual';
const EDITOR = 'http://localhost:15280', PREVIEW = 'http://localhost:15173';

function games() {
  const cli = arg('--games', ''); if (cli) return cli.split(',').map((s) => s.trim());
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  for (const dir of [resolve(root, '.forgeax/games'), resolve(root, 'packages/games')]) {
    if (!existsSync(dir)) continue;
    const g = readdirSync(dir).filter((n) => !n.startsWith('.') && !n.startsWith('_') && existsSync(resolve(dir, n, 'forge.json')));
    if (g.length) return g;
  }
  return ['cow-survivor'];
}

async function shoot(engine, url, file) {
  const errors = [];
  let stat = null, status = 'HANG';
  let browser;
  try {
    await Promise.race([
      (async () => {
        browser = await engine.launch();
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        page.on('pageerror', (e) => errors.push(e.message.slice(0, 120)));
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 120)); });
        let gotoOk = true;
        try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch (e) { gotoOk = false; errors.push('GOTO:' + e.message.split('\n')[0]); }
        await page.waitForTimeout(WAIT_MS);
        // Full-res screenshot of the canvas (no downscale — compositor capture).
        try {
          const c = page.locator('canvas').first();
          if (await c.count()) await c.screenshot({ path: file });
          else await page.screenshot({ path: file });
        } catch (e) { errors.push('SHOT:' + e.message.slice(0, 80)); }
        // NOTE: do NOT pixel-analyze via canvas.getImageData — a WebGPU canvas
        // reads back BLACK after present (compositor-only content). The compositor
        // page.screenshot above DOES capture the real frame; the PNG is the verdict
        // (eyeball / AI-Read it). We use PNG byte size only as a coarse signal.
        status = !gotoOk ? 'UNREACHABLE' : 'SHOT';
      })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), WAIT_MS + 30000)),
    ]);
  } catch (e) { status = e.message === 'timeout' ? 'HANG' : 'CRASH'; errors.push(e.message.slice(0, 80)); }
  finally { try { await browser?.close(); } catch { /* dead */ } }
  return { status, stat, errors: [...new Set(errors)].slice(0, 2) };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const gs = games();
  console.log(`\n=== visual self-check · ${ENGINE_NAME} · ${gs.length} games → ${OUT}/ ===\n`);
  for (const g of gs) {
    for (const [kind, base, path] of [['edit', EDITOR, `/editor/?scene=${g}`], ['play', PREVIEW, `/preview/?game=${g}`]]) {
      const file = `${OUT}/${g}-${kind}-${ENGINE_NAME}.png`;
      const r = await shoot(ENGINE, base + path, file);
      const kb = existsSync(file) ? Math.round(statSync(file).size / 1024) : 0;
      // Coarse byte-size signal (full scene ≫ blank). NOT authoritative — Read the
      // PNG for the real verdict (HUD-on-black can still be large).
      const sizeHint = r.status !== 'SHOT' ? r.status : kb < 6 ? 'BLANK?' : `${kb}KB → READ`;
      console.log(`${(g + ' ' + kind).padEnd(24)} ${sizeHint.padEnd(14)} ${r.errors.length ? '· ' + r.errors.join(' | ') : ''}`);
    }
  }
  console.log(`\nPNGs in ${OUT}/ — open/Read them to eyeball the actual render.`);
}
main().catch((e) => { console.error('visualcheck crashed:', e); process.exit(3); });
