#!/usr/bin/env node

// Bounded Chrome CPU sampling for a live standalone ForgeaX Editor page.
// Sampling is intentionally short and produces an offline .cpuprofile; it is
// not an FPS benchmark and must be compared with a separate trace sample.

import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { enterConfiguredGameplay } from './gameplay-entry.mjs';
import {
  disableSurfaceProfiler,
  selectedSurfaceFrame,
  startSurfaceProfiler,
} from './cpu-profile-attribution.mjs';

const DEFAULT_URL = process.env.FORGEAX_GATEWAY_URL ?? 'http://localhost:15290/';
const DEFAULT_OUT = `/tmp/forgeax-chrome-performance/cpu-profile-${Date.now()}`;

function usage() {
  console.log('Usage: bun skills/forgeax-editor-performance/scripts/capture-cpu-profile.mjs [--headed] [--surface edit|play-scene|play-game] [--play-click-text text] [--play-ready-selector css] [--play-blocking-selector css] [--url URL] [--warmup MS] [--duration MS] [--interval US] [--out DIR]');
}

function boundedInteger(value, flag, { min = 1, max = 60_000 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be an integer in [${min}, ${max}], got ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const flags = {
    headed: false,
    surface: 'edit',
    url: DEFAULT_URL,
    warmup: 3000,
    duration: 5000,
    interval: 1000,
    playClickText: undefined,
    playReadySelector: undefined,
    playBlockingSelector: undefined,
    out: DEFAULT_OUT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--headed') {
      flags.headed = true;
      continue;
    }
    if (arg === '--surface') {
      const value = argv[++index];
      if (!['edit', 'play-scene', 'play-game'].includes(value)) {
        throw new Error(`--surface must be edit, play-scene, or play-game, got ${value}`);
      }
      flags.surface = value;
      continue;
    }
    if (arg === '--url' || arg === '--warmup' || arg === '--duration' || arg === '--interval' || arg === '--out' || arg === '--play-click-text' || arg === '--play-ready-selector' || arg === '--play-blocking-selector') {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === '--url') flags.url = value;
      else if (arg === '--out') flags.out = value;
      else if (arg === '--play-click-text') flags.playClickText = value;
      else if (arg === '--play-ready-selector') flags.playReadySelector = value;
      else if (arg === '--play-blocking-selector') flags.playBlockingSelector = value;
      else if (arg === '--warmup') flags.warmup = boundedInteger(value, arg);
      else if (arg === '--duration') flags.duration = boundedInteger(value, arg);
      else flags.interval = boundedInteger(value, arg, { max: 50_000 });
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return flags;
}

async function waitForEditor(page) {
  await page.locator('.fx-dockwrap').waitFor({ state: 'visible', timeout: 60_000 });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const runtime = page.frames().find((frame) => {
      try {
        return new URL(frame.url()).pathname.startsWith('/editor/');
      } catch {
        return false;
      }
    });
    if (runtime !== undefined) {
      await runtime.waitForFunction(
        () => globalThis.__forgeax_editor?.gateway?.doc?.registry !== undefined,
        undefined,
        { timeout: 60_000 },
      );
      return runtime;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('authoritative /editor/ runtime frame did not appear');
}

async function prepareSurface(page, runtime, flags) {
  if (flags.surface === 'edit') return;
  await page.locator('[data-testid="vp-play"]').first().click({ timeout: 60_000 });
  await runtime.waitForFunction(
    () => globalThis.__forgeax_editor?.gateway?.playPhase === 'play',
    undefined,
    { timeout: 60_000 },
  );
  await runtime.locator('[data-testid="game-overlay-fps"]').waitFor({
    state: 'attached',
    timeout: 60_000,
  });
  if (flags.surface === 'play-game') {
    await runtime.evaluate(() => {
      const editor = globalThis.__forgeax_editor;
      const gateway = editor?.gateway;
      if (typeof gateway?.dispatch !== 'function') {
        throw new Error('editor gateway dispatch is unavailable');
      }
      const result = gateway.dispatch({ kind: 'setDisplay', display: 'game' }, 'ai');
      if (!result?.ok) throw new Error(`setDisplay(game) failed: ${JSON.stringify(result)}`);
    });
    await enterConfiguredGameplay(page, flags);
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const browser = await chromium.launch({
    headless: !flags.headed,
    ...(process.env.FORGEAX_CHROMIUM ? { executablePath: process.env.FORGEAX_CHROMIUM } : {}),
  });
  let profiler;
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.goto(flags.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (flags.headed) await page.bringToFront();
    const runtime = await waitForEditor(page);
    await prepareSurface(page, runtime, flags);
    await page.waitForTimeout(flags.warmup);

    const surfaceFrame = await selectedSurfaceFrame(page, flags.surface);
    profiler = await startSurfaceProfiler(context, surfaceFrame, flags.interval);
    const startedAt = new Date().toISOString();
    await page.waitForTimeout(flags.duration);
    const { profile, rawProfile, evidence } = await profiler.stop();
    const result = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      startedAt,
      url: flags.url,
      headed: flags.headed,
      surface: flags.surface,
      chrome: await browser.version(),
      warmupMs: flags.warmup,
      durationMs: flags.duration,
      samplingIntervalUs: flags.interval,
      ownership: evidence,
      profile,
    };
    await mkdir(flags.out, { recursive: true });
    await writeFile(`${flags.out}/cpu-profile.cpuprofile`, `${JSON.stringify(profile, null, 2)}\n`);
    await writeFile(`${flags.out}/target-profile.cpuprofile`, `${JSON.stringify(rawProfile, null, 2)}\n`);
    await writeFile(`${flags.out}/metadata.json`, `${JSON.stringify({ ...result, profile: undefined }, null, 2)}\n`);
    console.log(JSON.stringify({
      out: flags.out,
      surface: flags.surface,
      nodeCount: Array.isArray(profile?.nodes) ? profile.nodes.length : 0,
      sampleCount: Array.isArray(profile?.samples) ? profile.samples.length : 0,
      durationMs: flags.duration,
      samplingIntervalUs: flags.interval,
      ownership: evidence,
    }, null, 2));
    await context.close();
  } finally {
    await disableSurfaceProfiler(profiler);
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
