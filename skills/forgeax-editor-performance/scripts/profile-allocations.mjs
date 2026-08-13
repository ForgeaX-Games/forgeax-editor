#!/usr/bin/env node
// External V8 allocation-sampling profiler for ForgeaX Editor runtime work.
// The HeapProfiler is enabled only in this disposable Playwright page, so the
// engine/editor has zero allocation-profiler overhead when this script is idle.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { gatewayEval, parseEditCameraJson } from '../../../scripts/chrome-performance.mjs';
import { selectedSurfaceFrame } from './cpu-profile-attribution.mjs';

function parseCli(argv) {
  const flags = {
    url: 'http://localhost:15290/',
    duration: 10000,
    samplingBytes: 32768,
    editCamera: undefined,
    out: join('/tmp/forgeax-allocation-profile', new Date().toISOString().replace(/[:.]/g, '-')),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--url') flags.url = argv[++index];
    else if (arg === '--duration') flags.duration = Number(argv[++index]);
    else if (arg === '--sampling-bytes') flags.samplingBytes = Number(argv[++index]);
    else if (arg === '--edit-camera-json') flags.editCamera = parseEditCameraJson(argv[++index]);
    else if (arg === '--out') flags.out = argv[++index];
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: bun profile-allocations.mjs [--duration ms] [--sampling-bytes bytes] [--edit-camera-json json] [--url url] [--out dir]',
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isSafeInteger(flags.duration) || flags.duration < 1000 || flags.duration > 30000) {
    throw new Error('--duration must be an integer from 1000 to 30000');
  }
  if (
    !Number.isSafeInteger(flags.samplingBytes) ||
    flags.samplingBytes < 1024 ||
    flags.samplingBytes > 1048576
  ) {
    throw new Error('--sampling-bytes must be an integer from 1024 to 1048576');
  }
  return flags;
}

function summarize(profile) {
  const nodes = [];
  // Compute totals with an explicit post-order walk; a node can have many
  // descendants, so every child contributes to its parent's total.
  const byId = new Map();
  const walk = (node, parent) => {
    const row = { node, parent, selfBytes: node.selfSize ?? 0, totalBytes: 0, samples: 0 };
    nodes.push(row);
    byId.set(node.id, row);
    let totalBytes = row.selfBytes;
    for (const child of node.children ?? []) totalBytes += walk(child, row).totalBytes;
    row.totalBytes = totalBytes;
    return row;
  };
  walk(profile.head, undefined);
  for (const sample of profile.samples ?? []) {
    const row = byId.get(sample.nodeId);
    if (row !== undefined) row.samples += 1;
  }

  const functionName = (row) => row?.node.callFrame.functionName || '(anonymous)';
  const project = (row) => {
    const stack = [];
    for (let cursor = row; cursor !== undefined && stack.length < 8; cursor = cursor.parent) {
      stack.push(functionName(cursor));
    }
    return {
      functionName: functionName(row),
      parentFunctionName: row.parent === undefined ? undefined : functionName(row.parent),
      stack,
      url: row.node.callFrame.url,
      line: row.node.callFrame.lineNumber + 1,
      column: row.node.callFrame.columnNumber + 1,
      selfBytes: row.selfBytes,
      totalBytes: row.totalBytes,
      samples: row.samples,
    };
  };
  return {
    sampledBytes: profile.head === undefined ? 0 : byId.get(profile.head.id)?.totalBytes ?? 0,
    sampleCount: profile.samples?.length ?? 0,
    topSelf: [...nodes]
      .sort((left, right) => right.selfBytes - left.selfBytes)
      .slice(0, 100)
      .map(project),
    topTotal: [...nodes]
      .sort((left, right) => right.totalBytes - left.totalBytes)
      .slice(0, 120)
      .map(project),
  };
}

function flattenFrameTree(tree, output = []) {
  output.push(tree.frame);
  for (const child of tree.childFrames ?? []) flattenFrameTree(child, output);
  return output;
}

