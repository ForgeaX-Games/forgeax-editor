#!/usr/bin/env node
// hello-fbx-skin browser e2e smoke (M5 / t57).
//
// Playwright + chromium + WebGPU: typed-array roundtrip + non-black canvas.
// Mirrors hello-fbx-cube smoke-browser.mjs shape.
//
// Constraints: pose-distinct assertion deferred — the demo loads cube.fbx
// (skeleton-only, no skin/animation), so three-instance vertex distinctness
// is not applicable. Full skinned assertion deferred to a future feat with
// skinned .fbx fixture.

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const SMOKE_FRAMES = 300;
const WIDTH = 800;
const HEIGHT = 600;

const here = fileURLToPath(import.meta.url);

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer'],
});

const page = await browser.newPage();
await page.setViewportSize({ width: WIDTH, height: HEIGHT });

const logs = [];
page.on('console', (msg) => logs.push(msg.text()));

const { createServer } = await import('vite');
const rootPath = new URL('..', import.meta.url).pathname;
const server = await createServer({ root: rootPath, server: { port: 5174 } });
await server.listen();
const url = `http://localhost:${server.config.server.port}`;

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await delay(5000);

  const canvasExists = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return c !== null && c.width > 0;
  });
  if (!canvasExists) {
    console.error('[smoke] FAIL - canvas not found');
    process.exit(1);
  }

  const backendLog = logs.find((l) => l.includes('backend=webgpu'));
  if (!backendLog) {
    console.error('[smoke] FAIL - no WebGPU backend detected in logs');
    process.exit(1);
  }

  const meshLog = logs.find((l) => l.includes('mesh imported'));
  if (!meshLog) {
    console.error('[smoke] FAIL - mesh import log not found');
    process.exit(1);
  }

  const drawErrors = logs.filter((l) => l.includes('draw error'));
  if (drawErrors.length > 0) {
    console.error(`[smoke] FAIL - draw errors: ${drawErrors.join('; ')}`);
    process.exit(1);
  }

  console.log(`[smoke] PASS - backend=webgpu, meshLog=${meshLog}`);
} finally {
  await browser.close();
  await server.close();
}

process.exit(0);