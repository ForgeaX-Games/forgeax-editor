#!/usr/bin/env node

// Read-only runtime probe for a live standalone ForgeaX Editor page. It uses
// the editor's existing diagnostic surface; it does not dispatch operations,
// touch authored state, or install per-frame instrumentation.

import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const DEFAULT_URL = process.env.FORGEAX_GATEWAY_URL ?? 'http://localhost:15290/';
const DEFAULT_DURATION_MS = 3000;
const DEFAULT_OUT = `/tmp/forgeax-chrome-performance/runtime-${Date.now()}`;

function usage() {
  console.log('Usage: bun skills/forgeax-editor-performance/scripts/inspect-runtime.mjs [--headed] [--url URL] [--warmup MS] [--duration MS] [--out DIR]');
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
    url: DEFAULT_URL,
    warmup: 3000,
    duration: DEFAULT_DURATION_MS,
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
    if (arg === '--url' || arg === '--warmup' || arg === '--duration' || arg === '--out') {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === '--url') flags.url = value;
      else if (arg === '--out') flags.out = value;
      else if (arg === '--warmup') flags.warmup = boundedInteger(value, arg);
      else flags.duration = boundedInteger(value, arg);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return flags;
}

async function findEditorRuntime(page) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const runtime = page.frames().find((frame) => {
      try {
        return new URL(frame.url()).pathname.startsWith('/editor/');
      } catch {
        return false;
      }
    });
    if (runtime !== undefined) return runtime;
    await page.waitForTimeout(100);
  }
  throw new Error('authoritative /editor/ runtime frame did not appear');
}

async function measureAnimationFrames(runtime, durationMs) {
  return runtime.evaluate((duration) => new Promise((resolve) => {
    const startedAt = performance.now();
    let frames = 0;
    let finished = false;
    let timeoutId;

    const finish = (timedOut) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      const elapsedMs = Math.max(0, performance.now() - startedAt);
      resolve({
        frames,
        elapsedMs: Number(elapsedMs.toFixed(2)),
        fps: Number((frames * 1000 / Math.max(elapsedMs, 1)).toFixed(2)),
        timedOut,
      });
    };

    const tick = (now) => {
      if (finished) return;
      frames += 1;
      if (now - startedAt >= duration) {
        finish(false);
        return;
      }
      requestAnimationFrame(tick);
    };

    timeoutId = setTimeout(() => finish(true), duration + 1500);
    requestAnimationFrame(tick);
  }), durationMs);
}

async function readRuntimeSnapshot(runtime) {
  return runtime.evaluate(() => {
    const editor = globalThis.__forgeax_editor;
    const world = editor?.gateway?.activeWorld;
    const renderer = editor?.renderer;
    const inspect = typeof world?.inspect === 'function' ? world.inspect() : null;
    const metrics = typeof renderer?.metrics?.snapshot === 'function'
      ? renderer.metrics.snapshot()
      : null;
    const featureDiagnostics = typeof renderer?.renderFeatureDiagnostics === 'function'
      ? renderer.renderFeatureDiagnostics()
      : [];
    const quadrant = typeof editor?.getViewportQuadrant === 'function'
      ? editor.getViewportQuadrant()
      : null;
    return {
      url: location.href,
      mode: editor?.gateway?.mode ?? null,
      playPhase: editor?.gateway?.playPhase ?? null,
      viewport: quadrant === null
        ? null
        : { run: quadrant.run ?? null, display: quadrant.display ?? null },
      world: inspect === null
        ? null
        : {
          entityCount: inspect.entityCount ?? null,
          archetypeCount: inspect.archetypeCount ?? null,
          systemCount: inspect.systemCount ?? null,
          systems: Array.isArray(inspect.systems)
            ? inspect.systems.map((system) => ({
              name: system?.name ?? null,
              sets: Array.isArray(system?.sets) ? [...system.sets] : [],
            }))
            : [],
          schedules: Array.isArray(inspect.schedules)
            ? inspect.schedules.map((schedule) => ({
              name: schedule?.schedule?.name ?? schedule?.schedule ?? null,
              systems: Array.isArray(schedule?.systems)
                ? schedule.systems.map((system) => system?.name ?? null)
                : [],
            }))
            : [],
          activeComponents: inspect.activeComponents ?? [],
          resourceKeys: inspect.resourceKeys ?? [],
        },
      renderer: renderer === undefined
        ? null
        : {
          frustumStats: renderer.frustumStats ?? null,
          visibilityStats: renderer.visibilityStats ?? null,
          perFramePassNames: renderer.perFramePassNames ?? [],
          pipelineDispatchCounts: renderer.pipelineDispatchCounts ?? null,
          bindGroupCounts: renderer.bindGroupCounts ?? null,
          metrics,
          featureDiagnostics,
        },
    };
  });
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const browser = await chromium.launch({
    headless: !flags.headed,
    ...(process.env.FORGEAX_CHROMIUM ? { executablePath: process.env.FORGEAX_CHROMIUM } : {}),
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.goto(flags.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.locator('.fx-dockwrap').waitFor({ state: 'visible', timeout: 60_000 });
    const runtime = await findEditorRuntime(page);
    await runtime.waitForFunction(
      () => globalThis.__forgeax_editor?.gateway?.doc?.registry !== undefined,
      undefined,
      { timeout: 60_000 },
    );
    await page.waitForTimeout(flags.warmup);

    const [snapshot, frameProbe] = await Promise.all([
      readRuntimeSnapshot(runtime),
      measureAnimationFrames(runtime, flags.duration),
    ]);
    const result = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      url: flags.url,
      headed: flags.headed,
      chrome: await browser.version(),
      warmupMs: flags.warmup,
      durationMs: flags.duration,
      frameProbe,
      runtime: snapshot,
    };
    await mkdir(flags.out, { recursive: true });
    await writeFile(`${flags.out}/runtime-diagnostics.json`, `${JSON.stringify(result, null, 2)}\n`);
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
