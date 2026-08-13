#!/usr/bin/env node
// chrome-performance.mjs — bounded Chrome Performance evidence/benchmark for the standalone editor.
//
// This is a diagnostic/benchmark tool, not a renderer switch. It drives
// Play/Scene/Display through the EditGateway, records a real Chrome trace, and
// emits a small summary that keeps CPU, GPU/Present, and compositor signals
// separate. Large traces stay in /tmp and are never part of a commit.
//
// Usage:
//   bun scripts/chrome-performance.mjs --headed --surface all
//   bun scripts/chrome-performance.mjs --url http://localhost:15290/ --duration 8000
//   bun scripts/chrome-performance.mjs --benchmark --headed --surface edit
//   bun scripts/chrome-performance.mjs --headed --nested --surface edit
//   bun scripts/chrome-performance.mjs --headed --passes --surface edit
//   bun scripts/chrome-performance.mjs --headed --no-diagnostics --surface edit
//   bun scripts/chrome-performance.mjs --headed --surface edit \
//     --edit-camera-json '{"pos":[0,180,200],"lookAt":[0,0,0]}'
//
// The default is headless so the tool is usable in CI. For a root-cause trace,
// use --headed and verify the window is visible/focused; the summary records both
// facts and marks a headless run as diagnostic-only.

import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium as defaultChromium } from '@playwright/test';

const DEFAULT_URL = process.env.FORGEAX_GATEWAY_URL ?? 'http://localhost:15290/';
const DEFAULT_DURATION_MS = 8000;
const DEFAULT_BENCHMARK_WARMUP_MS = 20000;
const DEFAULT_BENCHMARK_DURATION_MS = 20000;
const DEFAULT_MAX_TRACE_BYTES = 128 * 1024 * 1024;
const TRACE_START_TIMEOUT_MS = 60000;
const TRACE_END_TIMEOUT_MS = 15000;
const TRACE_COMPLETE_TIMEOUT_MS = 45000;
const CDP_DETACH_TIMEOUT_MS = 2000;
const CONTEXT_CLOSE_TIMEOUT_MS = 5000;
const BROWSER_CLOSE_TIMEOUT_MS = 10000;
const BASE_TRACE_CATEGORIES = [
  'devtools.timeline',
  'blink',
  'blink.user_timing',
  'cc',
  'gpu',
  'viz',
];
const DEEP_GPU_TRACE_CATEGORY = 'disabled-by-default-gpu.service';

const SURFACES = ['edit', 'play-scene', 'play-game'];

const BACKGROUND_REQUEST_PATTERNS = [
  /^\/api\/logs$/,
  /^\/api\/bus\/ui\/surfaces\/[^/]+\/pending$/,
  /^\/api\/workbench\/games$/,
  /^\/api\/extensions\/list$/,
  /^\/api\/health$/,
];

export function classifyResourceRequest(request) {
  const read = (key, fallback) => {
    const value = request?.[key];
    if (typeof value === 'function') return value.call(request);
    return value ?? fallback;
  };
  const url = read('url', '');
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Keep malformed or relative URLs visible as blocking evidence.
  }
  const background = BACKGROUND_REQUEST_PATTERNS.some((pattern) => pattern.test(pathname));
  return {
    url,
    method: read('method', 'GET'),
    resourceType: read('resourceType', 'unknown'),
    category: background ? 'background-control-plane' : 'blocking',
  };
}

export function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[index] ?? null;
}

function traceEvents(trace) {
  if (Array.isArray(trace)) return trace;
  if (trace && typeof trace === 'object' && Array.isArray(trace.traceEvents)) return trace.traceEvents;
  throw new Error('Chrome trace must be an array or an object with traceEvents[]');
}

export function parseTraceText(text) {
  const parsed = JSON.parse(text);
  return traceEvents(parsed);
}

function eventName(event) {
  return typeof event?.name === 'string' ? event.name : '';
}

function eventCategory(event) {
  return typeof event?.cat === 'string' ? event.cat : '';
}

function durationMs(event) {
  return typeof event?.dur === 'number' ? event.dur / 1000 : 0;
}

function numericValues(value, wantedKeys, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const child of value) numericValues(child, wantedKeys, out);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    if (wantedKeys.has(key) && typeof child === 'number' && Number.isFinite(child)) out.push(child);
    else numericValues(child, wantedKeys, out);
  }
  return out;
}

function eventTimestamps(events, predicate) {
  return events
    .filter(predicate)
    .map((event) => event.ts)
    .filter((ts) => typeof ts === 'number' && Number.isFinite(ts))
    .sort((a, b) => a - b)
    .map((ts) => ts / 1000);
}

function intervalSummary(timestamps) {
  const intervals = timestamps.slice(1).map((ts, index) => ts - timestamps[index]);
  if (intervals.length === 0) return { count: timestamps.length, intervals: null };
  const spanMs = timestamps[timestamps.length - 1] - timestamps[0];
  const p50Ms = percentile(intervals, 0.5);
  return {
    count: timestamps.length,
    intervals: {
      count: intervals.length,
      p50Ms,
      p95Ms: percentile(intervals, 0.95),
      maxMs: Math.max(...intervals),
      // N timestamps contain N-1 frame intervals. Dividing event count by
      // the capture window under-reports a refresh-locked stream because the
      // first/last partial capture intervals are not frames.
      averageFps: spanMs > 0 ? (intervals.length * 1000) / spanMs : null,
      medianFps: p50Ms > 0 ? 1000 / p50Ms : null,
    },
  };
}

function coalesceAnimationFrameTicks(timestamps, thresholdMs = 2) {
  const ticks = [];
  for (const timestamp of timestamps) {
    const previousTick = ticks[ticks.length - 1];
    if (previousTick === undefined || timestamp - previousTick > thresholdMs) ticks.push(timestamp);
  }
  return ticks;
}

/**
 * Preserve the trace coordinates for the slowest frame gaps. Percentiles are
 * useful for comparing samples, but a max interval without its neighboring
 * events is not enough to investigate a hitch. Keep this bounded and
 * descriptive: it identifies the observed gap and owning Chrome tracks, but
 * does not claim a cause.
 */
function slowestIntervals(events, predicate, limit = 5) {
  const points = events
    .filter(predicate)
    .filter((event) => typeof event?.ts === 'number' && Number.isFinite(event.ts))
    .sort((a, b) => a.ts - b.ts);
  const intervals = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    intervals.push({
      intervalMs: Number(((current.ts - previous.ts) / 1000).toFixed(3)),
      startUs: previous.ts,
      endUs: current.ts,
      start: { pid: previous.pid ?? null, tid: previous.tid ?? null },
      end: { pid: current.pid ?? null, tid: current.tid ?? null },
      hotspots: overlapHotspots(events, previous.ts, current.ts, 8, sourceLocation),
    });
  }
  return intervals
    .sort((a, b) => b.intervalMs - a.intervalMs)
    .slice(0, limit);
}

function aggregateDuration(events) {
  const durations = events.map(durationMs).filter((value) => value > 0);
  let maxMs = 0;
  for (const duration of durations) maxMs = Math.max(maxMs, duration);
  return {
    count: events.length,
    totalMs: durations.reduce((sum, value) => sum + value, 0),
    maxMs,
  };
}

/**
 * Rank inclusive trace-event duration by a stable label.
 *
 * Chrome emits nested events for the same work on multiple tracks. These
 * numbers are therefore evidence for hotspot discovery, not utilization or
 * exclusive time. Keep that distinction in the returned model so consumers do
 * not accidentally turn a useful trace hint into a false percentage.
 */
/**
 * Turn Vite/Chrome source URLs into stable repo-relative identities. Origins,
 * query strings, and the current worktree directory are experiment noise;
 * file, line, and column are the useful callsite identity.
 */