function attributedHeapProfile(profile, scriptFrames, selectedFrameId) {
  const parentById = new Map();
  const nodeById = new Map();
  const visit = (node, parentId) => {
    nodeById.set(node.id, node);
    if (parentId !== undefined) parentById.set(node.id, parentId);
    for (const child of node.children ?? []) visit(child, node.id);
  };
  visit(profile.head, undefined);

  const samples = [];
  let otherFrameSamples = 0;
  let unattributedSamples = 0;
  for (const sample of profile.samples ?? []) {
    let nodeId = sample.nodeId;
    let ownerFrameId;
    while (nodeId !== undefined) {
      const scriptId = nodeById.get(nodeId)?.callFrame?.scriptId;
      if (scriptId !== undefined) {
        ownerFrameId = scriptFrames.get(String(scriptId));
        if (ownerFrameId !== undefined) break;
      }
      nodeId = parentById.get(nodeId);
    }
    if (ownerFrameId === selectedFrameId) samples.push(sample);
    else if (ownerFrameId === undefined) unattributedSamples++;
    else otherFrameSamples++;
  }

  const selfBytes = new Map();
  for (const sample of samples) {
    selfBytes.set(sample.nodeId, (selfBytes.get(sample.nodeId) ?? 0) + sample.size);
  }
  const clone = (node) => ({
    ...node,
    selfSize: selfBytes.get(node.id) ?? 0,
    ...(node.children === undefined ? {} : { children: node.children.map(clone) }),
  });
  return {
    profile: { ...profile, head: clone(profile.head), samples },
    evidence: {
      method: 'cdp-script-execution-context-frame',
      selectedSamples: samples.length,
      otherFrameSamples,
      unattributedSamples,
      totalSamples: profile.samples?.length ?? 0,
      selectedRatio:
        (profile.samples?.length ?? 0) === 0 ? 0 : samples.length / profile.samples.length,
    },
  };
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
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.goto(flags.url, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await page.waitForFunction(() => Boolean(globalThis.__forgeaxEval), { timeout: 30000 });
    const editResult = await gatewayEval(
      page,
      "gateway.playPhase === 'edit' ? {ok:true} : gateway.dispatch({kind:'stop'},'ai')",
    );
    if (!editResult?.ok) throw new Error(`cannot enter edit: ${JSON.stringify(editResult)}`);
    if (flags.editCamera !== undefined) {
      const cameraResult = await gatewayEval(
        page,
        `gateway.dispatch(${JSON.stringify({ kind: 'cameraLookAt', ...flags.editCamera })},'ai')`,
      );
      if (!cameraResult?.ok) {
        throw new Error(`cannot set edit camera: ${JSON.stringify(cameraResult)}`);
      }
    }
    await page.waitForTimeout(5000);

    const frame = await selectedSurfaceFrame(page, 'edit');
    let client;
    let sessionScope;
    try {
      client = await context.newCDPSession(frame);
      sessionScope = 'oopif-target';
    } catch (error) {
      if (!String(error).includes('part of the parent frame')) throw error;
      client = await context.newCDPSession(page);
      sessionScope = 'page-target-execution-context-filtered';
    }
    const executionContextFrames = new Map();
    const scriptContexts = new Map();
    client.on('Runtime.executionContextCreated', ({ context: created }) => {
      const frameId = created.auxData?.frameId;
      if (typeof frameId === 'string') executionContextFrames.set(created.id, frameId);
    });
    client.on('Debugger.scriptParsed', ({ scriptId, executionContextId }) => {
      scriptContexts.set(String(scriptId), executionContextId);
    });
    await client.send('Runtime.enable');
    await client.send('Debugger.enable');
    await client.send('Page.enable');
    await client.send('HeapProfiler.enable');
    const [{ frameTree }, { targetInfo }] = await Promise.all([
      client.send('Page.getFrameTree'),
      client.send('Target.getTargetInfo'),
    ]);
    const selectedUrl = frame.url();
    const matches = flattenFrameTree(frameTree).filter((item) => item.url === selectedUrl);
    if (matches.length !== 1) {
      throw new Error(`CDP frame ownership is ambiguous for ${selectedUrl}: ${matches.length} matches`);
    }
    const selectedFrameId = matches[0].id;
    await client.send('HeapProfiler.startSampling', {
      samplingInterval: flags.samplingBytes,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    await page.waitForTimeout(flags.duration);
    const { profile } = await client.send('HeapProfiler.stopSampling');
    await client.send('HeapProfiler.disable');
    await client.send('Debugger.disable');
    await client.send('Runtime.disable');

    const scriptFrames = new Map(
      [...scriptContexts].map(([scriptId, contextId]) => [scriptId, executionContextFrames.get(contextId)]),
    );
    const attributed = attributedHeapProfile(profile, scriptFrames, selectedFrameId);
    if (attributed.evidence.selectedSamples === 0) {
      throw new Error(`allocation profile has no samples attributable to selected frame ${selectedFrameId}`);
    }
    const ownership = {
      selectedFrameId,
      selectedFrameUrl: selectedUrl,
      sessionTargetId: targetInfo.targetId,
      sessionTargetType: targetInfo.type,
      sessionScope,
      ...attributed.evidence,
    };
    const summary = { flags, ownership, ...summarize(attributed.profile) };
    await writeFile(join(flags.out, 'profile.raw.json'), `${JSON.stringify(profile)}\n`);
    await writeFile(join(flags.out, 'profile.json'), `${JSON.stringify(attributed.profile)}\n`);
    await writeFile(join(flags.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
    console.log(`[allocation-profile] report: ${join(flags.out, 'summary.json')}`);
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      `[allocation-profile] ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
