import { describe, expect, it } from 'bun:test';
import {
  createDisposablePlayCarrier,
  type DisposablePlayFrame,
  type DisposablePlayFrameHost,
} from '../disposable-play-carrier';
import { createRunLifecycle } from '../run-lifecycle';

function harness(
  onFps?: (fps: number, generation: number) => void,
  options: {
    readonly livenessTimeoutMs?: number;
    readonly unreachableConfirmations?: number;
    /** Simulated runtime-URL reachability for the liveness probe. */
    readonly reachable?: () => boolean;
    /** Simulate a frozen server: never settle, honour the probe's AbortSignal. */
    readonly hang?: boolean;
  } = {},
) {
  const events: string[] = [];
  const listeners = new Set<(event: MessageEvent) => void>();
  const captureFrames: number[] = [];
  const failures: Array<{ code: string; hint: string }> = [];
  const source = {
    postMessage: (message: { type?: string; payload?: { requestId?: string; operation?: string } }) => {
      events.push(`post:${message.type ?? 'unknown'}`);
      if (message.type === 'VAG_GAMEPLAY_REQUEST' && message.payload?.requestId) {
        queueMicrotask(() => {
          const data = message.payload?.operation === 'describe'
            ? {
              type: 'VAG_GAMEPLAY_RESPONSE',
              payload: { version: 1, requestId: message.payload!.requestId, ok: true, data: { actions: [], reads: [] } },
            }
            : {
              type: 'VAG_GAMEPLAY_RESPONSE',
              payload: { version: 1, requestId: message.payload!.requestId, ok: true },
            };
          for (const next of [...listeners]) next({ source, data } as MessageEvent);
        });
      }
    },
    __forgeax: {
      captureFrame: async (frames: number) => {
        captureFrames.push(frames);
        return {
          runId: `child-capture-${frames}`,
          tapePath: `.forgeax-debug/child-capture-${frames}/frame-0.tape.bin`,
          reportPath: `.forgeax-debug/child-capture-${frames}/frame-0.report.json`,
        };
      },
    },
    __forgeaxPlayRendererProvenance: () => ({ identity: 'renderer-play-1', generation: 1, backend: 'webgpu' }),
    location: { search: '?runtimeId=runtime-a&runtimeGeneration=4&carrierId=carrier-a:play&carrierKind=iframe' },
  } as unknown as WindowProxy;
  const frame = { generation: 1, source, element: {} as HTMLIFrameElement } satisfies DisposablePlayFrame;
  const host: DisposablePlayFrameHost = {
    create(generation, url) {
      events.push(`create:${generation}:${url}`);
      return { ...frame, generation };
    },
    mount() { events.push('mount'); },
    remove() { events.push('remove'); },
    subscribe(next) {
      listeners.add(next);
      return () => { listeners.delete(next); events.push('unsubscribe'); };
    },
  };
  const carrier = createDisposablePlayCarrier({
    container: {} as HTMLElement,
    url: (generation) => `/preview/?playGeneration=${generation}&runtimeId=runtime-a&runtimeGeneration=4&carrierId=carrier-a:play&carrierKind=iframe`,
    releaseEditSurface: async () => { events.push('release'); return { ok: true }; },
    restoreEditSurface: async () => { events.push('restore'); return { ok: true }; },
    host,
    readyTimeoutMs: 50,
    ...(options.livenessTimeoutMs === undefined ? {} : { livenessTimeoutMs: options.livenessTimeoutMs }),
    ...(options.unreachableConfirmations === undefined
      ? {}
      : { unreachableConfirmations: options.unreachableConfirmations }),
    ...(onFps ? { onFps } : {}),
    onFailure: (failure) => failures.push(failure),
  });
  // The liveness probe reads runtime reachability through global fetch; stub it
  // so a test can hold the runtime "dead" while frames keep arriving.
  const realFetch = globalThis.fetch;
  let probes = 0;
  if (options.hang) {
    // A SIGSTOPped server accepts the connection and never answers. Only the
    // probe's own AbortSignal can end this, which is exactly what we assert.
    globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) => {
      probes += 1;
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // no timeout wired → hangs forever (the old bug)
        if (signal.aborted) { reject(new Error('aborted')); return; }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }) as unknown as typeof fetch;
  } else if (options.reachable) {
    globalThis.fetch = (async () => {
      probes += 1;
      return { ok: options.reachable!(), body: null } as unknown as Response;
    }) as unknown as typeof fetch;
  }
  return {
    carrier,
    events,
    captureFrames,
    failures,
    probeCount: () => probes,
    restoreFetch() { globalThis.fetch = realFetch; },
    send(data: unknown, eventSource: MessageEventSource | null = source) {
      for (const next of [...listeners]) next({ source: eventSource, data } as MessageEvent);
    },
    ready(identity: { runtimeGeneration?: number; carrierId?: string } = {}) {
      this.send({ type: 'VAG_CARRIER_HEARTBEAT', payload: {
          runtimeId: 'runtime-a', runtimeGeneration: identity.runtimeGeneration ?? 4,
          carrierId: identity.carrierId ?? 'carrier-a:play', carrierKind: 'iframe', renderReadiness: 'ready',
      } });
    },
    fail(failure: { code: string; hint: string; message?: string }) {
      this.send({ type: 'VAG_CARRIER_FAILURE', payload: {
          runtimeId: 'runtime-a', runtimeGeneration: 4, carrierId: 'carrier-a:play', carrierKind: 'iframe', failure,
      } });
    },
  };
}