export function normalizeTraceUrl(url) {
  if (typeof url !== 'string' || url === '') return null;
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Keep non-URL trace locations inspectable while still removing a query.
    path = url.split(/[?#]/, 1)[0] ?? url;
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep an undecodable trace location rather than dropping source evidence.
  }
  path = path.replace(/^\/@fs\//, '/');
  const repoMarker = '/forgeax-editor/';
  const repoIndex = path.lastIndexOf(repoMarker);
  if (repoIndex >= 0) {
    const relative = path.slice(repoIndex + repoMarker.length);
    return relative.replace(/^\.worktrees\/[^/]+\//, '');
  }
  return path.replace(/^\//, '');
}

function sourceLocation(event) {
  const data = event?.args?.data;
  if (!data || typeof data !== 'object') return null;
  const url = normalizeTraceUrl(data.url);
  const lineNumber = typeof data.lineNumber === 'number' && Number.isFinite(data.lineNumber)
    ? data.lineNumber
    : null;
  const columnNumber = typeof data.columnNumber === 'number' && Number.isFinite(data.columnNumber)
    ? data.columnNumber
    : null;
  if (url === null && lineNumber === null && columnNumber === null) return null;
  return { url, lineNumber, columnNumber };
}

function addSourceLocation(row, source) {
  if (source === null) return;
  const key = JSON.stringify(source);
  if (row.sourceKeys.has(key)) return;
  row.sourceKeys.add(key);
  row.sources.push(source);
}

function sourceKey(source) {
  return source === null ? '' : JSON.stringify(source);
}

function traceIdentityKey(label, event, source) {
  return `${label}|${event?.pid ?? ''}|${event?.tid ?? ''}|${sourceKey(source)}`;
}

/**
 * Rank duration distributions by label and optional callsite. A function name
 * alone is not an owner: engine and interface can both emit `tick`. Keep the
 * distribution and frame-budget counts bounded so this remains evidence, not a
 * benchmark claim.
 */
function durationHotspots(events, labelForEvent, limit = 8, sourceForEvent = null) {
  const groups = new Map();
  for (const event of events) {
    const duration = durationMs(event);
    if (duration <= 0) continue;
    const label = labelForEvent(event);
    if (label === '') continue;
    const source = sourceForEvent ? sourceForEvent(event) : null;
    const key = `${label}|${sourceKey(source)}`;
    const row = groups.get(key) ?? {
      name: label,
      count: 0,
      totalMs: 0,
      maxMs: 0,
      durations: [],
      sourceKeys: new Set(),
      sources: [],
    };
    row.count += 1;
    row.totalMs += duration;
    row.maxMs = Math.max(row.maxMs, duration);
    row.durations.push(duration);
    if (sourceForEvent) addSourceLocation(row, source);
    groups.set(key, row);
  }
  return [...groups.values()]
    .sort((a, b) => b.totalMs - a.totalMs || b.maxMs - a.maxMs || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((row) => {
      const output = {
        name: row.name,
        count: row.count,
        totalMs: Number(row.totalMs.toFixed(3)),
        maxMs: Number(row.maxMs.toFixed(3)),
        p50Ms: Number(percentile(row.durations, 0.5).toFixed(3)),
        p95Ms: Number(percentile(row.durations, 0.95).toFixed(3)),
        overBudget: {
          '16.7ms': row.durations.filter((duration) => duration > 16.7).length,
          '33.3ms': row.durations.filter((duration) => duration > 33.3).length,
          '50ms': row.durations.filter((duration) => duration > 50).length,
        },
      };
      if (row.sources.length > 0) output.sources = row.sources.slice(0, 4);
      return output;
    });
}

/**
 * Rank events that overlap one bounded frame gap. Durations are clipped to the
 * gap, and pid/tid stay attached so renderer, GPU, and compositor work cannot
 * be mistaken for one shared exclusive timeline. The result is a lead list
 * for inspection, not a causal attribution.
 */
function overlapHotspots(events, startUs, endUs, limit = 8, sourceForEvent = null) {
  const groups = new Map();
  for (const event of events) {
    if (typeof event?.ts !== 'number' || typeof event?.dur !== 'number' || event.dur <= 0) continue;
    const overlapUs = Math.min(endUs, event.ts + event.dur) - Math.max(startUs, event.ts);
    if (overlapUs <= 0) continue;
    const name = eventName(event);
    if (name === '') continue;
    const source = sourceForEvent ? sourceForEvent(event) : null;
    const key = traceIdentityKey(name, event, source);
    const row = groups.get(key) ?? {
      name,
      pid: event.pid ?? null,
      tid: event.tid ?? null,
      count: 0,
      totalMs: 0,
      maxMs: 0,
      sourceKeys: new Set(),
      sources: [],
    };
    const overlapMs = overlapUs / 1000;
    row.count += 1;
    row.totalMs += overlapMs;
    row.maxMs = Math.max(row.maxMs, overlapMs);
    if (sourceForEvent) addSourceLocation(row, source);
    groups.set(key, row);
  }
  return [...groups.values()]
    .sort((a, b) => b.totalMs - a.totalMs || b.maxMs - a.maxMs || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((row) => {
      const output = {
        name: row.name,
        pid: row.pid,
        tid: row.tid,
        count: row.count,
        totalMs: Number(row.totalMs.toFixed(3)),
        maxMs: Number(row.maxMs.toFixed(3)),
      };
      if (row.sources.length > 0) output.sources = row.sources.slice(0, 4);
      return output;
    });
}

function functionCallLabel(event) {
  const functionName = event?.args?.data?.functionName;
  return typeof functionName === 'string' && functionName !== '' ? functionName : eventName(event);
}

function captureWindowBounds(events) {
  const captureBegin = events.find((event) =>
    event?.name === 'forgeax.capture.window.begin' &&
    typeof event?.ts === 'number' && Number.isFinite(event.ts),
  );
  const captureEnd = [...events].reverse().find((event) =>
    event?.name === 'forgeax.capture.window.end' &&
    typeof event?.ts === 'number' && Number.isFinite(event.ts),
  );
  return captureBegin !== undefined && captureEnd !== undefined && captureEnd.ts >= captureBegin.ts
    ? { startUs: captureBegin.ts, endUs: captureEnd.ts }
    : null;
}

function eventsInsideCaptureWindow(events) {
  const bounds = captureWindowBounds(events);
  if (bounds === null) return { events, bounds };
  return {
    bounds,
    events: events.flatMap((event) => {
      // Metadata is needed to interpret the bounded tracks, even though Chrome
      // emits it before the harness measurement window.
      if (event?.ph === 'M') return [event];
      if (typeof event?.ts !== 'number' || !Number.isFinite(event.ts)) return [];
      if (typeof event.dur !== 'number' || !Number.isFinite(event.dur) || event.dur <= 0) {
        return event.ts >= bounds.startUs && event.ts <= bounds.endUs ? [event] : [];
      }
      const startUs = Math.max(bounds.startUs, event.ts);
      const endUs = Math.min(bounds.endUs, event.ts + event.dur);
      return endUs > startUs ? [{ ...event, ts: startUs, dur: endUs - startUs }] : [];
    }),
  };
}

function applicationFrameEvents(events, hasCaptureWindow, explicitFrameId) {
  const phaseBegins = events.filter((event) =>
    typeof event?.name === 'string'
    && /^forgeax\.frame\.phase\.\d+\.frame-total\.begin$/.test(event.name)
    && typeof event?.ts === 'number'
    && Number.isFinite(event.ts),
  );
  const animationFrames = events.filter((event) =>
    eventName(event) === 'FireAnimationFrame'
    && typeof event?.ts === 'number'
    && Number.isFinite(event.ts),
  );
  if (explicitFrameId !== undefined) {
    const owned = animationFrames.filter((event) => event?.args?.data?.frame === explicitFrameId);
    return {
      events: owned,
      owner: owned.length === 0 ? null : {
        pid: owned[0]?.pid ?? null,
        tid: owned[0]?.tid ?? null,
        frameIds: [explicitFrameId],
        evidence: 'cdp-frame-tree-rAF-ticks',
      },
    };
  }
  if (phaseBegins.length === 0) {
    // Synthetic/legacy traces without the harness window retain the old
    // diagnostic fallback. A real bounded capture must never mix parent and
    // child rAF streams when owner markers are disabled.
    return hasCaptureWindow ? { events: [], owner: null } : { events: animationFrames, owner: null };
  }

  const ownedEvents = new Set();
  const ownedFrameIds = new Set();
  let ownerPid = null;
  let ownerTid = null;
  for (const phase of phaseBegins) {
    const containingFrame = animationFrames.find((event) => {
      if (event.pid !== phase.pid || event.tid !== phase.tid) return false;
      const endUs = event.ts + (typeof event.dur === 'number' ? event.dur : 0);
      return event.ts <= phase.ts && phase.ts <= endUs;
    });
    const frameId = containingFrame?.args?.data?.frame;
    if (containingFrame === undefined) continue;
    ownedEvents.add(containingFrame);
    if (typeof frameId === 'string') ownedFrameIds.add(frameId);
    ownerPid = phase.pid ?? null;
    ownerTid = phase.tid ?? null;
  }
  const owned = animationFrames.filter((event) => ownedEvents.has(event));
  return {
    events: owned,
    owner: owned.length === 0 ? null : {
      pid: ownerPid,
      tid: ownerTid,
      frameIds: [...ownedFrameIds],
      evidence: 'frame-total-mark-contained-by-rAF',
    },
  };
}

function traceWindowMs(events) {
  // Chrome may retain page-start timeline events outside the requested
  // measurement window (notably `firstMeaningfulPaint`) when Tracing is
  // attached after navigation. The engine-owned frame markers are the
  // authoritative sample boundary, so prefer them whenever present; this
  // keeps startup noise from falsely invalidating an otherwise complete A/B.
  const captureBounds = captureWindowBounds(events);
  if (captureBounds !== null) {
    return (captureBounds.endUs - captureBounds.startUs) / 1000;
  }
  const phaseMarkers = events.filter((event) =>
    typeof event?.name === 'string' &&
    event.name.startsWith('forgeax.frame.phase.') &&
    typeof event?.ts === 'number' &&
    Number.isFinite(event.ts),
  );
  const boundsOf = (candidates) => {
    let startUs = Number.POSITIVE_INFINITY;
    let endUs = Number.NEGATIVE_INFINITY;
    for (const event of candidates) {
      const ts = event.ts;
      const end = ts + (typeof event.dur === 'number' ? event.dur : 0);
      if (ts < startUs) startUs = ts;
      if (end > endUs) endUs = end;
    }
    return startUs === Number.POSITIVE_INFINITY ? null : { startUs, endUs };
  };
  if (phaseMarkers.length > 1) {
    const bounds = boundsOf(phaseMarkers);
    return bounds === null ? null : (bounds.endUs - bounds.startUs) / 1000;
  }
  const timelineEvents = events.filter((event) => {
    if (event?.ph === 'M' || event?.ph === 's' || event?.ph === 'f' || event?.ph === 't') return false;
    return typeof event?.ts === 'number' && Number.isFinite(event.ts);
  });
  if (timelineEvents.length === 0) return null;
  const bounds = boundsOf(timelineEvents);
  return bounds === null ? null : (bounds.endUs - bounds.startUs) / 1000;
}

function traceThreadInventory(events) {
  const processNames = new Map();
  const threadNames = new Map();
  for (const event of events) {
    if (event?.ph !== 'M') continue;
    if (eventName(event) === 'process_name' && typeof event.pid === 'number' && typeof event.args?.name === 'string') {
      processNames.set(event.pid, event.args.name);
    }
    if (eventName(event) === 'thread_name' && typeof event.tid === 'number' && typeof event.args?.name === 'string') {
      threadNames.set(event.tid, event.args.name);
    }
  }
  return {
    processes: [...processNames.entries()].map(([pid, name]) => ({ pid, name })),
    threads: [...threadNames.entries()].map(([tid, name]) => ({ tid, name })),
    hasRendererProcess: [...processNames.values()].some((name) => name === 'Renderer'),
    hasRendererMain: [...threadNames.values()].some((name) => /CrRendererMain|RendererMain/.test(name)),
    hasGpuProcess: [...processNames.values()].some((name) => name === 'GPU Process'),
    hasGpuMain: [...threadNames.values()].some((name) => /CrGpuMain|GPU Main/.test(name)),
    hasVizCompositor: [...threadNames.values()].some((name) => name === 'VizCompositorThread'),
  };
}

function matrixFingerprint(matrix) {
  return JSON.stringify({
    phase: matrix?.state?.value?.phase ?? null,
    mode: matrix?.state?.value?.mode ?? null,
    transformRows: matrix?.state?.value?.transformRows ?? null,
    meshRows: matrix?.state?.value?.meshRows ?? null,
    visible: matrix?.dom?.visible ?? null,
    focused: matrix?.dom?.focused ?? null,
    dpr: matrix?.dom?.dpr ?? null,
    innerWidth: matrix?.dom?.innerWidth ?? null,
    innerHeight: matrix?.dom?.innerHeight ?? null,
    canvases: matrix?.dom?.canvases ?? [],
  });
}

const FRAME_PHASES = [
  'frame-total',
  'world-update-primary',
  'draw-source',
  'world-update-injected',
  'renderer-draw',
];
const FRAME_PHASE_MARK = /^forgeax\.frame\.phase\.(\d+)\.(frame-total|world-update-primary|draw-source|world-update-injected|renderer-draw)\.(begin|end)$/;
const RENDER_PHASES = ['extract', 'bind-groups', 'features', 'sort', 'record'];
const RENDER_PHASE_MARK = /^forgeax\.render\.phase\.(\d+)\.(extract|bind-groups|features|sort|record)\.(begin|end|skip)(?:\.([a-z-]+))?$/;

function phaseDistribution(values) {
  if (values.length === 0) return { count: 0, p50Ms: null, p95Ms: null, maxMs: null };
  return {
    count: values.length,
    p50Ms: Number(percentile(values, 0.5).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...values).toFixed(3)),
  };
}

/**
 * Pair the engine-owned User Timing boundaries without inferring a cause.
 * Missing/duplicate marks are evidence loss, not a performance result. Keep
 * the parser independent of the engine implementation so synthetic traces can
 * exercise the contract before a browser run is available.
 */
function summarizeFramePhases(events) {
  const markers = [];
  for (const [order, event] of events.entries()) {
    const match = eventName(event).match(FRAME_PHASE_MARK);
    if (!match || !eventCategory(event).includes('blink.user_timing')) continue;
    const ts = event?.ts;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
    markers.push({
      frameSeq: Number(match[1]),
      phase: match[2],
      boundary: match[3],
      ts,
      order,
    });
  }

  const empty = {
    present: false,
    markerCount: 0,
    frameCount: 0,
    partialFrameCount: 0,
    sampledFrameCount: 0,
    completeFrameCount: 0,
    requiredPhaseFrameCount: 0,
    requiredPhaseCoverageRatio: 0,
    invalidReasons: [],
    phases: Object.fromEntries(FRAME_PHASES.map((phase) => [phase, phaseDistribution([])])),
  };
  if (markers.length === 0) return empty;

  const reasonSet = new Set();
  let overflowReasons = 0;
  const addReason = (reason) => {
    if (reasonSet.size < 20) reasonSet.add(reason);
    else overflowReasons += 1;
  };
  const frames = new Map();
  for (const marker of markers) {
    const frame = frames.get(marker.frameSeq) ?? [];
    frame.push(marker);
    frames.set(marker.frameSeq, frame);
  }

  const phaseDurations = new Map(FRAME_PHASES.map((phase) => [phase, []]));
  const frameSeqs = [...frames.keys()].sort((a, b) => a - b);
  const firstFrameSeq = frameSeqs[0];
  const lastFrameSeq = frameSeqs[frameSeqs.length - 1];
  let partialFrameCount = 0;
  let completeFrameCount = 0;
  let requiredPhaseFrameCount = 0;
  for (const [frameSeq, frameMarkers] of [...frames.entries()].sort((a, b) => a[0] - b[0])) {
    const byPhase = new Map();
    for (const marker of frameMarkers) {
      const key = `${marker.phase}:${marker.boundary}`;
      if (byPhase.has(key)) addReason(`duplicate:${frameSeq}:${key}`);
      byPhase.set(key, marker);
    }
    const ordered = [...frameMarkers].sort((a, b) => a.ts - b.ts || a.order - b.order);
    const expectedOrder = [
      ['frame-total', 'begin'],
      ['world-update-primary', 'begin'],
      ['world-update-primary', 'end'],
      ['draw-source', 'begin'],
      ['draw-source', 'end'],
      ['world-update-injected', 'begin'],
      ['world-update-injected', 'end'],
      ['renderer-draw', 'begin'],
      ['renderer-draw', 'end'],
      ['frame-total', 'end'],
    ];
    const isCompleteFrame = ordered.length === expectedOrder.length && ordered.every((marker, index) =>
      marker.phase === expectedOrder[index][0] && marker.boundary === expectedOrder[index][1]);
    const isPartialSampleEdge = !isCompleteFrame
      && (frameSeq === firstFrameSeq || frameSeq === lastFrameSeq);
    if (isPartialSampleEdge) {
      partialFrameCount += 1;
      continue;
    }

    const frameDurations = [];
    for (const phase of FRAME_PHASES) {
      const begin = byPhase.get(`${phase}:begin`);
      const end = byPhase.get(`${phase}:end`);
      if (!begin) addReason(`missingBegin:${frameSeq}:${phase}`);
      if (!end) addReason(`missingEnd:${frameSeq}:${phase}`);
      if (begin && end) {
        const elapsedMs = (end.ts - begin.ts) / 1000;
        if (elapsedMs < 0) addReason(`negativeDuration:${frameSeq}:${phase}`);
        else frameDurations.push([phase, elapsedMs]);
      }
    }
    for (const [phase, elapsedMs] of frameDurations) phaseDurations.get(phase).push(elapsedMs);
    if (isCompleteFrame) {
      completeFrameCount += 1;
    } else {
      addReason(`phaseOrder:${frameSeq}`);
    }

    const hasRequiredPhases = byPhase.has('world-update-primary:begin')
      && byPhase.has('world-update-primary:end')
      && byPhase.has('renderer-draw:begin')
      && byPhase.has('renderer-draw:end');
    if (hasRequiredPhases) requiredPhaseFrameCount += 1;

    const frameBegin = byPhase.get('frame-total:begin');
    const frameEnd = byPhase.get('frame-total:end');
    if (frameBegin && frameEnd && frameEnd.ts >= frameBegin.ts) {
      const frameTotalMs = (frameEnd.ts - frameBegin.ts) / 1000;
      const phaseSumMs = FRAME_PHASES
        .filter((phase) => phase !== 'frame-total')
        .map((phase) => {
          const begin = byPhase.get(`${phase}:begin`);
          const end = byPhase.get(`${phase}:end`);
          return begin && end && end.ts >= begin.ts ? (end.ts - begin.ts) / 1000 : 0;
        })
        .reduce((sum, value) => sum + value, 0);
      if (phaseSumMs > frameTotalMs + 1) addReason(`phaseSumExceedsFrameTotal:${frameSeq}`);
    }
  }

  const frameCount = frames.size;
  return {
    present: true,
    markerCount: markers.length,
    frameCount,
    partialFrameCount,
    sampledFrameCount: frameCount - partialFrameCount,
    completeFrameCount,
    requiredPhaseFrameCount,
    requiredPhaseCoverageRatio: frameCount === 0 ? 0 : Number((requiredPhaseFrameCount / frameCount).toFixed(3)),
    invalidReasons: [
      ...reasonSet,
      ...(overflowReasons > 0 ? [`...and ${overflowReasons} more phase errors`] : []),
    ],
    phases: Object.fromEntries([...phaseDurations.entries()].map(([phase, values]) => [phase, phaseDistribution(values)])),
  };
}

/** Pair the opt-in RenderSystem stage boundaries without treating them as a
 * root-cause claim. Incomplete edge samples are retained as partial evidence,
 * while complete samples provide the distributions used for attribution. */
function summarizeRenderPhases(events) {
  const markers = [];
  for (const [order, event] of events.entries()) {
    const match = eventName(event).match(RENDER_PHASE_MARK);
    if (!match || !eventCategory(event).includes('blink.user_timing')) continue;
    const ts = event?.ts;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
    markers.push({
      frameSeq: Number(match[1]),
      phase: match[2],
      boundary: match[3],
      skipReason: match[4] ?? null,
      ts,
      order,
    });
  }

  const empty = {
    present: false,
    markerCount: 0,
    frameCount: 0,
    partialFrameCount: 0,
    sampledFrameCount: 0,
    completeFrameCount: 0,
    completeFrameCoverageRatio: 0,
    invalidReasons: [],
    phases: Object.fromEntries(RENDER_PHASES.map((phase) => [phase, {
      ...phaseDistribution([]),
      skippedCount: 0,
      skipReasons: {},
    }])),
  };
  if (markers.length === 0) return empty;

  const reasonSet = new Set();
  let overflowReasons = 0;
  const addReason = (reason) => {
    if (reasonSet.size < 20) reasonSet.add(reason);
    else overflowReasons += 1;
  };
  const frames = new Map();
  for (const marker of markers) {
    const frame = frames.get(marker.frameSeq) ?? [];
    frame.push(marker);
    frames.set(marker.frameSeq, frame);
  }

  const phaseDurations = new Map(RENDER_PHASES.map((phase) => [phase, []]));
  const phaseSkips = new Map(RENDER_PHASES.map((phase) => [phase, []]));
  const frameSeqs = [...frames.keys()].sort((a, b) => a - b);
  const firstFrameSeq = frameSeqs[0];
  const lastFrameSeq = frameSeqs[frameSeqs.length - 1];
  let partialFrameCount = 0;
  let completeFrameCount = 0;
  for (const [frameSeq, frameMarkers] of [...frames.entries()].sort((a, b) => a[0] - b[0])) {
    const byPhase = new Map();
    for (const marker of frameMarkers) {
      const key = `${marker.phase}:${marker.boundary}`;
      if (byPhase.has(key)) addReason(`duplicate:${frameSeq}:${key}`);
      byPhase.set(key, marker);
    }
    const ordered = [...frameMarkers].sort((a, b) => a.ts - b.ts || a.order - b.order);
    const expectedOrder = RENDER_PHASES.flatMap((phase) =>
      byPhase.has(`${phase}:skip`)
        ? [[phase, 'skip']]
        : [[phase, 'begin'], [phase, 'end']],
    );
    const isCompleteFrame = ordered.length === expectedOrder.length && ordered.every((marker, index) =>
      marker.phase === expectedOrder[index][0] && marker.boundary === expectedOrder[index][1]);
    const isPartialSampleEdge = !isCompleteFrame
      && (frameSeq === firstFrameSeq || frameSeq === lastFrameSeq);
    if (isPartialSampleEdge) {
      partialFrameCount += 1;
      continue;
    }

    for (const phase of RENDER_PHASES) {
      const skip = byPhase.get(`${phase}:skip`);
      const begin = byPhase.get(`${phase}:begin`);
      const end = byPhase.get(`${phase}:end`);
      if (skip) {
        if (skip.skipReason === null) addReason(`missingSkipReason:${frameSeq}:${phase}`);
        if (begin || end) addReason(`skipConflict:${frameSeq}:${phase}`);
        phaseSkips.get(phase).push(skip.skipReason ?? 'unknown');
        continue;
      }
      if (!begin) addReason(`missingBegin:${frameSeq}:${phase}`);
      if (!end) addReason(`missingEnd:${frameSeq}:${phase}`);
      if (begin && end) {
        const elapsedMs = (end.ts - begin.ts) / 1000;
        if (elapsedMs < 0) addReason(`negativeDuration:${frameSeq}:${phase}`);
        else phaseDurations.get(phase).push(elapsedMs);
      }
    }
    if (isCompleteFrame) completeFrameCount += 1;
    else addReason(`phaseOrder:${frameSeq}`);
  }

  const frameCount = frames.size;
  return {
    present: true,
    markerCount: markers.length,
    frameCount,
    partialFrameCount,
    sampledFrameCount: frameCount - partialFrameCount,
    completeFrameCount,
    completeFrameCoverageRatio: frameCount === 0 ? 0 : Number((completeFrameCount / frameCount).toFixed(3)),
    invalidReasons: [
      ...reasonSet,
      ...(overflowReasons > 0 ? [`...and ${overflowReasons} more phase errors`] : []),
    ],
    phases: Object.fromEntries([...phaseDurations.entries()].map(([phase, values]) => {
      const skipReasons = new Map();
      for (const reason of phaseSkips.get(phase)) {
        skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
      }
      return [phase, {
        ...phaseDistribution(values),
        skippedCount: phaseSkips.get(phase).length,
        skipReasons: Object.fromEntries(skipReasons),
      }];
    })),
  };
}

export function validateEvidence({
  trace,
  traceDataLoss = false,
  matrix,
  postMatrix,
  headed = false,
  requestedDurationMs,
  consoleErrors = [],
  pageErrors = [],
  resourceRequests = [],
  requireFramePhases = false,
  requireRenderPhases = false,
}) {
  const invalidReasons = [];
  const diagnosticReasons = [];
  const dom = matrix?.dom;
  const frameCount = trace?.frame?.count ?? 0;
  const displayedFrameCount = trace?.render?.displayedFrame?.count ?? 0;
  const threadInventory = trace?.threadInventory;
  const actualDurationMs = trace?.windowMs ?? null;

  if (traceDataLoss) invalidReasons.push('traceDataLoss');
  if (dom?.visible !== 'visible') invalidReasons.push(`visibility:${dom?.visible ?? 'unknown'}`);
  if (dom?.focused !== true) invalidReasons.push('focused:false');
  if (consoleErrors.length > 0) invalidReasons.push(`consoleErrors:${consoleErrors.length}`);
  if (pageErrors.length > 0) invalidReasons.push(`pageErrors:${pageErrors.length}`);
  const requestLog = Array.isArray(resourceRequests)
    ? resourceRequests
    : resourceRequests > 0
      ? Array.from({ length: resourceRequests }, () => ({ category: 'blocking' }))
      : [];
  const blockingResourceRequests = requestLog.filter((request) => request.category !== 'background-control-plane');
  if (blockingResourceRequests.length > 0) {
    invalidReasons.push(`blockingResourceRequestsDuringSample:${blockingResourceRequests.length}`);
  }
  if (!threadInventory?.hasRendererProcess || !threadInventory?.hasRendererMain) invalidReasons.push('missingRendererThread');
  if (!threadInventory?.hasGpuProcess || !threadInventory?.hasGpuMain) invalidReasons.push('missingGpuThread');
  if (!threadInventory?.hasVizCompositor) invalidReasons.push('missingVizCompositorThread');
  if (frameCount < 50) invalidReasons.push(`applicationFrames:${frameCount}<50`);
  if (displayedFrameCount < 50) invalidReasons.push(`displayedFrames:${displayedFrameCount}<50`);
  if (trace?.evidence?.missingSignals?.length) {
    invalidReasons.push(`missingSignals:${trace.evidence.missingSignals.join(',')}`);
  }
  const framePhases = trace?.framePhases;
  if (requireFramePhases && !framePhases?.present) {
    invalidReasons.push('framePhases:missing');
  } else if (framePhases?.present) {
    for (const reason of framePhases.invalidReasons) invalidReasons.push(`framePhases:${reason}`);
    if (framePhases.requiredPhaseCoverageRatio < 0.95) {
      invalidReasons.push(`framePhases:coverage:${framePhases.requiredPhaseCoverageRatio}<0.95`);
    }
  }
  const renderPhases = trace?.renderPhases;
  if (requireRenderPhases && !renderPhases?.present) {
    invalidReasons.push('renderPhases:missing');
  } else if (renderPhases?.present) {
    for (const reason of renderPhases.invalidReasons) invalidReasons.push(`renderPhases:${reason}`);
    if (renderPhases.completeFrameCoverageRatio < 0.95) {
      invalidReasons.push(`renderPhases:coverage:${renderPhases.completeFrameCoverageRatio}<0.95`);
    }
  }
  if (actualDurationMs === null) {
    invalidReasons.push('traceWindow:missing');
  } else if (typeof requestedDurationMs === 'number') {
    const toleranceMs = Math.max(250, requestedDurationMs * 0.05);
    if (Math.abs(actualDurationMs - requestedDurationMs) > toleranceMs) {
      invalidReasons.push(`traceWindow:${actualDurationMs.toFixed(1)}ms±${toleranceMs.toFixed(1)}ms`);
    }
  }
  if (postMatrix && matrixFingerprint(matrix) !== matrixFingerprint(postMatrix)) {
    invalidReasons.push('matrixChangedDuringSample');
  }
  if (!headed) diagnosticReasons.push('headed:false');

  return {
    status: invalidReasons.length > 0 ? 'INVALID' : headed ? 'VALID' : 'DIAGNOSTIC_ONLY',
    invalidReasons,
    diagnosticReasons,
    requirements: {
      headed: true,
      visibleAndFocused: true,
      noTraceDataLoss: true,
      rendererGpuVizThreads: true,
      applicationFrames: 50,
      displayedFrames: 50,
      stableMatrix: true,
      noBlockingResourceRequests: true,
      framePhases: requireFramePhases,
      renderPhases: requireRenderPhases,
    },
    observed: {
      actualDurationMs,
      requestedDurationMs: requestedDurationMs ?? null,
      frameCount,
      displayedFrameCount,
      resourceRequests: requestLog.length,
      blockingResourceRequests: blockingResourceRequests.length,
      framePhases: framePhases ?? null,
      renderPhases: renderPhases ?? null,
    },
    note: invalidReasons.length > 0
        ? 'This sample is invalid for quantitative comparison; fix the listed evidence failures before using it for A/B attribution.'
        : headed
        ? 'This sample satisfies the headed quantitative evidence contract; background control-plane requests are recorded but do not invalidate it.'
        : 'This sample is diagnostic-only because it was collected headless.',
  };
}

export function summarizeTrace(traceInput, options = {}) {
  const allEvents = traceEvents(traceInput);
  const captureWindow = eventsInsideCaptureWindow(allEvents);
  const events = captureWindow.events;
  const applicationFrames = applicationFrameEvents(
    events,
    captureWindow.bounds !== null,
    options.applicationFrameId,
  );
  const fireAnimationFrame = coalesceAnimationFrameTicks(eventTimestamps(
    applicationFrames.events,
    () => true,
  ));
  const beginFrameArgsEvents = events.filter((event) => eventName(event) === 'BeginFrameArgs');
  const externalBeginFrameEvents = events.filter((event) => eventName(event) === 'ExternalBeginFrameSource::OnBeginFrame');
  const beginFrameEvents = [...beginFrameArgsEvents, ...externalBeginFrameEvents];
  const intervalUs = beginFrameArgsEvents.flatMap((event) => numericValues(event.args, new Set(['interval_us'])));
  const unthrottledIntervalUs = beginFrameArgsEvents.flatMap((event) => numericValues(event.args, new Set(['unthrottled_interval_us'])));

  const longTasks = events.filter((event) => {
    const name = eventName(event);
    return (name === 'RunTask' || name === 'Task' || name === 'LongTask') && durationMs(event) >= 50;
  });
  const gpuEvents = events.filter((event) => /gpu|webgpu/i.test(eventCategory(event)) || /webgpu/i.test(eventName(event)));
  const presentEvents = events.filter((event) => /Graphics\.Pipeline|SwapBuffers|Presentation|Present|FrameIntervalMatcherInputs/i.test(eventName(event)));
  const renderPipelineEvents = events.filter((event) => eventName(event) === 'Graphics.Pipeline');
  const displayedFrameEvents = events.filter((event) => eventName(event) === 'Display::FrameDisplayed');

  const missingSignals = [];
  if (fireAnimationFrame.length < 2 && renderPipelineEvents.length < 2 && displayedFrameEvents.length < 2) {
    missingSignals.push('FrameScheduling');
  }
  if (beginFrameEvents.length === 0) missingSignals.push('BeginFrame');
  if (gpuEvents.length === 0) missingSignals.push('GPU/WebGPU');
  if (presentEvents.length === 0) missingSignals.push('Present/Graphics.Pipeline');

  return {
    eventCount: events.filter((event) => event?.ph !== 'M').length,
    windowMs: traceWindowMs(events),
    threadInventory: traceThreadInventory(events),
    frame: {
      ...intervalSummary(fireAnimationFrame),
      owner: applicationFrames.owner,
    },
    beginFrame: {
      eventCount: beginFrameEvents.length,
      sources: {
        beginFrameArgs: beginFrameArgsEvents.length,
        externalBeginFrame: externalBeginFrameEvents.length,
      },
      intervalMs: intervalUs.length > 0 ? intervalUs.map((value) => value / 1000) : null,
      unthrottledIntervalMs: unthrottledIntervalUs.length > 0
        ? unthrottledIntervalUs.map((value) => value / 1000)
        : null,
      timestampIntervalsMs: intervalSummary(eventTimestamps(events, (event) =>
        eventName(event) === 'BeginFrameArgs' || eventName(event) === 'ExternalBeginFrameSource::OnBeginFrame')).intervals,
    },
    render: {
      pipeline: intervalSummary(eventTimestamps(events, (event) => eventName(event) === 'Graphics.Pipeline')),
      displayedFrame: {
        ...intervalSummary(eventTimestamps(events, (event) => eventName(event) === 'Display::FrameDisplayed')),
        slowestIntervals: slowestIntervals(events, (event) => eventName(event) === 'Display::FrameDisplayed'),
      },
    },
    longTasks: aggregateDuration(longTasks),
    gpu: aggregateDuration(gpuEvents),
    present: aggregateDuration(presentEvents),
    framePhases: summarizeFramePhases(events),
    renderPhases: summarizeRenderPhases(events),
    hotspots: {
      note: 'Hotspot durations are inclusive trace-event sums; nested events and tracks overlap, so they are not utilization or exclusive time.',
      rendererFunctionCalls: durationHotspots(
        events.filter((event) => eventName(event) === 'FunctionCall'),
        functionCallLabel,
        8,
        sourceLocation,
      ),
      gpuPresent: durationHotspots(
        events.filter((event) => /gpu|webgpu|Graphics\.Pipeline|SwapBuffers|Presentation|Present|FrameIntervalMatcherInputs/i.test(`${eventCategory(event)} ${eventName(event)}`)),
        eventName,
        12,
      ),
    },
    evidence: {
      complete: missingSignals.length === 0,
      missingSignals,
      note: missingSignals.length === 0
        ? 'Trace contains the requested frame, compositor, GPU, and present signals.'
        : 'Missing signals make this trace diagnostic-only; do not infer the absent layer.',
    },
  };
}

function nextCdpEvent(client, name) {
  return new Promise((resolve) => {
    const handler = (payload) => {
      client.off(name, handler);
      resolve(payload);
    };
    client.on(name, handler);
  });
}

export async function readTraceStream(client, stream, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_TRACE_BYTES;
  let text = '';
  for (let i = 0; i < 1024; i += 1) {
    const chunk = await withTimeout(client.send('IO.read', { handle: stream }), timeoutMs, 'IO.read');
    text += chunk.data ?? '';
    if (text.length > maxBytes) throw new Error(`trace exceeded ${maxBytes} bytes`);
    if (chunk.eof) return text;
    if (!chunk.data) throw new Error('trace stream returned an empty non-terminal chunk');
  }
  throw new Error('trace stream exceeded the 1024-chunk safety bound');
}

async function captureTrace(client, page, durationMs, maxBytes, categories) {
  const completed = nextCdpEvent(client, 'Tracing.tracingComplete');
  const startedAt = performance.now();
  await withTimeout(client.send('Tracing.start', {
    categories,
    options: 'record-as-much-as-is',
    transferMode: 'ReturnAsStream',
  }), TRACE_START_TIMEOUT_MS, 'Tracing.start');
  const tracingStartMs = performance.now() - startedAt;
  await page.evaluate(() => {
    performance.clearMarks('forgeax.capture.window.begin');
    performance.clearMarks('forgeax.capture.window.end');
    performance.mark('forgeax.capture.window.begin');
  });
  await page.waitForTimeout(durationMs);
  await page.evaluate(() => performance.mark('forgeax.capture.window.end'));
  const endingAt = performance.now();
  await withTimeout(client.send('Tracing.end'), TRACE_END_TIMEOUT_MS, 'Tracing.end');
  const tracingEndMs = performance.now() - endingAt;
  const completionAt = performance.now();
  const result = await withTimeout(completed, TRACE_COMPLETE_TIMEOUT_MS, 'Tracing.tracingComplete');
  const tracingCompleteMs = performance.now() - completionAt;
  const text = await readTraceStream(client, result.stream, { maxBytes });
  await client.send('IO.close', { handle: result.stream }).catch(() => {});
  return {
    text,
    dataLossOccurred: result.dataLossOccurred === true,
    timingsMs: { tracingStartMs, tracingEndMs, tracingCompleteMs },
  };
}

export async function gatewayEval(page, snippet) {
  return page.evaluate(async (code) => {
    const channel = globalThis.__forgeaxEval;
    if (!channel) return { ok: false, error: { code: 'GATEWAY_UNAVAILABLE', hint: '__forgeaxEval is not mounted' } };
    const result = channel.eval(code);
    if (result?.ok && result.value && typeof result.value.then === 'function') {
      return { ok: true, value: await result.value };
    }
    return result;
  }, snippet);
}

export async function waitForPlay(page) {
  let last;
  for (let i = 0; i < 120; i += 1) {
    last = await gatewayEval(page, '({phase:gateway.playPhase,error:gateway.lastPlayError})');
    if (last?.ok && (last.value?.phase === 'play' || last.value?.phase === 'failed')) return last;
    await page.waitForTimeout(100);
  }
  throw new Error(`play did not reach a terminal phase: ${JSON.stringify(last)}`);
}

async function pageMatrix(page, surface) {
  const state = await gatewayEval(page, "(async()=>{const t=query({with:['Transform']});const m=query({with:['MeshRenderer']});const r=await gateway.readGameState('rendererStats');return {phase:gateway.playPhase,mode:gateway.mode,transformRows:t.ok?t.rows.length:null,meshRows:m.ok?m.rows.length:null,rendererStats:r.ok?r.value:null}})()");
  const dom = await page.evaluate(() => ({
    visible: document.visibilityState,
    focused: document.hasFocus(),
    dpr: devicePixelRatio,
    innerWidth,
    innerHeight,
    canvases: [...document.querySelectorAll('canvas')].map((canvas) => ({
      width: canvas.width,
      height: canvas.height,
      cssWidth: canvas.clientWidth,
      cssHeight: canvas.clientHeight,
    })),
  }));
  return { surface, state, dom };
}

async function waitForStableMatrix(page, surface, options = {}) {
  const stableForMs = options.stableForMs ?? 2000;
  const maxWaitMs = options.maxWaitMs ?? 30000;
  const startedAt = performance.now();
  let matrix = await pageMatrix(page, surface);
  let stableSince = performance.now();
  for (;;) {
    await page.waitForTimeout(250);
    const next = await pageMatrix(page, surface);
    const ready = next.state?.ok === true && typeof next.state.value?.phase === 'string';
    if (!ready || matrixFingerprint(matrix) !== matrixFingerprint(next)) {
      matrix = next;
      stableSince = performance.now();
    } else if (performance.now() - stableSince >= stableForMs) {
      return {
        matrix,
        waitedMs: performance.now() - startedAt,
        stableForMs: performance.now() - stableSince,
      };
    }
    if (performance.now() - startedAt > maxWaitMs) {
      throw new Error(`matrix did not stabilize for ${surface} within ${maxWaitMs}ms`);
    }
  }
}

function parseNumber(value, fallback, label) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number`);
  return parsed;
}

export function parseEditCameraJson(value) {
  if (value === undefined) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('--edit-camera-json must be valid JSON');
  }
  const vector = (candidate) =>
    Array.isArray(candidate) &&
    candidate.length === 3 &&
    candidate.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
  if (!parsed || typeof parsed !== 'object' || !vector(parsed.pos) || !vector(parsed.lookAt)) {
    throw new Error('--edit-camera-json must be {"pos":[x,y,z],"lookAt":[x,y,z]} with finite numbers');
  }
  return {
    pos: [...parsed.pos],
    lookAt: [...parsed.lookAt],
  };
}

export function parseCli(argv) {
  const flags = {
    url: DEFAULT_URL,
    duration: DEFAULT_DURATION_MS,
    warmup: 0,
    benchmark: false,
    surface: 'all',
    headed: false,
    deepGpu: false,
    nested: false,
    passes: false,
    detail: 'owner',
    width: 1280,
    height: 720,
    diagnostics: true,
    editCamera: undefined,
    playClickText: undefined,
    playReadySelector: undefined,
    playBlockingSelector: undefined,
    out: undefined,
    maxTraceMb: 128,
  };
  let durationProvided = false;
  let warmupProvided = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--benchmark') flags.benchmark = true;
    else if (arg === '--headed') flags.headed = true;
    else if (arg === '--deep-gpu') flags.deepGpu = true;
    else if (arg === '--nested') {
      flags.nested = true;
      flags.detail = 'nested';
    }
    else if (arg === '--passes') {
      flags.passes = true;
      flags.detail = 'passes';
    }
    else if (arg === '--no-diagnostics') flags.diagnostics = false;
    else if (arg === '--url') flags.url = argv[++i];
    else if (arg === '--duration') {
      flags.duration = parseNumber(argv[++i], DEFAULT_DURATION_MS, '--duration');
      durationProvided = true;
    }
    else if (arg === '--warmup') {
      flags.warmup = parseNumber(argv[++i], 0, '--warmup');
      warmupProvided = true;
    }
    else if (arg === '--surface') flags.surface = argv[++i];
    else if (arg === '--width') flags.width = parseNumber(argv[++i], 1280, '--width');
    else if (arg === '--height') flags.height = parseNumber(argv[++i], 720, '--height');
    else if (arg === '--edit-camera-json') flags.editCamera = parseEditCameraJson(argv[++i]);
    else if (arg === '--play-click-text') flags.playClickText = argv[++i];
    else if (arg === '--play-ready-selector') flags.playReadySelector = argv[++i];
    else if (arg === '--play-blocking-selector') flags.playBlockingSelector = argv[++i];
    else if (arg === '--out') flags.out = argv[++i];
    else if (arg === '--max-trace-mb') flags.maxTraceMb = parseNumber(argv[++i], 128, '--max-trace-mb');
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: bun scripts/chrome-performance.mjs [--benchmark] [--headed] [--passes|--nested] [--no-diagnostics] [--deep-gpu] [--surface all|edit|play-scene|play-game] [--width px] [--height px] [--edit-camera-json json] [--play-click-text text] [--play-ready-selector css] [--play-blocking-selector css] [--warmup ms] [--duration ms] [--url url] [--out dir] [--max-trace-mb mb]');
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!SURFACES.includes(flags.surface) && flags.surface !== 'all') throw new Error(`--surface must be all or one of ${SURFACES.join(', ')}`);
  if (flags.passes && flags.nested) throw new Error('--passes and --nested are mutually exclusive');
  if (flags.benchmark) {
    if (!durationProvided) flags.duration = DEFAULT_BENCHMARK_DURATION_MS;
    if (!warmupProvided) flags.warmup = DEFAULT_BENCHMARK_WARMUP_MS;
    if (flags.warmup < DEFAULT_BENCHMARK_WARMUP_MS) {
      throw new Error(`--benchmark requires --warmup >= ${DEFAULT_BENCHMARK_WARMUP_MS}ms`);
    }
    if (flags.duration < DEFAULT_BENCHMARK_DURATION_MS) {
      throw new Error(`--benchmark requires --duration >= ${DEFAULT_BENCHMARK_DURATION_MS}ms`);
    }
  }
  return flags;
}

async function clickVisibleTextInAnyFrame(page, label) {
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    for (const frame of page.frames()) {
      const target = frame.getByText(label, { exact: true }).first();
      if (await target.isVisible().catch(() => false)) {
        await target.click();
        return;
      }
    }
    await page.waitForTimeout(50);
  }
  throw new Error(`visible Play action not found: ${JSON.stringify(label)}`);
}

async function waitForSelectorAcrossFrames(page, selector, visible) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const states = await Promise.all(page.frames().map((frame) =>
      frame.locator(selector).first().isVisible().catch(() => false),
    ));
    if (states.some(Boolean) === visible) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`Play selector ${JSON.stringify(selector)} did not become ${visible ? 'visible' : 'hidden'}`);
}

async function applicationFrameIdForSurface(client, surface) {
  const { frameTree } = await client.send('Page.getFrameTree');
  const rows = [];
  const visit = (node) => {
    rows.push({ id: node.frame.id, url: node.frame.url });
    for (const child of node.childFrames ?? []) visit(child);
  };
  visit(frameTree);
  const candidates = rows.filter((row) => {
    try {
      const path = new URL(row.url).pathname;
      return surface === 'edit' ? path.startsWith('/editor/') : path.startsWith('/preview/');
    } catch {
      return false;
    }
  });
  if (candidates.length !== 1) {
    throw new Error(`expected one Chrome frame for ${surface}, found ${JSON.stringify(candidates)}`);
  }
  return candidates[0].id;
}

async function main() {
  const flags = parseCli(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = flags.out ?? join('/tmp/forgeax-chrome-performance', stamp);
  await mkdir(outDir, { recursive: true });
  const traceCategories = [...BASE_TRACE_CATEGORIES, ...(flags.deepGpu ? [DEEP_GPU_TRACE_CATEGORY] : [])].join(',');
  const browserModule = process.env.FORGEAX_PLAYWRIGHT
    ? await import(process.env.FORGEAX_PLAYWRIGHT)
    : { chromium: defaultChromium };
  const chromium = browserModule.chromium ?? browserModule.default?.chromium;
  if (!chromium) throw new Error('Playwright chromium export is unavailable');
  const browser = await chromium.launch({
    headless: !flags.headed,
    ...(process.env.FORGEAX_CHROMIUM ? { executablePath: process.env.FORGEAX_CHROMIUM } : {}),
    args: [
      '--use-angle=metal',
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,WebGPU',
      '--ignore-gpu-blocklist',
      `--window-size=${flags.width},${flags.height}`,
    ],
  });
  const consoleErrors = [];
  let context;
  let client;
  try {
    context = await browser.newContext({
      viewport: { width: flags.width, height: flags.height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    if (flags.diagnostics) {
      await page.addInitScript(({ detail }) => {
        globalThis.__forgeaxFramePhaseDiagnostics = {
          enabled: true,
          detail,
        };
      }, { detail: flags.detail });
    }
    const pageErrors = [];
    let activeSample = null;
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
        activeSample?.consoleErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => {
      pageErrors.push(String(error));
      activeSample?.pageErrors.push(String(error));
    });
    page.on('request', (request) => {
      if (activeSample) activeSample.resourceRequests.push(classifyResourceRequest(request));
    });
    await page.goto(flags.url, { waitUntil: 'domcontentloaded' });
    if (flags.headed) await page.bringToFront();
    await page.waitForFunction(() => !!globalThis.__forgeaxEval, { timeout: 30000 });
    await page.waitForTimeout(5000);
    client = await context.newCDPSession(page);
    const surfaces = flags.surface === 'all' ? SURFACES : [flags.surface];
    const results = [];

    for (const surface of surfaces) {
      if (surface === 'edit') {
        const state = await gatewayEval(page, "gateway.playPhase === 'edit' ? {ok:true} : gateway.dispatch({kind:'stop'},'ai')");
        if (!state?.ok) throw new Error(`cannot enter edit: ${JSON.stringify(state)}`);
        if (flags.editCamera !== undefined) {
          const cameraResult = await gatewayEval(
            page,
            `gateway.dispatch(${JSON.stringify({ kind: 'cameraLookAt', ...flags.editCamera })},'ai')`,
          );
          if (!cameraResult?.ok) {
            throw new Error(`edit camera dispatch failed: ${JSON.stringify(cameraResult)}`);
          }
        }
      } else {
        const accepted = await gatewayEval(page, "gateway.playPhase === 'play' ? {ok:true} : gateway.dispatch({kind:'play',dirtyPolicy:'last-saved'},'ai')");
        if (!accepted?.ok) throw new Error(`play dispatch failed: ${JSON.stringify(accepted)}`);
        const lifecycle = await waitForPlay(page);
        if (lifecycle.value?.phase === 'failed') throw new Error(`play failed: ${JSON.stringify(lifecycle.value.error)}`);
        const display = surface === 'play-game' ? 'game' : 'scene';
        const displayResult = await gatewayEval(page, `gateway.dispatch({kind:'setDisplay',display:'${display}'},'ai')`);
        if (!displayResult?.ok) throw new Error(`display dispatch failed: ${JSON.stringify(displayResult)}`);
        if (surface === 'play-game') {
          if (flags.playClickText !== undefined) {
            await clickVisibleTextInAnyFrame(page, flags.playClickText);
          }
          if (flags.playBlockingSelector !== undefined) {
            await waitForSelectorAcrossFrames(page, flags.playBlockingSelector, true);
          }
          if (flags.playReadySelector !== undefined) {
            await waitForSelectorAcrossFrames(page, flags.playReadySelector, true);
          }
          if (flags.playBlockingSelector !== undefined) {
            await waitForSelectorAcrossFrames(page, flags.playBlockingSelector, false);
          }
        }
      }

      await page.waitForTimeout(1000);
      const preparation = await waitForStableMatrix(page, surface);
      const warmupStartedAt = performance.now();
      if (flags.warmup > 0) await page.waitForTimeout(flags.warmup);
      const warmupObservedMs = performance.now() - warmupStartedAt;
      const matrix = preparation.matrix;
      const sample = { consoleErrors: [], pageErrors: [], resourceRequests: [] };
      activeSample = sample;
      const applicationFrameId = await applicationFrameIdForSurface(client, surface);
      const traceResult = await captureTrace(client, page, flags.duration, flags.maxTraceMb * 1024 * 1024, traceCategories);
      activeSample = null;
      const postMatrix = await pageMatrix(page, surface);
      const tracePath = join(outDir, `${surface}.trace.json`);
      const summaryPath = join(outDir, `${surface}.summary.json`);
      const trace = summarizeTrace(parseTraceText(traceResult.text), { applicationFrameId });
      const evidence = validateEvidence({
        trace,
        traceDataLoss: traceResult.dataLossOccurred,
        matrix,
        postMatrix,
        headed: flags.headed,
        requestedDurationMs: flags.duration,
        consoleErrors: sample.consoleErrors,
        pageErrors: sample.pageErrors,
        resourceRequests: sample.resourceRequests,
        requireFramePhases: flags.diagnostics,
        requireRenderPhases: flags.diagnostics,
      });
      const summary = {
        surface,
        matrix: {
          ...matrix,
          browserVersion: browser.version(),
          url: page.url(),
          headed: flags.headed,
          diagnostics: flags.diagnostics,
          detail: flags.detail,
          traceCategories,
          traceDataLoss: traceResult.dataLossOccurred,
          traceTimingsMs: traceResult.timingsMs,
          applicationFrameId,
          preparation,
          warmupRequestedMs: flags.warmup,
          warmupObservedMs,
          editCamera: surface === 'edit' ? flags.editCamera : undefined,
        },
        postMatrix,
        requests: sample.resourceRequests,
        trace,
        evidence,
        tracePath,
      };
      await writeFile(tracePath, traceResult.text);
      await writeFile(summaryPath, JSON.stringify(summary, null, 2));
      results.push({ surface, summaryPath, tracePath, evidence, summary: summary.trace });
    }

    const manifest = {
      generatedAt: new Date().toISOString(),
      url: flags.url,
      benchmark: flags.benchmark,
      warmupMs: flags.warmup,
      durationMs: flags.duration,
      headed: flags.headed,
      diagnostics: flags.diagnostics,
      detail: flags.detail,
      editCamera: flags.editCamera,
      traceCategories,
      browserVersion: browser.version(),
      editorCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      consoleErrors: [...new Set(consoleErrors)],
      pageErrors: [...new Set(pageErrors)],
      results,
      evidencePolicy: flags.headed
        ? 'visible trace requested; verify matrix.visible/focused before root-cause claims'
        : 'headless diagnostic-only; do not claim compositor or Present root cause from this run',
    };
    await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify(manifest, null, 2));
  } finally {
    if (client) {
      await withTimeout(client.detach(), CDP_DETACH_TIMEOUT_MS, 'CDP detach').catch((error) => {
        console.error(`[chrome-performance] ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    if (context) {
      await withTimeout(context.close(), CONTEXT_CLOSE_TIMEOUT_MS, 'browser context close').catch((error) => {
        console.error(`[chrome-performance] ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    try {
      await withTimeout(browser.close(), BROWSER_CLOSE_TIMEOUT_MS, 'browser.close');
    } catch (error) {
      console.error(`[chrome-performance] ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`[chrome-performance] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
