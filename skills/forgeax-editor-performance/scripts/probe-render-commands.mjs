#!/usr/bin/env node
// Bounded, opt-in RHI command-volume probe for the standalone editor.
//
// The probe monkey-patches the live RHI device only inside its disposable
// Playwright page, restores it after each sample, and never changes the engine
// hot path. It is intended to prove whether two FPS samples carry comparable
// rendering work before their frame rates are compared.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import {
  gatewayEval,
  parseEditCameraJson,
  waitForPlay,
} from '../../../scripts/chrome-performance.mjs';
import { enterConfiguredGameplay } from './gameplay-entry.mjs';

const SURFACES = ['edit', 'play-scene', 'play-game'];

function parseCli(argv) {
  const flags = {
    url: process.env.FORGEAX_GATEWAY_URL ?? 'http://localhost:15290/',
    frames: 60,
    materialStride: 512,
    fpsDuration: 3000,
    surface: 'all',
    headed: false,
    editCamera: undefined,
    playClickText: undefined,
    playReadySelector: undefined,
    playBlockingSelector: undefined,
    out: join('/tmp/forgeax-render-command-probe', new Date().toISOString().replace(/[:.]/g, '-')),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--headed') flags.headed = true;
    else if (arg === '--url') flags.url = argv[++index];
    else if (arg === '--frames') flags.frames = Number(argv[++index]);
    else if (arg === '--material-stride') flags.materialStride = Number(argv[++index]);
    else if (arg === '--fps-duration') flags.fpsDuration = Number(argv[++index]);
    else if (arg === '--surface') flags.surface = argv[++index];
    else if (arg === '--edit-camera-json') flags.editCamera = parseEditCameraJson(argv[++index]);
    else if (arg === '--play-click-text') flags.playClickText = argv[++index];
    else if (arg === '--play-ready-selector') flags.playReadySelector = argv[++index];
    else if (arg === '--play-blocking-selector') flags.playBlockingSelector = argv[++index];
    else if (arg === '--out') flags.out = argv[++index];
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: bun probe-render-commands.mjs [--headed] [--surface all|edit|play-scene|play-game] [--frames n] [--fps-duration ms] [--material-stride bytes] [--edit-camera-json json] [--play-click-text text] [--play-ready-selector css] [--play-blocking-selector css] [--url url] [--out dir]');
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isSafeInteger(flags.frames) || flags.frames < 1 || flags.frames > 600) {
    throw new Error('--frames must be an integer from 1 to 600');
  }
  if (!Number.isSafeInteger(flags.materialStride) || flags.materialStride < 1) {
    throw new Error('--material-stride must be a positive integer');
  }
  if (!Number.isSafeInteger(flags.fpsDuration) || flags.fpsDuration < 250 || flags.fpsDuration > 30000) {
    throw new Error('--fps-duration must be an integer from 250 to 30000');
  }
  if (flags.surface !== 'all' && !SURFACES.includes(flags.surface)) {
    throw new Error(`--surface must be all or one of ${SURFACES.join(', ')}`);
  }
  return flags;
}

async function findRuntimeFrame(page, surface) {
  const globalName = surface === 'edit' ? '__forgeax_editor' : '__forgeax';
  for (let attempt = 0; attempt < 200; attempt += 1) {
    for (const frame of page.frames()) {
      const found = await frame.evaluate((name) => Boolean(globalThis[name]?.renderer), globalName).catch(() => false);
      if (found) return frame;
    }
    await page.waitForTimeout(50);
  }
  throw new Error(`${surface} renderer global ${globalName} did not become available`);
}

