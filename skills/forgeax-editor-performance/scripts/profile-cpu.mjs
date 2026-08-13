#!/usr/bin/env node
// External V8 sampling profiler for ForgeaX Editor runtime work.
// No engine/editor source instrumentation is installed; disabling the script
// therefore has exactly zero runtime cost.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import {
  gatewayEval,
  parseEditCameraJson,
  waitForPlay,
} from '../../../scripts/chrome-performance.mjs';
import { enterConfiguredGameplay } from './gameplay-entry.mjs';
import {
  disableSurfaceProfiler,
  selectedSurfaceFrame,
  startSurfaceProfiler,
} from './cpu-profile-attribution.mjs';

function parseCli(argv) {
  const flags = {
    url: 'http://localhost:15290/',
    surface: 'edit',
    duration: 5000,
    samplingUs: 500,
    editCamera: undefined,
    playClickText: undefined,
    playReadySelector: undefined,
    playBlockingSelector: undefined,
    out: join('/tmp/forgeax-cpu-profile', new Date().toISOString().replace(/[:.]/g, '-')),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--url') flags.url = argv[++index];
    else if (arg === '--surface') flags.surface = argv[++index];
    else if (arg === '--duration') flags.duration = Number(argv[++index]);
    else if (arg === '--sampling-us') flags.samplingUs = Number(argv[++index]);
    else if (arg === '--edit-camera-json') flags.editCamera = parseEditCameraJson(argv[++index]);
    else if (arg === '--play-click-text') flags.playClickText = argv[++index];
    else if (arg === '--play-ready-selector') flags.playReadySelector = argv[++index];
    else if (arg === '--play-blocking-selector') flags.playBlockingSelector = argv[++index];
    else if (arg === '--out') flags.out = argv[++index];
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: bun profile-cpu.mjs [--surface edit|play-scene|play-game] [--duration ms] [--sampling-us us] [--edit-camera-json json] [--play-click-text text] [--play-ready-selector css] [--play-blocking-selector css] [--url url] [--out dir]');
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['edit', 'play-scene', 'play-game'].includes(flags.surface)) {
    throw new Error('--surface must be edit, play-scene, or play-game');
  }
  if (!Number.isSafeInteger(flags.duration) || flags.duration < 1000 || flags.duration > 30000) {
    throw new Error('--duration must be an integer from 1000 to 30000');
  }
  if (!Number.isSafeInteger(flags.samplingUs) || flags.samplingUs < 100 || flags.samplingUs > 10000) {
    throw new Error('--sampling-us must be an integer from 100 to 10000');
  }
  return flags;
}

async function enterSurface(page, flags) {
  if (flags.surface === 'edit') {
    const result = await gatewayEval(page, "gateway.playPhase === 'edit' ? {ok:true} : gateway.dispatch({kind:'stop'},'ai')");
    if (!result?.ok) throw new Error(`cannot enter edit: ${JSON.stringify(result)}`);
    if (flags.editCamera !== undefined) {
      const cameraResult = await gatewayEval(
        page,
        `gateway.dispatch(${JSON.stringify({ kind: 'cameraLookAt', ...flags.editCamera })},'ai')`,
      );
      if (!cameraResult?.ok) throw new Error(`cannot set edit camera: ${JSON.stringify(cameraResult)}`);
    }
  } else {
    const result = await gatewayEval(page, "gateway.playPhase === 'play' ? {ok:true} : gateway.dispatch({kind:'play',dirtyPolicy:'last-saved'},'ai')");
    if (!result?.ok) throw new Error(`cannot enter play: ${JSON.stringify(result)}`);
    const lifecycle = await waitForPlay(page);
    if (lifecycle.value?.phase === 'failed') throw new Error(`play failed: ${JSON.stringify(lifecycle.value.error)}`);
    const display = flags.surface === 'play-game' ? 'game' : 'scene';
    const displayResult = await gatewayEval(page, `gateway.dispatch({kind:'setDisplay',display:'${display}'},'ai')`);
    if (!displayResult?.ok) throw new Error(`cannot select ${display}: ${JSON.stringify(displayResult)}`);
    if (flags.surface === 'play-game') await enterConfiguredGameplay(page, flags);
  }
  await page.waitForTimeout(2000);
}

function summarize(profile) {
  const nodesById = new Map(profile.nodes.map((node) => [node.id, node]));
  const parentById = new Map();
  for (const node of profile.nodes) {
    for (const childId of node.children ?? []) parentById.set(childId, node.id);
  }
  const selfUsByNode = new Map();
  const totalUsByNode = new Map();
  const sampleCountByNode = new Map();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let index = 0; index < samples.length; index += 1) {
    const nodeId = samples[index];
    if (nodeId === undefined) continue;
    selfUsByNode.set(nodeId, (selfUsByNode.get(nodeId) ?? 0) + (deltas[index] ?? 0));
    sampleCountByNode.set(nodeId, (sampleCountByNode.get(nodeId) ?? 0) + 1);
    let ancestorId = nodeId;
    while (ancestorId !== undefined) {
      totalUsByNode.set(ancestorId, (totalUsByNode.get(ancestorId) ?? 0) + (deltas[index] ?? 0));
      ancestorId = parentById.get(ancestorId);
    }
  }
  const rows = profile.nodes.map((node) => {
    const nodeId = node.id;
    const selfUs = selfUsByNode.get(nodeId) ?? 0;
    const frame = nodesById.get(nodeId)?.callFrame;
    return {
      functionName: frame?.functionName || '(anonymous)',
      url: frame?.url ?? '',
      line: (frame?.lineNumber ?? -1) + 1,
      column: (frame?.columnNumber ?? -1) + 1,
      selfMs: selfUs / 1000,
      totalMs: (totalUsByNode.get(nodeId) ?? 0) / 1000,
      samples: sampleCountByNode.get(nodeId) ?? 0,
    };
  });
  const topSelf = [...rows].sort((left, right) => right.selfMs - left.selfMs).slice(0, 80);
  const topTotal = [...rows].sort((left, right) => right.totalMs - left.totalMs).slice(0, 120);
  const totalSampledMs = deltas.reduce((total, value) => total + value, 0) / 1000;
  return { totalSampledMs, sampleCount: samples.length, topSelf, topTotal };
}

async function main() {
  const flags = parseCli(process.argv.slice(2));
  await mkdir(flags.out, { recursive: true });
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--use-angle=metal',
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,WebGPU',
      '--ignore-gpu-blocklist',
      '--window-size=1280,720',
    ],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(flags.url, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await page.waitForFunction(() => Boolean(globalThis.__forgeaxEval), { timeout: 30000 });
    await page.waitForTimeout(5000);
    await enterSurface(page, flags);

    const surfaceFrame = await selectedSurfaceFrame(page, flags.surface);
    const profiler = await startSurfaceProfiler(context, surfaceFrame, flags.samplingUs);
    await page.waitForTimeout(flags.duration);
    const { profile, rawProfile, evidence } = await profiler.stop();
    await disableSurfaceProfiler(profiler);

    const summary = { flags, ownership: evidence, ...summarize(profile) };
    await writeFile(join(flags.out, 'profile.json'), `${JSON.stringify(profile)}\n`);
    await writeFile(join(flags.out, 'target-profile.json'), `${JSON.stringify(rawProfile)}\n`);
    await writeFile(join(flags.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
    console.log(`[cpu-profile] report: ${join(flags.out, 'summary.json')}`);
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`[cpu-profile] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
