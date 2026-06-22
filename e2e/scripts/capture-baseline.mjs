#!/usr/bin/env bun
// capture-baseline.mjs — M5 t10 baseline screenshot capture (one-shot).
//
// Captures first-frame PNG screenshots of all 6 games via engine vite :15173.
// Uses element-level canvas.screenshot() to avoid Playwright page stability
// hangs on continuous WebGPU render loops (fps/shoot-opt/spin-cube).
//
// Usage: bun run --cwd packages/editor e2e/scripts/capture-baseline.mjs
//   Ensure engine vite :15173 is running first:
//     cd packages/editor/packages/play-runtime && FORGEAX_ENGINE_PORT=15173 bunx vite --port 15173 --strictPort

import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const WORKTREE = resolve(import.meta.dirname, '..', '..', '..', '..');
const OUT = resolve(WORKTREE, '.forgeax-harness', 'forgeax-loop',
  'feat-20260619-step-2b-play-runtime-asset-first-startup-6-games-m',
  'screenshots', 'baseline');
const BASE = 'http://localhost:15173/preview/';
const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const GAMES = ['hellforge', 'cow-survivor', 'test3', 'fps', 'spin-cube', 'shoot-opt'];

mkdirSync(OUT, { recursive: true });

async function capture(browser, slug) {
  console.error(`[${slug}] start`);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();

  try {
    await page.goto(`${BASE}?game=${slug}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  } catch (e) {
    console.error(`[${slug}] goto: ${e.message.slice(0, 80)}`);
  }

  // Wait for canvas + render settle
  try { await page.waitForSelector('canvas', { timeout: 20_000 }); } catch {}
  await new Promise(r => setTimeout(r, 5000));

  const fp = resolve(OUT, `${slug}-${TS}.png`);
  let ok = false;

  // Element screenshot on canvas — avoids Playwright page stability hang
  try {
    await page.locator('canvas').screenshot({ path: fp, timeout: 15_000, animations: 'disabled' });
    ok = true;
    console.error(`[${slug}] OK → ${fp}`);
  } catch {
    // Fallback to CDP
    try {
      const cdp = await ctx.newCDPSession(page);
      try { await cdp.send('Animation.disable'); } catch {}
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      (await import('fs')).writeFileSync(fp, Buffer.from(data, 'base64'));
      ok = true;
      console.error(`[${slug}] CDP OK → ${fp}`);
      await cdp.detach().catch(() => {});
    } catch (e) {
      console.error(`[${slug}] FAILED: ${e.message.slice(0, 80)}`);
    }
  }

  await page.close();
  await ctx.close();
  return { slug, ok, path: fp };
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
for (const s of GAMES) await capture(browser, s);
await browser.close();
console.error('done');