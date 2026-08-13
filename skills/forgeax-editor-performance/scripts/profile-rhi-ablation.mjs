#!/usr/bin/env node

// External, bounded RHI command ablation for root-cause diagnosis. The patch is
// installed only in this script's disposable Playwright page and is restored
// before exit; the engine's ordinary runtime path is unchanged.

import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import {
  gatewayEval,
  parseEditCameraJson,
  parseTraceText,
  readTraceStream,
  summarizeTrace,
  waitForPlay,
  withTimeout,
} from '../../../scripts/chrome-performance.mjs';
import { enterConfiguredGameplay } from './gameplay-entry.mjs';

const TRACE_CATEGORIES = ['devtools.timeline', 'blink', 'blink.user_timing', 'cc', 'gpu', 'viz'];
const MODES = [
  'none',
  'draw-indexed',
  'zero-indexed',
  'main-pass',
  'mesh-index-reorder',
  'shadow-no-draw',
];

function readHostLoad() {
  const logicalCpus = cpus().length;
  const [oneMinute, fiveMinutes, fifteenMinutes] = loadavg();
  return {
    logicalCpus,
    loadAverage: { oneMinute, fiveMinutes, fifteenMinutes },
    normalizedOneMinute: logicalCpus === 0 ? null : oneMinute / logicalCpus,
  };
}