async function enterSurface(page, surface, editCamera) {
  if (surface === 'edit') {
    const result = await gatewayEval(page, "gateway.playPhase === 'edit' ? {ok:true} : gateway.dispatch({kind:'stop'},'ai')");
    if (!result?.ok) throw new Error(`cannot enter edit: ${JSON.stringify(result)}`);
    if (editCamera !== undefined) {
      const cameraResult = await gatewayEval(
        page,
        `gateway.dispatch(${JSON.stringify({ kind: 'cameraLookAt', ...editCamera })},'ai')`,
      );
      if (!cameraResult?.ok) {
        throw new Error(`edit camera dispatch failed: ${JSON.stringify(cameraResult)}`);
      }
    }
  } else {
    const result = await gatewayEval(page, "gateway.playPhase === 'play' ? {ok:true} : gateway.dispatch({kind:'play',dirtyPolicy:'last-saved'},'ai')");
    if (!result?.ok) throw new Error(`cannot enter play: ${JSON.stringify(result)}`);
    const lifecycle = await waitForPlay(page);
    if (lifecycle.value?.phase === 'failed') throw new Error(`play failed: ${JSON.stringify(lifecycle.value.error)}`);
    const display = surface === 'play-game' ? 'game' : 'scene';
    const displayResult = await gatewayEval(page, `gateway.dispatch({kind:'setDisplay',display:'${display}'},'ai')`);
    if (!displayResult?.ok) throw new Error(`cannot select ${display}: ${JSON.stringify(displayResult)}`);
  }
  await page.waitForTimeout(1500);
}

