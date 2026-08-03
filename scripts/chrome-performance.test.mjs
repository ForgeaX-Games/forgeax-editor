import { describe, expect, test } from 'bun:test';
import { classifyResourceRequest, normalizeTraceUrl, parseCli, parseTraceText, percentile, readTraceStream, summarizeTrace, validateEvidence, withTimeout } from './chrome-performance.mjs';

describe('chrome performance trace summary', () => {
  test('uses a fixed 20s warmup and measurement contract in benchmark mode', () => {
    expect(parseCli(['--benchmark'])).toMatchObject({
      benchmark: true,
      warmup: 20000,
      duration: 20000,
    });
    expect(() => parseCli(['--benchmark', '--warmup', '19999'])).toThrow('warmup >= 20000ms');
    expect(() => parseCli(['--benchmark', '--duration', '19999'])).toThrow('duration >= 20000ms');
  });

  test('extracts frame pacing, target interval, long tasks, GPU, and present signals', () => {
    const trace = {
      traceEvents: [
        { name: 'FireAnimationFrame', ts: 0 },
        { name: 'FireAnimationFrame', ts: 16667 },
        { name: 'FireAnimationFrame', ts: 33334 },
        { name: 'BeginFrameArgs', ts: 0, args: { interval_us: 8333, unthrottled_interval_us: 8333 } },
        { name: 'RunTask', ts: 0, dur: 60000, cat: 'devtools.timeline' },
        { name: 'WebGPUCommand', ts: 0, dur: 5000, cat: 'gpu' },
        { name: 'Graphics.Pipeline', ts: 0, dur: 2000, cat: 'viz' },
      ],
    };
    const summary = summarizeTrace(trace);
    expect(summary.frame.intervals?.p50Ms).toBeCloseTo(16.667, 3);
    expect(summary.beginFrame.intervalMs).toEqual([8.333]);
    expect(summary.beginFrame.unthrottledIntervalMs).toEqual([8.333]);
    expect(summary.longTasks).toEqual({ count: 1, totalMs: 60, maxMs: 60 });
    expect(summary.gpu).toEqual({ count: 1, totalMs: 5, maxMs: 5 });
    expect(summary.present).toEqual({ count: 1, totalMs: 2, maxMs: 2 });
    expect(summary.evidence.complete).toBe(true);
  });

  test('surfaces inclusive renderer and GPU hotspots without calling them utilization', () => {
    const summary = summarizeTrace([
      { name: 'FunctionCall', ts: 0, dur: 4000, args: { data: { functionName: 'tick' } } },
      { name: 'FunctionCall', ts: 5000, dur: 6000, args: { data: { functionName: 'tick' } } },
      { name: 'Graphics.Pipeline', ts: 0, dur: 2000, cat: 'viz' },
      { name: 'Graphics.Pipeline', ts: 5000, dur: 3000, cat: 'viz' },
      { name: 'WebGPU', ts: 0, dur: 7000, cat: 'gpu' },
    ]);

    expect(summary.hotspots.rendererFunctionCalls[0]).toEqual({
      name: 'tick',
      count: 2,
      totalMs: 10,
      maxMs: 6,
      p50Ms: 6,
      p95Ms: 6,
      overBudget: { '16.7ms': 0, '33.3ms': 0, '50ms': 0 },
    });
    expect(summary.hotspots.gpuPresent[0]).toEqual({
      name: 'WebGPU',
      count: 1,
      totalMs: 7,
      maxMs: 7,
      p50Ms: 7,
      p95Ms: 7,
      overBudget: { '16.7ms': 0, '33.3ms': 0, '50ms': 0 },
    });
    expect(summary.hotspots.note).toContain('inclusive');
  });

  test('keeps bounded source locations for application hotspots', () => {
    const summary = summarizeTrace([
      {
        name: 'FunctionCall',
        ts: 0,
        dur: 12000,
        args: {
          data: {
            functionName: 'tick',
            url: 'http://localhost:15290/@fs/packages/engine/app/dist/index.mjs',
            lineNumber: 364,
            columnNumber: 16,
          },
        },
      },
    ]);

    expect(summary.hotspots.rendererFunctionCalls[0]?.sources).toEqual([
      {
        url: 'packages/engine/app/dist/index.mjs',
        lineNumber: 364,
        columnNumber: 16,
      },
    ]);
  });

  test('splits same-named callbacks by normalized callsite and counts frame budgets', () => {
    const summary = summarizeTrace([
      {
        name: 'FunctionCall',
        ts: 0,
        dur: 17000,
        pid: 1,
        tid: 2,
        args: { data: { functionName: 'tick', url: 'http://localhost:15290/@fs/Users/you/projects/ForgeaX-Games/forgeax-editor/.worktrees/performance-diagnostics/packages/engine/packages/app/dist/index.mjs?x=1', lineNumber: 364, columnNumber: 16 } },
      },
      {
        name: 'FunctionCall',
        ts: 20000,
        dur: 51000,
        pid: 1,
        tid: 2,
        args: { data: { functionName: 'tick', url: 'http://127.0.0.1:9999/@fs/Users/you/projects/ForgeaX-Games/forgeax-editor/packages/interface/src/lib/surface.ts', lineNumber: 134, columnNumber: 16 } },
      },
    ]);

    expect(summary.hotspots.rendererFunctionCalls).toEqual([
      {
        name: 'tick',
        count: 1,
        totalMs: 51,
        maxMs: 51,
        p50Ms: 51,
        p95Ms: 51,
        overBudget: { '16.7ms': 1, '33.3ms': 1, '50ms': 1 },
        sources: [{ url: 'packages/interface/src/lib/surface.ts', lineNumber: 134, columnNumber: 16 }],
      },
      {
        name: 'tick',
        count: 1,
        totalMs: 17,
        maxMs: 17,
        p50Ms: 17,
        p95Ms: 17,
        overBudget: { '16.7ms': 1, '33.3ms': 0, '50ms': 0 },
        sources: [{ url: 'packages/engine/packages/app/dist/index.mjs', lineNumber: 364, columnNumber: 16 }],
      },
    ]);
    expect(normalizeTraceUrl('http://localhost:15290/@fs/Users/you/projects/ForgeaX-Games/forgeax-editor/.worktrees/demo/packages/core/src/index.ts?x=1#hash')).toBe('packages/core/src/index.ts');
  });

  test('uses the same callsite identity inside slowest frame-gap hotspots', () => {
    const summary = summarizeTrace([
      { name: 'Display::FrameDisplayed', ts: 0, pid: 9, tid: 90 },
      {
        name: 'FunctionCall',
        ts: 1000,
        dur: 20000,
        pid: 1,
        tid: 2,
        args: { data: { functionName: 'tick', url: 'http://localhost:15290/@fs/Users/you/projects/ForgeaX-Games/forgeax-editor/packages/engine/packages/app/dist/index.mjs', lineNumber: 364, columnNumber: 16 } },
      },
      {
        name: 'FunctionCall',
        ts: 30000,
        dur: 30000,
        pid: 1,
        tid: 2,
        args: { data: { functionName: 'tick', url: 'http://localhost:15290/@fs/Users/you/projects/ForgeaX-Games/forgeax-editor/packages/interface/src/lib/surface.ts', lineNumber: 134, columnNumber: 16 } },
      },
      { name: 'Display::FrameDisplayed', ts: 100000, pid: 9, tid: 90 },
    ]);

    const functionCalls = summary.render.displayedFrame.slowestIntervals[0]?.hotspots.filter((event) => event.name === 'FunctionCall');
    expect(functionCalls?.map((event) => event.sources?.[0]?.url)).toEqual([
      'packages/interface/src/lib/surface.ts',
      'packages/engine/packages/app/dist/index.mjs',
    ]);
  });

  test('pairs engine frame phases and reports bounded wall-time distributions', () => {
    const phaseNames = ['frame-total', 'world-update-primary', 'draw-source', 'world-update-injected', 'renderer-draw'];
    const phaseTrace = (frameSeq, startUs, omit = null) => phaseNames.flatMap((phase, phaseIndex) => {
      const phaseStartUs = phase === 'frame-total' ? startUs : startUs + phaseIndex * 200;
      const phaseEndUs = phase === 'frame-total' ? startUs + 1200 : phaseStartUs + 100;
      return [
        { name: `forgeax.frame.phase.${frameSeq}.${phase}.begin`, cat: 'blink.user_timing', ph: 'I', ts: phaseStartUs },
        ...(omit === `${phase}:end`
          ? []
          : [{ name: `forgeax.frame.phase.${frameSeq}.${phase}.end`, cat: 'blink.user_timing', ph: 'I', ts: phaseEndUs }]),
      ];
    });
    const summary = summarizeTrace([
      ...phaseTrace(1, 0),
      ...phaseTrace(2, 2000, 'renderer-draw:end'),
      ...phaseTrace(3, 4000),
    ]);

    expect(summary.framePhases.present).toBe(true);
    expect(summary.framePhases.frameCount).toBe(3);
    expect(summary.framePhases.completeFrameCount).toBe(2);
    expect(summary.framePhases.requiredPhaseCoverageRatio).toBe(0.667);
    expect(summary.framePhases.phases['world-update-primary']).toEqual({
      count: 3,
      p50Ms: 0.1,
      p95Ms: 0.1,
      maxMs: 0.1,
    });
    expect(summary.framePhases.invalidReasons).toContain('missingEnd:2:renderer-draw');
  });

  test('requires frame phase evidence when the real browser harness opts in', () => {
    const summary = summarizeTrace([]);
    const evidence = validateEvidence({ trace: summary, requireFramePhases: true });
    expect(evidence.status).toBe('INVALID');
    expect(evidence.invalidReasons).toContain('framePhases:missing');
  });

  test('pairs renderer stage phases independently from app frame phases', () => {
    const phases = ['extract', 'bind-groups', 'features', 'sort', 'record'];
    const renderTrace = (frameSeq, startUs) => phases.flatMap((phase, index) => {
      const phaseStartUs = startUs + index * 200;
      return [
        { name: `forgeax.render.phase.${frameSeq}.${phase}.begin`, cat: 'blink.user_timing', ph: 'I', ts: phaseStartUs },
        { name: `forgeax.render.phase.${frameSeq}.${phase}.end`, cat: 'blink.user_timing', ph: 'I', ts: phaseStartUs + 100 },
      ];
    });
    const summary = summarizeTrace([
      ...renderTrace(1, 0),
      ...renderTrace(2, 2000),
    ]);

    expect(summary.renderPhases.present).toBe(true);
    expect(summary.renderPhases.frameCount).toBe(2);
    expect(summary.renderPhases.completeFrameCount).toBe(2);
    expect(summary.renderPhases.phases.record).toEqual({
      count: 2,
      p50Ms: 0.1,
      p95Ms: 0.1,
      maxMs: 0.1,
      skippedCount: 0,
      skipReasons: {},
    });
  });

  test('accepts an engine-declared skipped renderer phase with a reason', () => {
    const phases = ['extract', 'features', 'sort', 'record'];
    const renderTrace = (frameSeq, startUs) => [
      ...phases.flatMap((phase, index) => {
        const phaseStartUs = startUs + index * 200;
        return [
          { name: `forgeax.render.phase.${frameSeq}.${phase}.begin`, cat: 'blink.user_timing', ph: 'I', ts: phaseStartUs },
          { name: `forgeax.render.phase.${frameSeq}.${phase}.end`, cat: 'blink.user_timing', ph: 'I', ts: phaseStartUs + 100 },
        ];
      }).slice(0, 2),
      { name: `forgeax.render.phase.${frameSeq}.bind-groups.skip.feature-host-empty`, cat: 'blink.user_timing', ph: 'I', ts: startUs + 400 },
      ...phases.slice(1).flatMap((phase, index) => {
        const phaseStartUs = startUs + 600 + index * 200;
        return [
          { name: `forgeax.render.phase.${frameSeq}.${phase}.begin`, cat: 'blink.user_timing', ph: 'I', ts: phaseStartUs },
          { name: `forgeax.render.phase.${frameSeq}.${phase}.end`, cat: 'blink.user_timing', ph: 'I', ts: phaseStartUs + 100 },
        ];
      }),
    ];
    const summary = summarizeTrace(renderTrace(1, 0));

    expect(summary.renderPhases.completeFrameCount).toBe(1);
    expect(summary.renderPhases.invalidReasons).toEqual([]);
    expect(summary.renderPhases.phases['bind-groups']).toEqual({
      count: 0,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
      skippedCount: 1,
      skipReasons: { 'feature-host-empty': 1 },
    });
  });

  test('reports missing layers instead of inventing a root cause', () => {
    const summary = summarizeTrace([{ name: 'FireAnimationFrame', ts: 0 }, { name: 'FireAnimationFrame', ts: 10000 }]);
    expect(summary.evidence.complete).toBe(false);
    expect(summary.evidence.missingSignals).toEqual(['BeginFrame', 'GPU/WebGPU', 'Present/Graphics.Pipeline']);
  });

  test('accepts renderer-side frame signals when the host has no FireAnimationFrame events', () => {
    const trace = [
      { name: 'ExternalBeginFrameSource::OnBeginFrame', ts: 0 },
      { name: 'ExternalBeginFrameSource::OnBeginFrame', ts: 16667 },
      { name: 'Graphics.Pipeline', ts: 0, dur: 2000, cat: 'viz' },
      { name: 'Graphics.Pipeline', ts: 16667, dur: 2000, cat: 'viz' },
      { name: 'Display::FrameDisplayed', ts: 16667, dur: 1000, cat: 'viz' },
      { name: 'WebGPUCommand', ts: 0, dur: 5000, cat: 'gpu' },
    ];
    const summary = summarizeTrace(trace);
    expect(summary.frame.count).toBe(0);
    expect(summary.render.pipeline.intervals?.p50Ms).toBeCloseTo(16.667, 3);
    expect(summary.beginFrame.sources.externalBeginFrame).toBe(2);
    expect(summary.evidence.complete).toBe(true);
  });

  test('locates the bounded trace coordinates of the slowest displayed-frame gaps', () => {
    const summary = summarizeTrace([
      { name: 'Display::FrameDisplayed', ts: 1000, pid: 7, tid: 70 },
      { name: 'Display::FrameDisplayed', ts: 11000, pid: 7, tid: 70 },
      { name: 'Display::FrameDisplayed', ts: 211000, pid: 8, tid: 80 },
      { name: 'Display::FrameDisplayed', ts: 221000, pid: 8, tid: 80 },
    ]);
    expect(summary.render.displayedFrame.slowestIntervals).toEqual([
      {
        intervalMs: 200,
        startUs: 11000,
        endUs: 211000,
        start: { pid: 7, tid: 70 },
        end: { pid: 8, tid: 80 },
        hotspots: [],
      },
      {
        intervalMs: 10,
        startUs: 1000,
        endUs: 11000,
        start: { pid: 7, tid: 70 },
        end: { pid: 7, tid: 70 },
        hotspots: [],
      },
      {
        intervalMs: 10,
        startUs: 211000,
        endUs: 221000,
        start: { pid: 8, tid: 80 },
        end: { pid: 8, tid: 80 },
        hotspots: [],
      },
    ]);
  });

  test('parses Chrome object and array trace forms', () => {
    expect(parseTraceText('{"traceEvents":[{"name":"x"}]}')).toHaveLength(1);
    expect(parseTraceText('[{"name":"x"}]')).toHaveLength(1);
  });

  test('marks a headed sample valid only when the full evidence contract is present', () => {
    const traceEvents = [
      { name: 'process_name', ph: 'M', pid: 1, args: { name: 'Renderer' } },
      { name: 'process_name', ph: 'M', pid: 2, args: { name: 'GPU Process' } },
      { name: 'thread_name', ph: 'M', tid: 11, args: { name: 'CrRendererMain' } },
      { name: 'thread_name', ph: 'M', tid: 12, args: { name: 'CrGpuMain' } },
      { name: 'thread_name', ph: 'M', tid: 13, args: { name: 'VizCompositorThread' } },
      { name: 'BeginFrameArgs', ts: 0 },
      { name: 'WebGPUCommand', ts: 0, dur: 1000, cat: 'gpu' },
      { name: 'Graphics.Pipeline', ts: 0, dur: 1000, cat: 'viz' },
      ...Array.from({ length: 50 }, (_, index) => ({
        name: 'FireAnimationFrame',
        ts: index * 16000,
        pid: 1,
        tid: 11,
      })),
      ...Array.from({ length: 50 }, (_, index) => ({
        name: 'Display::FrameDisplayed',
        ts: index * 16000,
        pid: 2,
        tid: 13,
      })),
    ];
    const trace = summarizeTrace(traceEvents);
    const matrix = {
      state: { ok: true, value: { phase: 'edit', mode: 'edit', transformRows: 1, meshRows: 1, rendererStats: null } },
      dom: {
        visible: 'visible',
        focused: true,
        dpr: 1,
        innerWidth: 1280,
        innerHeight: 720,
        canvases: [{ width: 1280, height: 720, cssWidth: 1280, cssHeight: 720 }],
      },
    };
    const evidence = validateEvidence({
      trace,
      matrix,
      postMatrix: structuredClone(matrix),
      headed: true,
      requestedDurationMs: 784,
    });
    expect(evidence.status).toBe('VALID');
    expect(evidence.invalidReasons).toEqual([]);
  });

  test('rejects short or incomplete samples instead of treating them as a benchmark', () => {
    const trace = summarizeTrace([
      { name: 'process_name', ph: 'M', pid: 1, args: { name: 'Renderer' } },
      { name: 'process_name', ph: 'M', pid: 2, args: { name: 'GPU Process' } },
      { name: 'thread_name', ph: 'M', tid: 11, args: { name: 'CrRendererMain' } },
      { name: 'thread_name', ph: 'M', tid: 12, args: { name: 'CrGpuMain' } },
      { name: 'thread_name', ph: 'M', tid: 13, args: { name: 'VizCompositorThread' } },
      { name: 'FireAnimationFrame', ts: 0, pid: 1, tid: 11 },
      { name: 'Display::FrameDisplayed', ts: 0, pid: 2, tid: 13 },
      { name: 'BeginFrameArgs', ts: 0 },
      { name: 'WebGPUCommand', ts: 0, dur: 1000, cat: 'gpu' },
    ]);
    const matrix = {
      state: { ok: true, value: { phase: 'play', mode: 'play', transformRows: 1, meshRows: 1, rendererStats: { frustumStats: { culled: 4, total: 10 } } } },
      dom: { visible: 'visible', focused: true, dpr: 1, innerWidth: 1280, innerHeight: 720, canvases: [] },
    };
    const evidence = validateEvidence({
      trace,
      matrix,
      postMatrix: matrix,
      headed: true,
      requestedDurationMs: 3000,
    });
    expect(evidence.status).toBe('INVALID');
    expect(evidence.invalidReasons).toContain('applicationFrames:1<50');
    expect(evidence.invalidReasons).toContain('displayedFrames:1<50');
  });

  test('percentile is bounded and empty-safe', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([1, 2, 3], 0)).toBe(1);
    expect(percentile([1, 2, 3], 1)).toBe(3);
  });

  test('keeps host control-plane polling out of blocking resource evidence', () => {
    expect(classifyResourceRequest({
      url: 'http://localhost:15290/api/logs',
      method: 'POST',
      resourceType: 'fetch',
    }).category).toBe('background-control-plane');
    expect(classifyResourceRequest({
      url: 'http://localhost:15290/games/sample/assets/city.glb',
      method: 'GET',
      resourceType: 'fetch',
    }).category).toBe('blocking');
    expect(classifyResourceRequest({
      url: () => 'http://localhost:15290/api/bus/ui/surfaces/host.sidebar/pending',
      method: () => 'GET',
      resourceType: () => 'fetch',
    }).category).toBe('background-control-plane');
    expect(classifyResourceRequest({
      url: 'http://localhost:15290/api/workbench/games',
      method: 'GET',
      resourceType: 'fetch',
    }).category).toBe('background-control-plane');
  });

  test('accepts a stable headed sample with only host control-plane polling', () => {
    const trace = summarizeTrace([
      { name: 'process_name', ph: 'M', pid: 1, args: { name: 'Renderer' } },
      { name: 'process_name', ph: 'M', pid: 2, args: { name: 'GPU Process' } },
      { name: 'thread_name', ph: 'M', tid: 11, args: { name: 'CrRendererMain' } },
      { name: 'thread_name', ph: 'M', tid: 12, args: { name: 'CrGpuMain' } },
      { name: 'thread_name', ph: 'M', tid: 13, args: { name: 'VizCompositorThread' } },
      ...Array.from({ length: 50 }, (_, index) => ({ name: 'FireAnimationFrame', ts: index * 16000 })),
      ...Array.from({ length: 50 }, (_, index) => ({ name: 'Display::FrameDisplayed', ts: index * 16000 })),
      { name: 'BeginFrameArgs', ts: 0 },
      { name: 'WebGPUCommand', ts: 0, dur: 1000, cat: 'gpu' },
      { name: 'Graphics.Pipeline', ts: 0, dur: 1000, cat: 'viz' },
    ]);
    const matrix = {
      state: { ok: true, value: { phase: 'edit', mode: 'edit', transformRows: 1, meshRows: 1 } },
      dom: { visible: 'visible', focused: true, dpr: 1, innerWidth: 1280, innerHeight: 720, canvases: [] },
    };
    const evidence = validateEvidence({
      trace,
      matrix,
      postMatrix: structuredClone(matrix),
      headed: true,
      requestedDurationMs: 784,
      resourceRequests: [
        classifyResourceRequest({ url: 'http://localhost:15290/api/logs', method: 'POST', resourceType: 'fetch' }),
        classifyResourceRequest({ url: 'http://localhost:15290/api/bus/ui/surfaces/host.sidebar/pending', method: 'GET', resourceType: 'fetch' }),
      ],
    });
    expect(evidence.status).toBe('VALID');
    expect(evidence.invalidReasons).toEqual([]);
    expect(evidence.observed.resourceRequests).toBe(2);
    expect(evidence.observed.blockingResourceRequests).toBe(0);
  });
});

describe('bounded trace plumbing', () => {
  test('never waits forever on a stuck promise', async () => {
    await expect(withTimeout(new Promise(() => {}), 5, 'fixture')).rejects.toThrow('fixture timed out after 5ms');
  });

  test('stops reading a trace stream at EOF', async () => {
    let reads = 0;
    const client = {
      send: async () => {
        reads += 1;
        return reads === 1 ? { data: '{"traceEvents":', eof: false } : { data: '[]}', eof: true };
      },
    };
    await expect(readTraceStream(client, 'stream', { timeoutMs: 20 })).resolves.toBe('{"traceEvents":[]}');
    expect(reads).toBe(2);
  });
});