function parseCli(argv) {
  const flags = {
    url: process.env.FORGEAX_GATEWAY_URL ?? 'http://localhost:15290/',
    mode: 'draw-indexed',
    headed: false,
    warmup: 3000,
    duration: 10000,
    viewport: { width: 1280, height: 720 },
    editCamera: { pos: [0, 180, 200], lookAt: [0, 0, 0] },
    surface: 'edit',
    playClickText: undefined,
    playReadySelector: undefined,
    playBlockingSelector: undefined,
    out: join('/tmp/forgeax-rhi-ablation', new Date().toISOString().replace(/[:.]/g, '-')),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--headed') flags.headed = true;
    else if (arg === '--url') flags.url = argv[++index];
    else if (arg === '--mode') flags.mode = argv[++index];
    else if (arg === '--warmup') flags.warmup = Number(argv[++index]);
    else if (arg === '--duration') flags.duration = Number(argv[++index]);
    else if (arg === '--viewport') {
      const match = /^(\d+)x(\d+)$/.exec(argv[++index] ?? '');
      if (match === null) throw new Error('--viewport must use WIDTHxHEIGHT');
      flags.viewport = { width: Number(match[1]), height: Number(match[2]) };
    }
    else if (arg === '--edit-camera-json') flags.editCamera = parseEditCameraJson(argv[++index]);
    else if (arg === '--surface') flags.surface = argv[++index];
    else if (arg === '--play-click-text') flags.playClickText = argv[++index];
    else if (arg === '--play-ready-selector') flags.playReadySelector = argv[++index];
    else if (arg === '--play-blocking-selector') flags.playBlockingSelector = argv[++index];
    else if (arg === '--out') flags.out = argv[++index];
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun profile-rhi-ablation.mjs [--headed] [--surface edit|play-game] [--mode ${MODES.join('|')}] [--warmup ms] [--duration ms] [--viewport WIDTHxHEIGHT] [--edit-camera-json json] [--play-click-text text] [--play-ready-selector css] [--play-blocking-selector css] [--url url] [--out dir]`);
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!MODES.includes(flags.mode)) throw new Error(`--mode must be one of ${MODES.join(', ')}`);
  if (flags.surface !== 'edit' && flags.surface !== 'play-game') {
    throw new Error('--surface must be edit or play-game');
  }
  for (const [name, value] of [['--warmup', flags.warmup], ['--duration', flags.duration]]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 60000) {
      throw new Error(`${name} must be an integer in [0, 60000]`);
    }
  }
  for (const [name, value] of Object.entries(flags.viewport)) {
    if (!Number.isSafeInteger(value) || value < 64 || value > 8192) {
      throw new Error(`--viewport ${name} must be an integer in [64, 8192]`);
    }
  }
  return flags;
}

async function findRuntime(page, surface) {
  const globalName = surface === 'edit' ? '__forgeax_editor' : '__forgeax';
  for (let attempt = 0; attempt < 400; attempt += 1) {
    for (const frame of page.frames()) {
      const found = await frame.evaluate((name) => Boolean(globalThis[name]?.renderer?.device), globalName)
        .catch(() => false);
      if (found) return frame;
    }
    await page.waitForTimeout(50);
  }
  throw new Error(`${surface} renderer did not become available`);
}

async function installAblation(frame, surface, mode) {
  return frame.evaluate(({ surface, selectedMode }) => {
    const runtimeGlobal = surface === 'edit' ? globalThis.__forgeax_editor : globalThis.__forgeax;
    const device = runtimeGlobal?.renderer?.device;
    if (!device || typeof device.createCommandEncoder !== 'function') {
      throw new Error(`${surface} renderer RHI device is unavailable`);
    }
    const originalCreateCommandEncoder = device.createCommandEncoder;
    const counters = {
      encoders: 0,
      renderPasses: 0,
      suppressed: {},
    };
    if (selectedMode === 'mesh-index-reorder') {
      const runtime = runtimeGlobal;
      const world = runtime?.world;
      const store = runtime?.renderer?.store;
      if (!world || !store || typeof store.updateMesh !== 'function') {
        throw new Error('Edit world mesh store is unavailable');
      }
      const handles = new Set();
      for (const table of world.graph.tables) {
        if (!table || table.size === 0) continue;
        for (const storage of table.storage.values()) {
          const values = storage.fields.get('assetHandle')?.view;
          if (values === undefined) continue;
          for (let index = 0; index < table.size; index += 1) handles.add(values[index]);
        }
      }
      const cacheMisses = (indices, capacity = 32) => {
        const cache = [];
        let misses = 0;
        for (const vertex of indices) {
          const position = cache.indexOf(vertex);
          if (position < 0) {
            misses += 1;
          } else {
            cache.splice(position, 1);
          }
          cache.unshift(vertex);
          if (cache.length > capacity) cache.pop();
        }
        return misses;
      };
      const reorderTriangles = (source) => {
        const triangleCount = source.length / 3;
        const adjacency = new Map();
        for (let triangle = 0; triangle < triangleCount; triangle += 1) {
          for (let corner = 0; corner < 3; corner += 1) {
            const vertex = source[triangle * 3 + corner];
            const triangles = adjacency.get(vertex);
            if (triangles === undefined) adjacency.set(vertex, [triangle]);
            else triangles.push(triangle);
          }
        }
        const emitted = new Uint8Array(triangleCount);
        const output = new Uint16Array(source.length);
        const cache = [];
        const candidates = new Set();
        let written = 0;
        let nextOriginal = 0;
        const addAdjacent = (triangle) => {
          for (let corner = 0; corner < 3; corner += 1) {
            const vertex = source[triangle * 3 + corner];
            for (const adjacent of adjacency.get(vertex) ?? []) {
              if (emitted[adjacent] === 0) candidates.add(adjacent);
            }
          }
        };
        while (written < triangleCount) {
          let best = -1;
          let bestScore = -1;
          for (const triangle of candidates) {
            if (emitted[triangle] !== 0) {
              candidates.delete(triangle);
              continue;
            }
            let score = 0;
            for (let corner = 0; corner < 3; corner += 1) {
              const position = cache.indexOf(source[triangle * 3 + corner]);
              if (position >= 0) score += 100 - position;
            }
            if (score > bestScore) {
              best = triangle;
              bestScore = score;
            }
          }
          if (best < 0) {
            while (nextOriginal < triangleCount && emitted[nextOriginal] !== 0) nextOriginal += 1;
            best = nextOriginal;
          }
          candidates.delete(best);
          emitted[best] = 1;
          for (let corner = 0; corner < 3; corner += 1) {
            const vertex = source[best * 3 + corner];
            output[written * 3 + corner] = vertex;
            const position = cache.indexOf(vertex);
            if (position >= 0) cache.splice(position, 1);
            cache.unshift(vertex);
          }
          if (cache.length > 32) cache.length = 32;
          addAdjacent(best);
          written += 1;
        }
        return output;
      };
      const meshIndexReorder = { meshes: 0, indices: 0, cacheMissesBefore: 0, cacheMissesAfter: 0 };
      for (const handle of handles) {
        const resolved = world.sharedRefs.resolve(handle);
        const mesh = resolved?.ok ? resolved.value : undefined;
        if (mesh?.kind !== 'mesh' || !(mesh.indices instanceof Uint16Array)) continue;
        const optimized = new Uint16Array(mesh.indices);
        let changed = false;
        for (const submesh of mesh.submeshes ?? []) {
          if (
            submesh.topology !== 'triangle-list' ||
            submesh.indexCount === 0 ||
            submesh.indexCount % 3 !== 0
          ) continue;
          const source = mesh.indices.slice(
            submesh.indexOffset,
            submesh.indexOffset + submesh.indexCount,
          );
          const reordered = reorderTriangles(source);
          optimized.set(reordered, submesh.indexOffset);
          meshIndexReorder.indices += source.length;
          meshIndexReorder.cacheMissesBefore += cacheMisses(source);
          meshIndexReorder.cacheMissesAfter += cacheMisses(reordered);
          changed = true;
        }
        if (!changed) continue;
        store.updateMesh(handle, mesh.vertices, optimized, 0, mesh.submeshes);
        meshIndexReorder.meshes += 1;
      }
      counters.meshIndexReorder = meshIndexReorder;
    }
    const suppress = (method) => {
      counters.suppressed[method] = (counters.suppressed[method] ?? 0) + 1;
    };
    device.createCommandEncoder = function createCommandEncoderAblation(desc) {
      const result = originalCreateCommandEncoder.call(this, desc);
      if (!result?.ok) return result;
      if (selectedMode === 'shadow-no-draw' && desc?.label === 'render-system-shadow') {
        counters.encoders += 1;
        const encoder = result.value;
        const originalBeginRenderPass = encoder.beginRenderPass;
        encoder.beginRenderPass = function beginShadowPassAblation(passDesc) {
          counters.renderPasses += 1;
          const pass = originalBeginRenderPass.call(this, passDesc);
          for (const method of ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']) {
            if (typeof pass[method] !== 'function') continue;
            pass[method] = function suppressedShadowDraw() { suppress(`shadow.${method}`); };
          }
          return pass;
        };
        return result;
      }
      if (desc?.label !== 'render-system-frame') return result;
      counters.encoders += 1;
      const encoder = result.value;
      const originalBeginRenderPass = encoder.beginRenderPass;
      let passIndex = 0;
      encoder.beginRenderPass = function beginRenderPassAblation(passDesc) {
        const currentPass = passIndex++;
        counters.renderPasses += 1;
        const pass = originalBeginRenderPass.call(this, passDesc);
        if (
          selectedMode === 'none' ||
          selectedMode === 'mesh-index-reorder' ||
          selectedMode === 'shadow-no-draw'
        ) {
          return pass;
        }
        const methods = selectedMode === 'draw-indexed'
          ? ['drawIndexed', 'drawIndexedIndirect']
          : selectedMode === 'zero-indexed'
            ? ['drawIndexed']
          : currentPass === 0
            ? [
                'setPipeline',
                'setBindGroup',
                'setVertexBuffer',
                'setIndexBuffer',
                'setStencilReference',
                'draw',
                'drawIndexed',
                'drawIndirect',
                'drawIndexedIndirect',
              ]
            : [];
        for (const method of methods) {
          if (typeof pass[method] !== 'function') continue;
          if (selectedMode === 'zero-indexed' && method === 'drawIndexed') {
            const originalDrawIndexed = pass.drawIndexed;
            pass.drawIndexed = function zeroIndexedDraw(_indexCount, ...args) {
              suppress(method);
              return originalDrawIndexed.call(this, 0, ...args);
            };
            continue;
          }
          pass[method] = function suppressedRhiCommand() {
            suppress(method);
          };
        }
        return pass;
      };
      return result;
    };
    globalThis.__forgeaxRhiAblation = {
      mode: selectedMode,
      counters,
      restore() {
        device.createCommandEncoder = originalCreateCommandEncoder;
        delete globalThis.__forgeaxRhiAblation;
      },
    };
    return { mode: selectedMode };
  }, { surface, selectedMode: mode });
}

async function captureTrace(client, page, durationMs) {
  const completed = new Promise((resolve) => {
    const handler = (payload) => {
      client.off('Tracing.tracingComplete', handler);
      resolve(payload);
    };
    client.on('Tracing.tracingComplete', handler);
  });
  await withTimeout(client.send('Tracing.start', {
    categories: TRACE_CATEGORIES.join(','),
    options: 'record-as-much-as-is',
    transferMode: 'ReturnAsStream',
  }), 60000, 'Tracing.start');
  await page.evaluate(() => {
    performance.clearMarks('forgeax.capture.window.begin');
    performance.clearMarks('forgeax.capture.window.end');
    performance.mark('forgeax.capture.window.begin');
  });
  await page.waitForTimeout(durationMs);
  await page.evaluate(() => performance.mark('forgeax.capture.window.end'));
  await withTimeout(client.send('Tracing.end'), 15000, 'Tracing.end');
  const result = await withTimeout(completed, 45000, 'Tracing.tracingComplete');
  const text = await readTraceStream(client, result.stream, { timeoutMs: 10000 });
  await client.send('IO.close', { handle: result.stream }).catch(() => {});
  return { text, dataLossOccurred: result.dataLossOccurred === true };
}

async function main() {
  const flags = parseCli(process.argv.slice(2));
  const hostLoadAtStart = readHostLoad();
  await mkdir(flags.out, { recursive: true });
  const browser = await chromium.launch({
    headless: !flags.headed,
    args: [
      '--use-angle=metal',
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,WebGPU',
      '--ignore-gpu-blocklist',
      `--window-size=${flags.viewport.width},${flags.viewport.height}`,
    ],
  });
  let context;
  let client;
  try {
    context = await browser.newContext({ viewport: flags.viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const browserErrors = [];
    page.on('pageerror', (error) => browserErrors.push({ kind: 'pageerror', text: error.message }));
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push({ kind: 'console', text: message.text() });
    });
    await page.goto(flags.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (flags.headed) await page.bringToFront();
    await page.waitForFunction(() => Boolean(globalThis.__forgeaxEval), { timeout: 30000 });
    await page.waitForTimeout(5000);
    if (flags.surface === 'edit') {
      const edit = await gatewayEval(page, "gateway.playPhase === 'edit' ? {ok:true} : gateway.dispatch({kind:'stop'},'ai')");
      if (!edit?.ok) throw new Error(`cannot enter Edit: ${JSON.stringify(edit)}`);
      const camera = await gatewayEval(
        page,
        `gateway.dispatch(${JSON.stringify({ kind: 'cameraLookAt', ...flags.editCamera })},'ai')`,
      );
      if (!camera?.ok) throw new Error(`Edit camera failed: ${JSON.stringify(camera)}`);
    } else {
      const play = await gatewayEval(page, "gateway.playPhase === 'play' ? {ok:true} : gateway.dispatch({kind:'play',dirtyPolicy:'last-saved'},'ai')");
      if (!play?.ok) throw new Error(`cannot enter Play: ${JSON.stringify(play)}`);
      const lifecycle = await waitForPlay(page);
      if (lifecycle.value?.phase === 'failed') {
        throw new Error(`Play failed: ${JSON.stringify(lifecycle.value.error)}`);
      }
      const display = await gatewayEval(page, "gateway.dispatch({kind:'setDisplay',display:'game'},'ai')");
      if (!display?.ok) throw new Error(`cannot select game display: ${JSON.stringify(display)}`);
      await enterConfiguredGameplay(page, flags);
    }
    const runtime = await findRuntime(page, flags.surface);
    await page.waitForTimeout(flags.warmup);
    await installAblation(runtime, flags.surface, flags.mode);
    await page.waitForTimeout(1000);
    const hostLoadAtTraceStart = readHostLoad();
    client = await context.newCDPSession(page);
    const captured = await captureTrace(client, page, flags.duration);
    const counters = await runtime.evaluate(() => globalThis.__forgeaxRhiAblation?.counters ?? null);
    const screenshotPath = join(flags.out, `${flags.mode}.png`);
    await page.screenshot({ path: screenshotPath });
    await runtime.evaluate(() => globalThis.__forgeaxRhiAblation?.restore());
    const tracePath = join(flags.out, `${flags.mode}.trace.json`);
    const summaryPath = join(flags.out, `${flags.mode}.summary.json`);
    const trace = summarizeTrace(parseTraceText(captured.text));
    const summary = {
      schemaVersion: 1,
      flags,
      browserVersion: browser.version(),
      hostLoad: {
        start: hostLoadAtStart,
        traceStart: hostLoadAtTraceStart,
        end: readHostLoad(),
      },
      dataLossOccurred: captured.dataLossOccurred,
      counters,
      screenshotPath,
      browserErrors,
      trace,
      interpretation: 'Ablation is diagnostic-only: suppressed commands intentionally change pixels. Compare displayed-frame cadence and GPU-process command cost, not visual output.',
    };
    await writeFile(tracePath, captured.text);
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify({ summaryPath, tracePath, ...summary }, null, 2));
  } finally {
    if (client) await client.detach().catch(() => {});
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