async function probeFrame(frame, surface, targetFrames, materialStride) {
  return frame.evaluate(async ({ surface, targetFrames, materialStride }) => {
    const globalName = surface === 'edit' ? '__forgeax_editor' : '__forgeax';
    const runtime = globalThis[globalName];
    const device = runtime?.renderer?.device;
    if (!device || typeof device.createCommandEncoder !== 'function') {
      throw new Error(`${globalName}.renderer.device is unavailable`);
    }

    const originalCreateCommandEncoder = device.createCommandEncoder;
    const originalCreateRenderBundleEncoder = device.createRenderBundleEncoder;
    const originalWriteBuffer = device.queue.writeBuffer;
    const rows = [];
    const auxiliaryRows = [];
    const writeBufferStats = { calls: 0, bytes: 0, largestPayload: null };
    const objectIds = new WeakMap();
    let nextObjectId = 1;
    const objectId = (value) => {
      if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return 0;
      let id = objectIds.get(value);
      if (id === undefined) {
        id = nextObjectId++;
        objectIds.set(value, id);
      }
      return id;
    };
    const commandMethods = [
      'setPipeline',
      'setBindGroup',
      'setVertexBuffer',
      'setIndexBuffer',
      'setStencilReference',
      'draw',
      'drawIndexed',
      'drawIndirect',
      'drawIndexedIndirect',
      'setViewport',
      'setScissorRect',
    ];
    let activeRow = null;
    let activeState = null;
    let activePassIndex = 0;
    let activePassLabel = '';
    const observeCommand = (row, state, passIndex, passLabel, method, args) => {
      row.commands[method] += 1;
      if (method === 'setPipeline') {
        state.pipeline = objectId(args[0]);
        state.pipelineLabel = args[0]?.label ?? '';
      }
      if (method === 'setStencilReference') state.stencilReference = args[0] ?? 0;
      if (method === 'setVertexBuffer') state.vertexBuffers[args[0]] = objectId(args[1]);
      if (method === 'setIndexBuffer') state.indexBuffer = objectId(args[0]);
      if (method === 'setBindGroup') {
        const index = args[0];
        const bindGroupId = objectId(args[1]);
        const dynamicOffsets = args[2];
        const offsets = dynamicOffsets === undefined ? '' : [...dynamicOffsets].join(',');
        const bindState = `${bindGroupId}:${offsets}`;
        state.bindGroups[index] = { objectId: bindGroupId, offsets: [...(dynamicOffsets ?? [])] };
        const bucket = row.bindGroups[index] ??= {
          calls: 0,
          objectIds: [],
          states: [],
          sameObjectAsPrevious: 0,
          sameStateAsPrevious: 0,
          previousObjectId: null,
          previousState: null,
        };
        bucket.calls += 1;
        bucket.objectIds.push(bindGroupId);
        bucket.states.push(bindState);
        if (bucket.previousObjectId === bindGroupId) bucket.sameObjectAsPrevious += 1;
        if (bucket.previousState === bindState) bucket.sameStateAsPrevious += 1;
        bucket.previousObjectId = bindGroupId;
        bucket.previousState = bindState;
      }
      if (method === 'drawIndexed') {
        row.draws.push({
          passIndex,
          passLabel,
          pipeline: state.pipeline,
          pipelineLabel: state.pipelineLabel,
          material: state.bindGroups[1] ?? null,
          mesh: state.bindGroups[2] ?? null,
          instances: state.bindGroups[3] ?? null,
          vertexBuffer: state.vertexBuffers[0] ?? 0,
          indexBuffer: state.indexBuffer,
          indexCount: args[0] ?? 0,
          instanceCount: args[1] ?? 1,
          firstIndex: args[2] ?? 0,
          baseVertex: args[3] ?? 0,
          stencilReference: state.stencilReference,
        });
      }
    };

    device.createCommandEncoder = function createCommandEncoderProbe(desc) {
      const result = originalCreateCommandEncoder.call(this, desc);
      if (!result?.ok) return result;
      const encoder = result.value;
      const row = {
        encoderLabel: desc?.label ?? '',
        createdAt: performance.now(),
        finishedAt: null,
        renderPasses: 0,
        renderBundles: 0,
        passLabels: [],
        commands: Object.fromEntries(commandMethods.map((method) => [method, 0])),
        bindGroups: {},
        draws: [],
      };
      const state = {
        pipeline: 0,
        pipelineLabel: '',
        bindGroups: {},
        vertexBuffers: {},
        indexBuffer: 0,
        stencilReference: 0,
      };
      if (row.encoderLabel === 'render-system-frame') activeRow = row;
      const originalBeginRenderPass = encoder.beginRenderPass;
      const originalFinish = encoder.finish;

      encoder.beginRenderPass = function beginRenderPassProbe(passDesc) {
        const pass = originalBeginRenderPass.call(this, passDesc);
        row.renderPasses += 1;
        const passIndex = row.renderPasses - 1;
        const passLabel = passDesc?.label ?? '';
        row.passLabels.push(passLabel);
        state.pipeline = 0;
        state.pipelineLabel = '';
        state.bindGroups = {};
        state.vertexBuffers = {};
        state.indexBuffer = 0;
        state.stencilReference = 0;
        activeState = state;
        activePassIndex = passIndex;
        activePassLabel = passLabel;
        for (const method of commandMethods) {
          if (typeof pass[method] !== 'function') continue;
          const originalMethod = pass[method];
          pass[method] = function commandProbe(...args) {
            observeCommand(row, state, passIndex, passLabel, method, args);
            return originalMethod.apply(this, args);
          };
        }
        return pass;
      };
      encoder.finish = function finishProbe(...args) {
        const result = originalFinish.apply(this, args);
        row.finishedAt = performance.now();
        if (row.encoderLabel === 'render-system-frame') rows.push(row);
        else auxiliaryRows.push(row);
        if (activeRow === row) {
          activeRow = null;
          activeState = null;
        }
        return result;
      };
      return result;
    };

    if (typeof originalCreateRenderBundleEncoder === 'function') {
      device.createRenderBundleEncoder = function createRenderBundleEncoderProbe(desc) {
        const result = originalCreateRenderBundleEncoder.call(this, desc);
        if (!result?.ok || activeRow === null || activeState === null) return result;
        activeRow.renderBundles += 1;
        const bundleEncoder = result.value;
        for (const method of commandMethods) {
          if (typeof bundleEncoder[method] !== 'function') continue;
          const originalMethod = bundleEncoder[method];
          bundleEncoder[method] = function renderBundleCommandProbe(...args) {
            observeCommand(
              activeRow,
              activeState,
              activePassIndex,
              activePassLabel,
              method,
              args,
            );
            return originalMethod.apply(this, args);
          };
        }
        return result;
      };
    }

    device.queue.writeBuffer = function writeBufferProbe(buffer, bufferOffset, data, dataOffset, size) {
      const availableBytes = ArrayBuffer.isView(data) ? data.byteLength : data.byteLength;
      const byteOffset = ArrayBuffer.isView(data) ? data.byteOffset : 0;
      const sourceBuffer = ArrayBuffer.isView(data) ? data.buffer : data;
      const start = byteOffset + (dataOffset ?? 0);
      const byteLength = size ?? (availableBytes - (dataOffset ?? 0));
      writeBufferStats.calls += 1;
      writeBufferStats.bytes += byteLength;
      if (byteLength > (writeBufferStats.largestPayload?.byteLength ?? 0)) {
        writeBufferStats.largestPayload = new Uint8Array(sourceBuffer, start, byteLength);
      }
      return originalWriteBuffer.apply(this, arguments);
    };

    try {
      const startedAt = performance.now();
      while (rows.length < targetFrames) {
        if (performance.now() - startedAt > 30000) {
          throw new Error(`only observed ${rows.length}/${targetFrames} render-system-frame encoders`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      device.createCommandEncoder = originalCreateCommandEncoder;
      if (typeof originalCreateRenderBundleEncoder === 'function') {
        device.createRenderBundleEncoder = originalCreateRenderBundleEncoder;
      }
      device.queue.writeBuffer = originalWriteBuffer;
    }

    const selected = rows.slice(0, targetFrames);
    const captureStartedAt = selected[0]?.createdAt ?? 0;
    const captureFinishedAt = selected.at(-1)?.finishedAt ?? Number.POSITIVE_INFINITY;
    const selectedAuxiliaryRows = auxiliaryRows.filter(
      (row) => row.finishedAt !== null &&
        row.finishedAt >= captureStartedAt &&
        row.createdAt <= captureFinishedAt,
    );
    const totals = {
      frames: selected.length,
      renderPasses: 0,
      renderBundles: 0,
      passLabels: {},
      commands: Object.fromEntries(commandMethods.map((method) => [method, 0])),
      bindGroups: {},
    };
    for (const row of selected) {
      totals.renderPasses += row.renderPasses;
      totals.renderBundles += row.renderBundles;
      for (const label of row.passLabels) totals.passLabels[label] = (totals.passLabels[label] ?? 0) + 1;
      for (const method of commandMethods) totals.commands[method] += row.commands[method];
      for (const [index, bucket] of Object.entries(row.bindGroups)) {
        const totalBucket = totals.bindGroups[index] ??= {
          calls: 0,
          objectIds: new Set(),
          states: new Set(),
          sameObjectAsPrevious: 0,
          sameStateAsPrevious: 0,
        };
        totalBucket.calls += bucket.calls;
        for (const id of bucket.objectIds) totalBucket.objectIds.add(id);
        for (const state of bucket.states) totalBucket.states.add(state);
        totalBucket.sameObjectAsPrevious += bucket.sameObjectAsPrevious;
        totalBucket.sameStateAsPrevious += bucket.sameStateAsPrevious;
      }
    }
    const bindGroups = Object.fromEntries(Object.entries(totals.bindGroups).map(([index, bucket]) => [index, {
      calls: bucket.calls,
      uniqueObjects: bucket.objectIds.size,
      uniqueStates: bucket.states.size,
      sameObjectAsPrevious: bucket.sameObjectAsPrevious,
      sameStateAsPrevious: bucket.sameStateAsPrevious,
    }]));
    const payload = writeBufferStats.largestPayload;
    const materialPayload = payload !== null && payload.byteLength % materialStride === 0
      ? (() => {
          const hashes = [];
          for (let offset = 0; offset < payload.byteLength; offset += materialStride) {
            let hash = 2166136261;
            for (let index = offset; index < offset + materialStride; index += 1) {
              hash ^= payload[index];
              hash = Math.imul(hash, 16777619);
            }
            hashes.push(hash >>> 0);
          }
          let adjacentEqualSlots = 0;
          for (let index = 1; index < hashes.length; index += 1) {
            if (hashes[index] === hashes[index - 1]) adjacentEqualSlots += 1;
          }
          return {
            byteLength: payload.byteLength,
            slots: hashes.length,
            uniqueSlotHashes: new Set(hashes).size,
            adjacentEqualSlots,
          };
        })()
      : null;
    const materialHashes = [];
    if (payload !== null && payload.byteLength % materialStride === 0) {
      for (let offset = 0; offset < payload.byteLength; offset += materialStride) {
        let hash = 2166136261;
        for (let index = offset; index < offset + materialStride; index += 1) {
          hash ^= payload[index];
          hash = Math.imul(hash, 16777619);
        }
        materialHashes.push(hash >>> 0);
      }
    }
    const sampledDraws = selected[0]?.draws ?? [];
    const groupCounts = (keyOf) => {
      const counts = new Map();
      for (const draw of sampledDraws) {
        const key = keyOf(draw);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const values = [...counts.values()];
      return {
        unique: counts.size,
        repeatedGroups: values.filter((count) => count > 1).length,
        maxGroupSize: values.length === 0 ? 0 : Math.max(...values),
        reducibleDraws: values.reduce((total, count) => total + Math.max(0, count - 1), 0),
      };
    };
    const adjacentRunCounts = (keyOf) => {
      let runCount = 0;
      let repeatedRuns = 0;
      let maxRunSize = 0;
      let reducibleDraws = 0;
      let previousKey;
      let runSize = 0;
      const finishRun = () => {
        if (runSize === 0) return;
        runCount += 1;
        if (runSize > 1) repeatedRuns += 1;
        if (runSize > maxRunSize) maxRunSize = runSize;
        reducibleDraws += Math.max(0, runSize - 1);
      };
      for (const draw of sampledDraws) {
        const key = keyOf(draw);
        if (runSize > 0 && key !== previousKey) {
          finishRun();
          runSize = 0;
        }
        previousKey = key;
        runSize += 1;
      }
      finishRun();
      return { runCount, repeatedRuns, maxRunSize, reducibleDraws };
    };
    const materialKey = (draw) => {
      const offset = draw.material?.offsets?.[0] ?? 0;
      const hash = materialHashes[offset / materialStride];
      return `${draw.material?.objectId ?? 0}:${hash ?? `offset-${offset}`}`;
    };
    const geometryKey = (draw) =>
      `${draw.passIndex}:${draw.pipeline}:${draw.vertexBuffer}:${draw.indexBuffer}:${draw.indexCount}:${draw.firstIndex}:${draw.baseVertex}`;
    const meshKey = (draw) =>
      `${draw.passIndex}:${draw.pipeline}:${draw.vertexBuffer}:${draw.indexBuffer}`;
    const instanceCompatibleKey = (draw) =>
      `${geometryKey(draw)}:${materialKey(draw)}:${draw.stencilReference}`;
    const entityDrawRuns = [];
    for (const draw of sampledDraws) {
      const entityKey =
        `${draw.passIndex}:${draw.mesh?.objectId ?? 0}:` +
        `${draw.mesh?.offsets?.join(',') ?? ''}`;
      const previous = entityDrawRuns[entityDrawRuns.length - 1];
      const run = previous?.entityKey === entityKey ? previous : { entityKey, draws: [] };
      if (run !== previous) entityDrawRuns.push(run);
      run.draws.push(draw);
    }
    const entityBatchCounts = (() => {
      const groups = new Map();
      for (const entity of entityDrawRuns) {
        const signature = entity.draws
          .map(
            (draw) =>
              `${instanceCompatibleKey(draw)}:` +
              `${draw.instances?.objectId ?? 0}:${draw.instances?.offsets?.join(',') ?? ''}`,
          )
          .join('|');
        const current = groups.get(signature);
        if (current === undefined) {
          groups.set(signature, {
            entities: 1,
            drawsPerEntity: entity.draws.length,
            indicesPerEntity: entity.draws.reduce(
              (total, draw) => total + draw.indexCount * draw.instanceCount,
              0,
            ),
          });
        } else {
          current.entities += 1;
        }
      }
      const values = [...groups.values()];
      return {
        sampledEntities: entityDrawRuns.length,
        uniqueBatches: groups.size,
        repeatedBatches: values.filter((group) => group.entities > 1).length,
        maxBatchSize:
          values.length === 0 ? 0 : Math.max(...values.map((group) => group.entities)),
        reducibleEntities: values.reduce(
          (total, group) => total + Math.max(0, group.entities - 1),
          0,
        ),
        reducibleDraws: values.reduce(
          (total, group) => total + Math.max(0, group.entities - 1) * group.drawsPerEntity,
          0,
        ),
        topGroups: values
          .map((group) => ({
            ...group,
            totalDraws: group.entities * group.drawsPerEntity,
            totalIndices: group.entities * group.indicesPerEntity,
          }))
          .sort((a, b) => b.totalIndices - a.totalIndices)
          .slice(0, 20),
      };
    })();
    const drawAnalysis = {
      sampledDraws: sampledDraws.length,
      pipelines: (() => {
        const stats = new Map();
        for (const draw of sampledDraws) {
          const key = `${draw.pipeline}:${draw.pipelineLabel}`;
          const row = stats.get(key) ?? {
            objectId: draw.pipeline,
            label: draw.pipelineLabel,
            draws: 0,
            instances: 0,
            indices: 0,
          };
          row.draws += 1;
          row.instances += draw.instanceCount;
          row.indices += draw.indexCount * draw.instanceCount;
          stats.set(key, row);
        }
        return [...stats.values()].sort((a, b) => b.indices - a.indices);
      })(),
      indexCounts: (() => {
        const values = sampledDraws.map((draw) => draw.indexCount).sort((a, b) => a - b);
        const percentile = (ratio) =>
          values.length === 0 ? 0 : values[Math.ceil(values.length * ratio) - 1];
        return {
          total: values.reduce((sum, value) => sum + value, 0),
          unique: new Set(values).size,
          p50: percentile(0.5),
          p95: percentile(0.95),
          max: values.at(-1) ?? 0,
        };
      })(),
      materialStates: groupCounts(materialKey),
      meshes: groupCounts(meshKey),
      geometry: groupCounts(geometryKey),
      instanceCompatible: groupCounts(instanceCompatibleKey),
      adjacentInstanceCompatible: adjacentRunCounts(instanceCompatibleKey),
      entityBatchCompatible: entityBatchCounts,
      cookMergeCompatible: groupCounts((draw) => `${meshKey(draw)}:${materialKey(draw)}`),
      exactState: groupCounts((draw) =>
        `${geometryKey(draw)}:${materialKey(draw)}:${draw.mesh?.objectId ?? 0}:${draw.mesh?.offsets?.join(',') ?? ''}`
      ),
    };
    const perFrame = {
      renderPasses: totals.renderPasses / totals.frames,
      renderBundles: totals.renderBundles / totals.frames,
      commands: Object.fromEntries(commandMethods.map((method) => [method, totals.commands[method] / totals.frames])),
    };
    const auxiliaryEncoders = (() => {
      const labels = {};
      const commands = Object.fromEntries(commandMethods.map((method) => [method, 0]));
      const pipelines = new Map();
      let renderPasses = 0;
      let renderBundles = 0;
      for (const row of selectedAuxiliaryRows) {
        labels[row.encoderLabel] = (labels[row.encoderLabel] ?? 0) + 1;
        renderPasses += row.renderPasses;
        renderBundles += row.renderBundles;
        for (const method of commandMethods) commands[method] += row.commands[method];
        for (const draw of row.draws) {
          const key = `${draw.pipeline}:${draw.pipelineLabel}`;
          const pipeline = pipelines.get(key) ?? {
            objectId: draw.pipeline,
            label: draw.pipelineLabel,
            draws: 0,
            instances: 0,
            indices: 0,
          };
          pipeline.draws += 1;
          pipeline.instances += draw.instanceCount;
          pipeline.indices += draw.indexCount * draw.instanceCount;
          pipelines.set(key, pipeline);
        }
      }
      return {
        count: selectedAuxiliaryRows.length,
        labels,
        renderPasses,
        renderBundles,
        commands,
        pipelines: [...pipelines.values()].sort((a, b) => b.indices - a.indices),
        perMainFrame: {
          renderPasses: renderPasses / totals.frames,
          renderBundles: renderBundles / totals.frames,
          commands: Object.fromEntries(
            commandMethods.map((method) => [method, commands[method] / totals.frames]),
          ),
        },
      };
    })();
    return {
      surface,
      frameUrl: location.href,
      frustumStats: runtime.renderer.frustumStats,
      canvas: [...document.querySelectorAll('canvas')].map((item) => ({
        width: item.width,
        height: item.height,
        cssWidth: item.clientWidth,
        cssHeight: item.clientHeight,
      })),
      totals,
      perFrame,
      auxiliaryEncoders,
      bindGroups,
      drawAnalysis,
      writeBuffer: {
        calls: writeBufferStats.calls,
        bytes: writeBufferStats.bytes,
        largestPayload: materialPayload,
      },
    };
  }, { surface, targetFrames, materialStride });
}

async function measureAnimationFrames(frame, durationMs) {
  return frame.evaluate((duration) => new Promise((resolve) => {
    const startedAt = performance.now();
    let frames = 0;
    const tick = (now) => {
      frames += 1;
      if (now - startedAt >= duration) {
        const elapsedMs = performance.now() - startedAt;
        resolve({ frames, elapsedMs, fps: frames * 1000 / elapsedMs });
      } else {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  }), durationMs);
}

function assessComparable(results) {
  const edit = results.find((item) => item.surface === 'edit');
  if (!edit) return { comparableToEdit: null, reasons: ['edit sample not requested'] };
  const editDraws = edit.perFrame.commands.draw + edit.perFrame.commands.drawIndexed;
  return Object.fromEntries(results.map((item) => {
    const draws = item.perFrame.commands.draw + item.perFrame.commands.drawIndexed;
    const ratio = editDraws > 0 ? draws / editDraws : null;
    const reasons = [];
    if (item.surface !== 'edit' && (ratio === null || ratio < 0.8 || ratio > 1.25)) {
      reasons.push(`draw workload ratio ${ratio?.toFixed(3) ?? 'n/a'} is outside 0.80..1.25`);
    }
    if (draws === 0) reasons.push('no draw commands observed');
    return [item.surface, { comparableToEdit: reasons.length === 0, drawWorkloadRatio: ratio, reasons }];
  }));
}

async function main() {
  const flags = parseCli(process.argv.slice(2));
  await mkdir(flags.out, { recursive: true });
  const browser = await chromium.launch({
    headless: !flags.headed,
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
    await page.waitForFunction(() => Boolean(globalThis.__forgeaxEval), { timeout: 30000 });
    await page.waitForTimeout(5000);
    const surfaces = flags.surface === 'all' ? SURFACES : [flags.surface];
    const results = [];
    let playPrepared = false;
    for (const surface of surfaces) {
      await enterSurface(page, surface, flags.editCamera);
      if (surface === 'play-game' && !playPrepared) {
        await enterConfiguredGameplay(page, flags);
        await page.waitForTimeout(1000);
        playPrepared = true;
      }
      const runtimeFrame = await findRuntimeFrame(page, surface);
      const fpsProbe = await measureAnimationFrames(runtimeFrame, flags.fpsDuration);
      const result = await probeFrame(runtimeFrame, surface, flags.frames, flags.materialStride);
      results.push({ ...result, fpsProbe });
      await page.screenshot({ path: join(flags.out, `${surface}.png`) });
      console.log(`[render-command-probe] ${surface}: ${JSON.stringify(result.perFrame)}`);
    }
    const report = { flags, results, validity: assessComparable(results) };
    await writeFile(join(flags.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[render-command-probe] report: ${join(flags.out, 'report.json')}`);
    console.log(`[render-command-probe] validity: ${JSON.stringify(report.validity)}`);
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`[render-command-probe] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
