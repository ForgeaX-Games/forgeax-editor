#!/usr/bin/env node

// One-shot shared-asset identity audit for a disposable Editor browser page.
// It installs no production hooks and does no per-frame work.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { gatewayEval, waitForPlay } from '../../../scripts/chrome-performance.mjs';
import { selectedSurfaceFrame } from './cpu-profile-attribution.mjs';
import { enterConfiguredGameplay } from './gameplay-entry.mjs';

function parseCli(argv) {
  const flags = {
    url: 'http://localhost:15290/',
    surface: 'play-game',
    playClickText: undefined,
    playReadySelector: undefined,
    playBlockingSelector: undefined,
    out: join('/tmp/forgeax-shared-assets', new Date().toISOString().replace(/[:.]/g, '-')),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--url') flags.url = argv[++index];
    else if (arg === '--surface') flags.surface = argv[++index];
    else if (arg === '--play-click-text') flags.playClickText = argv[++index];
    else if (arg === '--play-ready-selector') flags.playReadySelector = argv[++index];
    else if (arg === '--play-blocking-selector') flags.playBlockingSelector = argv[++index];
    else if (arg === '--out') flags.out = argv[++index];
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: bun inspect-shared-assets.mjs [--surface edit|play-scene|play-game] [--play-click-text text] [--play-ready-selector css] [--play-blocking-selector css] [--url url] [--out dir]');
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['edit', 'play-scene', 'play-game'].includes(flags.surface)) {
    throw new Error('--surface must be edit, play-scene, or play-game');
  }
  return flags;
}

async function enterSurface(page, flags) {
  if (flags.surface === 'edit') {
    const result = await gatewayEval(
      page,
      "gateway.playPhase === 'edit' ? {ok:true} : gateway.dispatch({kind:'stop'},'ai')",
    );
    if (!result?.ok) throw new Error(`cannot enter edit: ${JSON.stringify(result)}`);
    return;
  }
  await page.locator('[data-testid="vp-play"]').first().click({ timeout: 60_000 });
  const lifecycle = await waitForPlay(page);
  if (lifecycle.value?.phase === 'failed') {
    throw new Error(`play failed: ${JSON.stringify(lifecycle.value.error)}`);
  }
  const display = flags.surface === 'play-game' ? 'game' : 'scene';
  const displayResult = await gatewayEval(
    page,
    `gateway.dispatch({kind:'setDisplay',display:'${display}'},'ai')`,
  );
  if (!displayResult?.ok) throw new Error(`cannot select ${display}: ${JSON.stringify(displayResult)}`);
  if (flags.surface === 'play-game') await enterConfiguredGameplay(page, flags);
}

async function inspect(frame, surface) {
  return frame.evaluate(async (selectedSurface) => {
    const prefix = location.pathname.startsWith('/preview/') ? '/preview' : '/editor';
    const { MeshRenderer } = await import(
      `${prefix}/node_modules/@forgeax/engine-render/dist/index.mjs`
    );
    const runtime = selectedSurface === 'edit' ? globalThis.__forgeax_editor : globalThis.__forgeax;
    const world = runtime?.gateway?.activeWorld ?? runtime?.world;
    if (world === undefined) throw new Error('active World is unavailable');
    const queryResult = world.query({ read: [MeshRenderer] });
    if (!queryResult.ok) throw queryResult.error;

    const handles = [];
    let meshRendererCount = 0;
    for (const row of queryResult.value) {
      meshRendererCount += 1;
      const renderer = row.get(MeshRenderer);
      for (const handle of renderer.materials) handles.push(handle);
    }
    const uniqueHandles = [...new Set(handles)];
    const payloadIds = new WeakMap();
    let nextPayloadId = 1;
    const handleRows = [];
    for (const handle of uniqueHandles) {
      const resolved = world.sharedRefs.resolve(handle);
      if (!resolved.ok) {
        handleRows.push({ handle, payloadId: null, kind: null, error: resolved.error.code });
        continue;
      }
      const payload = resolved.value;
      let payloadId = payloadIds.get(payload);
      if (payloadId === undefined) {
        payloadId = nextPayloadId++;
        payloadIds.set(payload, payloadId);
      }
      handleRows.push({ handle, payloadId, kind: payload.kind ?? null, error: null });
    }
    const uniquePayloads = new Set(
      handleRows.flatMap((row) => row.payloadId === null ? [] : [row.payloadId]),
    ).size;
    const handleUsage = new Map();
    for (const handle of handles) handleUsage.set(handle, (handleUsage.get(handle) ?? 0) + 1);
    const usageCounts = [...handleUsage.values()];
    return {
      surface: selectedSurface,
      meshRendererCount,
      materialSlots: handles.length,
      uniqueHandles: uniqueHandles.length,
      uniquePayloads,
      redundantHandlesByPayloadIdentity: uniqueHandles.length - uniquePayloads,
      repeatedHandles: usageCounts.filter((count) => count > 1).length,
      maxHandleUse: usageCounts.length === 0 ? 0 : Math.max(...usageCounts),
      unresolvedHandles: handleRows.filter((row) => row.error !== null).length,
      sharedRefLiveCount: world.sharedRefs._liveCount(),
    };
  }, surface);
}

async function main() {
  const flags = parseCli(process.argv.slice(2));
  const browser = await chromium.launch({
    headless: false,
    ...(process.env.FORGEAX_CHROMIUM ? { executablePath: process.env.FORGEAX_CHROMIUM } : {}),
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.goto(flags.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => Boolean(globalThis.__forgeaxEval), undefined, { timeout: 60_000 });
    await enterSurface(page, flags);
    await page.waitForTimeout(3000);
    const frame = await selectedSurfaceFrame(page, flags.surface);
    const report = await inspect(frame, flags.surface);
    const result = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      url: flags.url,
      chrome: await browser.version(),
      ...report,
    };
    await mkdir(flags.out, { recursive: true });
    await writeFile(`${flags.out}/shared-assets.json`, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ out: flags.out, ...result }, null, 2));
    await context.close();
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