describe('disposable Play carrier', () => {
  it('releases Edit before mounting Play and hard-removes Play before restore', async () => {
    const h = harness();
    const started = h.carrier.start();
    await Promise.resolve();
    expect(h.events.slice(0, 3)).toEqual([
      'release',
      'create:1:/preview/?playGeneration=1&runtimeId=runtime-a&runtimeGeneration=4&carrierId=carrier-a:play&carrierKind=iframe',
      'mount',
    ]);
    h.ready();
    expect(await started).toEqual({ ok: true });
    expect(h.carrier.state()).toBe('play');
    await expect(h.carrier.captureFrame(2)).resolves.toMatchObject({
      runId: 'child-capture-2',
      provenance: {
        backend: 'webgpu', rendererIdentity: 'renderer-play-1', rendererGeneration: 1,
        carrierGeneration: 1, carrierId: 'carrier-a:play', carrierKind: 'iframe',
        runtimeId: 'runtime-a', runtimeGeneration: 4,
      },
    });
    expect(h.captureFrames).toEqual([2]);

    expect(await h.carrier.stop()).toEqual({ ok: true });
    expect(h.events.indexOf('remove')).toBeLessThan(h.events.indexOf('restore'));
    expect(h.carrier.state()).toBe('edit');
  });

  it('destroys a child that never reaches first-frame readiness and restores Edit', async () => {
    const h = harness();
    const result = await h.carrier.start();
    expect(result).toMatchObject({ ok: false, error: { code: 'play-carrier-ready-timeout' } });
    expect(h.events).toContain('remove');
    expect(h.events.at(-1)).toBe('restore');
    expect(h.carrier.state()).toBe('edit');
    await expect(h.carrier.captureFrame(1)).rejects.toMatchObject({ code: 'play-carrier-capture-unavailable' });
  });

  it('surfaces a correlated child failure before the readiness deadline', async () => {
    const h = harness();
    const started = h.carrier.start();
    await Promise.resolve();
    const message = '[engine] requested runtime generation does not match the active binding';
    h.fail({ code: 'play-carrier-boot-failed', hint: 'inspect the child boot log', message });
    await expect(started).resolves.toEqual({ ok: false, error: { code: 'play-carrier-boot-failed', hint: message } });
    expect(h.events).toContain('remove');
    expect(h.failures).toEqual([]);
  });

  it('reports a terminal child failure after first-frame readiness', async () => {
    const h = harness(undefined, { livenessTimeoutMs: 5 });
    const started = h.carrier.start();
    await Promise.resolve();
    h.ready();
    await expect(started).resolves.toEqual({ ok: true });

    h.fail({ code: 'device-lost', hint: 'GPU queue stopped', message: 'WebGPU device lost' });
    await Bun.sleep(25);
    expect(h.failures).toEqual([{ code: 'device-lost', hint: 'WebGPU device lost' }]);
    await h.carrier.stop();
  });

  it('reports runtime-disconnected while a live carrier keeps publishing frames', async () => {
    // Regression: the probe used to require frame silence BEFORE checking the
    // runtime URL, so "runtime server died but the carrier keeps rendering
    // already-loaded modules" was undetectable — verified against a real
    // SIGSTOPped Vite (frames kept flowing, no card ever appeared).
    let reachable = true;
    const h = harness(undefined, { livenessTimeoutMs: 60, unreachableConfirmations: 2, reachable: () => reachable });
    try {
      const started = h.carrier.start();
      await Promise.resolve();
      h.ready();
      await expect(started).resolves.toEqual({ ok: true });

      // Runtime dies, but the carrier stays healthy: keep heartbeats flowing so
      // the frame clock never stalls. The probe floor is 250ms, so span enough
      // wall-clock for `unreachableConfirmations` ticks to land.
      reachable = false;
      for (let i = 0; i < 20; i++) {
        h.ready();
        await Bun.sleep(50);
      }

      expect(h.probeCount()).toBeGreaterThan(0);
      expect(h.failures).toEqual([{
        code: 'viewport-runtime-disconnected',
        hint: 'The Play runtime URL became unreachable while the carrier was still rendering already-loaded modules.',
      }]);
      await h.carrier.stop();
    } finally {
      h.restoreFetch();
    }
  });

  it('keeps a reachable runtime with live frames silent (no false outage)', async () => {
    const h = harness(undefined, { livenessTimeoutMs: 60, unreachableConfirmations: 2, reachable: () => true });
    try {
      const started = h.carrier.start();
      await Promise.resolve();
      h.ready();
      await expect(started).resolves.toEqual({ ok: true });
      for (let i = 0; i < 16; i++) {
        h.ready();
        await Bun.sleep(50);
      }
      expect(h.failures).toEqual([]);
      await h.carrier.stop();
    } finally {
      h.restoreFetch();
    }
  });

  it('requires consecutive unreachable probes before declaring an outage', async () => {
    let reachable = true;
    let calls = 0;
    const h = harness(undefined, {
      livenessTimeoutMs: 60,
      unreachableConfirmations: 3,
      // One isolated blip, then reachable again — must not report.
      reachable: () => { calls += 1; return calls === 2 ? false : reachable; },
    });
    try {
      const started = h.carrier.start();
      await Promise.resolve();
      h.ready();
      await expect(started).resolves.toEqual({ ok: true });
      for (let i = 0; i < 16; i++) {
        h.ready();
        await Bun.sleep(50);
      }
      expect(h.failures).toEqual([]);
      await h.carrier.stop();
    } finally {
      h.restoreFetch();
    }
  });

  it('treats a hung runtime as unreachable instead of stalling forever', async () => {
    // Regression: a SIGSTOPped Vite leaves probes pending rather than failing.
    // Without a per-probe timeout the unreachable counter never advanced AND
    // livenessProbeActive stayed true, so every later tick returned early —
    // reproduced live: 45s, 52 probes, 432 frames, zero reports.
    const h = harness(undefined, { livenessTimeoutMs: 60, unreachableConfirmations: 2, hang: true });
    try {
      const started = h.carrier.start();
      await Promise.resolve();
      h.ready();
      await expect(started).resolves.toEqual({ ok: true });

      for (let i = 0; i < 24; i++) {
        h.ready();               // frames keep flowing the whole time
        await Bun.sleep(50);
      }

      expect(h.probeCount()).toBeGreaterThan(1); // probes must not be pinned by the first hang
      expect(h.failures).toEqual([{
        code: 'viewport-runtime-disconnected',
        hint: 'The Play runtime URL became unreachable while the carrier was still rendering already-loaded modules.',
      }]);
      await h.carrier.stop();
    } finally {
      h.restoreFetch();
    }
  });

  it('ignores ready messages from a different runtime generation', async () => {
    const h = harness();
    const started = h.carrier.start();
    await Promise.resolve();
    h.ready({ runtimeGeneration: 3 });
    await Promise.resolve();
    expect(h.carrier.state()).toBe('entering-play');
    h.ready();
    await expect(started).resolves.toEqual({ ok: true });
  });

  it('fails closed when the current child is stale or lacks producer provenance', async () => {
    let resolveCapture: ((value: unknown) => void) | undefined;
    let listener: ((event: MessageEvent) => void) | undefined;
    const listeners = new Set<(event: MessageEvent) => void>();
    const source = {
      postMessage: (message: { payload?: { requestId?: string } }) => {
        if (message.payload?.requestId) {
          const event = { source, data: {
            type: 'VAG_GAMEPLAY_RESPONSE',
            payload: { version: 1, requestId: message.payload.requestId, ok: true, data: { actions: [], reads: [] } },
          } } as MessageEvent;
          for (const next of [...listeners]) next(event);
        }
      },
      __forgeax: { captureFrame: () => new Promise((resolve) => { resolveCapture = resolve; }) },
      __forgeaxPlayRendererProvenance: () => ({ identity: 'renderer-play-2', generation: 2, backend: 'webgpu' }),
      location: { search: '?runtimeId=runtime-a&runtimeGeneration=4&carrierId=carrier-a&carrierKind=iframe' },
    } as unknown as WindowProxy;
    const frame = { generation: 1, source, element: {} as HTMLIFrameElement } satisfies DisposablePlayFrame;
    const carrier = createDisposablePlayCarrier({
      container: {} as HTMLElement,
      url: () => '/preview/?runtimeId=runtime-a&runtimeGeneration=4&carrierId=carrier-a&carrierKind=iframe',
      releaseEditSurface: async () => ({ ok: true as const }),
      restoreEditSurface: async () => ({ ok: true as const }),
      host: {
        create: () => frame,
        mount: () => {}, remove: () => {},
        subscribe: (next) => {
          listeners.add(next);
          listener = next;
          return () => {
            listeners.delete(next);
            if (listener === next) listener = undefined;
          };
        },
      },
      readyTimeoutMs: 50,
    });
    const started = carrier.start();
    await Promise.resolve();
    listener?.({ source, data: { type: 'VAG_CARRIER_HEARTBEAT', payload: {
      runtimeId: 'runtime-a', runtimeGeneration: 4, carrierId: 'carrier-a', carrierKind: 'iframe', renderReadiness: 'ready',
    } } } as MessageEvent);
    await expect(started).resolves.toEqual({ ok: true });
    const capture = carrier.captureFrame(1);
    await carrier.stop();
    resolveCapture?.({ runId: 'stale', tapePath: 'stale.tape.bin', reportPath: 'stale.report.json' });
    await expect(capture).rejects.toMatchObject({ code: 'play-carrier-capture-stale' });

    const missingSource = {
      postMessage: (message: { payload?: { requestId?: string } }) => {
        if (message.payload?.requestId) {
          const event = { source: missingSource, data: {
            type: 'VAG_GAMEPLAY_RESPONSE',
            payload: { version: 1, requestId: message.payload.requestId, ok: true, data: { actions: [], reads: [] } },
          } } as MessageEvent;
          for (const next of [...listeners]) next(event);
        }
      },
      __forgeax: { captureFrame: async () => ({ runId: 'x', tapePath: 'x.tape.bin', reportPath: 'x.report.json' }) },
      location: { search: '' },
    } as unknown as WindowProxy;
    const missingProvenance = createDisposablePlayCarrier({
      container: {} as HTMLElement,
      url: () => '/preview/?runtimeId=runtime-a&runtimeGeneration=4&carrierId=carrier-a&carrierKind=iframe',
      releaseEditSurface: async () => ({ ok: true as const }),
      restoreEditSurface: async () => ({ ok: true as const }),
      host: {
        create: () => ({ ...frame, source: missingSource }),
        mount: () => {}, remove: () => {},
        subscribe: (next) => {
          listeners.add(next);
          listener = next;
          return () => {
            listeners.delete(next);
            if (listener === next) listener = undefined;
          };
        },
      },
      readyTimeoutMs: 50,
    });
    const missingStart = missingProvenance.start();
    await Promise.resolve();
    listener?.({ source: missingSource, data: { type: 'VAG_CARRIER_HEARTBEAT', payload: {
      runtimeId: 'runtime-a', runtimeGeneration: 4, carrierId: 'carrier-a', carrierKind: 'iframe', renderReadiness: 'ready',
    } } } as MessageEvent);
    await expect(missingStart).resolves.toEqual({ ok: true });
    await expect(missingProvenance.captureFrame(1)).rejects.toMatchObject({ code: 'play-carrier-provenance-unavailable' });
  });

  it('routes viewport visibility pause/resume to the child while it owns Play', async () => {
    const h = harness();
    const started = h.carrier.start();
    await Promise.resolve();

    h.carrier.pause();
    h.ready();
    expect(await started).toEqual({ ok: true });
    h.carrier.resume();

    // The pre-ready pause is sent immediately and replayed after readiness so
    // listener-install races cannot leave a hidden Play child running.
    expect(h.events.filter((event) => event === 'post:VAG_PREVIEW_PAUSE')).toHaveLength(2);
    expect(h.events.filter((event) => event === 'post:VAG_PREVIEW_PLAY')).toHaveLength(1);
  });

  it('publishes FPS only from the current child source and generation', async () => {
    const samples: Array<[number, number]> = [];
    const h = harness((fps, generation) => samples.push([fps, generation]));
    const started = h.carrier.start();
    await Promise.resolve();
    h.ready();
    expect(await started).toEqual({ ok: true });

    h.send({ type: 'VAG_FPS_STATS', payload: { fps: 117 } });
    h.send(
      { type: 'VAG_FPS_STATS', payload: { fps: 5 } },
      {} as MessageEventSource,
    );
    h.send({ type: 'VAG_FPS_STATS', payload: { fps: 'bad' } });

    expect(samples).toEqual([[117, 1]]);
  });

  it('round-trips remote gameplay projection requests through the current child', async () => {
    const h = harness();
    const started = h.carrier.start();
    await Promise.resolve();
    h.ready();
    expect(await started).toEqual({ ok: true });
    expect(h.carrier.gameplayDescriptors()).toEqual({ actions: [], reads: [] });
    expect(await h.carrier.gameplay({ operation: 'read', id: 'gta-route.presentation-state' })).toEqual({ ok: true });
  });

  it('keeps 50 remote Play/Stop cycles off the retained Edit World', async () => {
    const calls = { start: 0, stop: 0, enter: 0, exit: 0, assemble: 0, pause: 0, resume: 0 };
    const lifecycle = createRunLifecycle({
      editorApp: {
        pause: () => { calls.pause++; return { ok: true }; },
        resume: () => { calls.resume++; return { ok: true }; },
      },
      gateway: {
        enterPlay: () => { throw new Error('in-process Play must not be entered'); },
        enterRemotePlay: () => { calls.enter++; },
        exitPlay: () => { calls.exit++; },
        beginPlayAttempt: () => {},
        failPlayAttempt: () => {},
      },
      remoteCarrier: {
        start: async () => { calls.start++; return { ok: true }; },
        stop: async () => { calls.stop++; return { ok: true }; },
        state: () => 'edit',
        pause: () => {},
        resume: () => {},
        gameplayDescriptors: () => ({ actions: [], reads: [] }),
        gameplay: async () => ({ ok: false, error: { code: 'unused', hint: 'unused' } }),
      },
      assemble: async () => { calls.assemble++; return { ok: false, error: new Error('unreachable') }; },
    });

    for (let i = 0; i < 50; i++) {
      await lifecycle.playSimulation();
      await lifecycle.stopSimulation();
    }
    expect(calls).toEqual({ start: 50, stop: 50, enter: 50, exit: 50, assemble: 0, pause: 0, resume: 0 });
    expect(lifecycle.currentPlayWorld()).toBeNull();
  });
});
