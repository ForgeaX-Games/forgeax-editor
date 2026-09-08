import type {
  GameActionDescriptor,
  GameReadDescriptor,
  RemoteGameplayDescriptors,
  RemoteGameplayRequest,
  RemoteGameplayResult,
} from '@forgeax/editor-core';
import {
  VagFpsStatsSchema,
  VagGameplayDescribeDataSchema,
  VagGameplayRequestSchema,
  VagGameplayResponseSchema,
  VAG_GAMEPLAY_PROTOCOL_VERSION,
} from '@forgeax/editor-core/protocol';

export interface DisposablePlayFrame {
  readonly generation: number;
  /** Browser iframes acquire their WindowProxy only after mount; native hosts may provide it at create time. */
  readonly source: WindowProxy | null;
  readonly element: HTMLIFrameElement;
}

export interface CaptureProducerProvenance {
  readonly backend: string;
  readonly rendererIdentity: string;
  readonly rendererGeneration: number;
  readonly carrierGeneration: number;
  readonly carrierId: string;
  readonly carrierKind: string;
  readonly runtimeId: string;
  readonly runtimeGeneration: number;
}

export interface CaptureArtifactWithProvenance {
  readonly runId: string;
  readonly tapePath: string;
  readonly reportPath: string;
  readonly provenance: CaptureProducerProvenance;
}

export type PlayCarrierResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: { readonly code: string; readonly hint: string } };

export interface DisposablePlayCarrierDeps {
  readonly container: HTMLElement;
  readonly url: (generation: number) => string;
  readonly releaseEditSurface: () => Promise<PlayCarrierResult>;
  readonly restoreEditSurface: () => Promise<PlayCarrierResult>;
  readonly readyTimeoutMs?: number;
  readonly host?: DisposablePlayFrameHost;
  readonly onReady?: (payload: unknown) => void;
  /** Child-owned frame cadence, accepted only from the current generation/source. */
  readonly onFps?: (fps: number, generation: number) => void;
  /** Report terminal failures after the child has reached first-frame readiness. */
  readonly onFailure?: (failure: { readonly code: string; readonly hint: string }) => void;
  /** Disabled unless supplied by the browser host composition root. */
  readonly livenessTimeoutMs?: number | false;
  /** Consecutive unreachable probes required before declaring the runtime gone.
   *  A live carrier keeps rendering from already-loaded modules, so runtime
   *  reachability is checked independently of frame cadence; requiring N
   *  consecutive failures keeps a single network blip from reading as an outage. */
  readonly unreachableConfirmations?: number;
}

export interface DisposablePlayFrameHost {
  create(generation: number, url: string): DisposablePlayFrame | null;
  mount(frame: DisposablePlayFrame, container: HTMLElement): void;
  remove(frame: DisposablePlayFrame): void;
  subscribe(listener: (event: MessageEvent) => void): () => void;
}

export interface DisposablePlayCarrier {
  start(): Promise<PlayCarrierResult>;
  stop(): Promise<PlayCarrierResult>;
  /** Capture from the currently live Play child without falling back to Edit. */
  captureFrame(frames: number): Promise<unknown>;
  pause(): void;
  resume(): void;
  state(): 'edit' | 'entering-play' | 'play' | 'stopping';
  generation(): number;
  gameplayDescriptors(): RemoteGameplayDescriptors;
  gameplay(request: RemoteGameplayRequest): Promise<RemoteGameplayResult>;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const GAMEPLAY_DESCRIBE_ATTEMPTS = 3;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function queryIdentity(search: string, key: string): string | undefined {
  const value = new URLSearchParams(search).get(key)?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

interface CarrierMessageIdentity {
  readonly runtimeId: string;
  readonly runtimeGeneration: number;
  readonly carrierId: string;
  readonly carrierKind: string;
}

function readCarrierMessageIdentity(url: string): CarrierMessageIdentity | undefined {
  try {
    const search = new URL(url, 'http://forgeax-carrier.invalid').search;
    const runtimeId = queryIdentity(search, 'runtimeId');
    const carrierId = queryIdentity(search, 'carrierId');
    const carrierKind = queryIdentity(search, 'carrierKind');
    const runtimeGeneration = Number(new URLSearchParams(search).get('runtimeGeneration'));
    if (runtimeId === undefined || carrierId === undefined || carrierKind === undefined
      || !positiveInteger(runtimeGeneration)) return undefined;
    return { runtimeId, runtimeGeneration, carrierId, carrierKind };
  } catch {
    return undefined;
  }
}

function matchesCarrierMessageIdentity(value: unknown, expected: CarrierMessageIdentity | undefined): boolean {
  if (expected === undefined) return false;
  const payload = record(value);
  return payload?.runtimeId === expected.runtimeId
    && payload.runtimeGeneration === expected.runtimeGeneration
    && payload.carrierId === expected.carrierId
    && payload.carrierKind === expected.carrierKind;
}

function readCaptureProvenance(source: WindowProxy, generation: number): CaptureProducerProvenance | undefined {
  const candidate = source as unknown as {
    __forgeaxPlayRendererProvenance?: () => unknown;
    location?: { readonly search?: string };
  };
  const renderer = typeof candidate.__forgeaxPlayRendererProvenance === 'function'
    ? record(candidate.__forgeaxPlayRendererProvenance())
    : undefined;
  const search = typeof candidate.location?.search === 'string' ? candidate.location.search : '';
  const backend = renderer?.backend;
  const rendererIdentity = renderer?.identity;
  const rendererGeneration = renderer?.generation;
  const carrierId = queryIdentity(search, 'carrierId');
  const carrierKind = queryIdentity(search, 'carrierKind');
  const runtimeId = queryIdentity(search, 'runtimeId');
  const runtimeGeneration = Number(new URLSearchParams(search).get('runtimeGeneration'));
  if (typeof backend !== 'string' || backend.trim() === ''
    || typeof rendererIdentity !== 'string' || rendererIdentity.trim() === ''
    || !positiveInteger(rendererGeneration) || !positiveInteger(generation)
    || carrierId === undefined || carrierKind === undefined || runtimeId === undefined
    || !positiveInteger(runtimeGeneration)) return undefined;
  return Object.freeze({
    backend,
    rendererIdentity,
    rendererGeneration,
    carrierGeneration: generation,
    carrierId,
    carrierKind,
    runtimeId,
    runtimeGeneration,
  });
}

function isArtifact(value: unknown): value is { readonly runId: string; readonly tapePath: string; readonly reportPath: string } {
  const candidate = record(value);
  return typeof candidate?.runId === 'string' && candidate.runId.trim() !== ''
    && typeof candidate.tapePath === 'string' && candidate.tapePath.trim() !== ''
    && typeof candidate.reportPath === 'string' && candidate.reportPath.trim() !== '';
}

const browserHost: DisposablePlayFrameHost = {
  create(generation, url) {
    const element = document.createElement('iframe');
    element.className = 'viewport-play-child';
    element.dataset.playGeneration = String(generation);
    element.allow = 'autoplay; fullscreen; gamepad; xr-spatial-tracking; pointer-lock';
    element.src = url;
    element.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;z-index:20;background:#111;';
    return { generation, source: null, element };
  },
  mount(frame, container) { container.appendChild(frame.element); },
  remove(frame) { frame.element.remove(); },
  subscribe(listener) {
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  },
};

/** Browser adapter for the one disposable Play child owned by Viewport Runtime. */
export function createDisposablePlayCarrier(deps: DisposablePlayCarrierDeps): DisposablePlayCarrier {
  const host = deps.host ?? browserHost;
  let phase: ReturnType<DisposablePlayCarrier['state']> = 'edit';
  let frame: DisposablePlayFrame | null = null;
  let nextGeneration = 0;
  let desiredPaused = false;
  let unsubscribeFrameMessages = () => {};
  let livenessTimer: ReturnType<typeof setInterval> | undefined;
  let lastCarrierHeartbeatAt = 0;
  let livenessProbeActive = false;
  let consecutiveUnreachable = 0;
  let terminalFailureReported = false;
  let reportedFailureKey: string | undefined;
  let requestSequence = 0;
  let descriptors: RemoteGameplayDescriptors = { actions: [], reads: [] };
  const pendingGameplay = new Map<string, (result: RemoteGameplayResult) => void>();

  const settleGameplay = (result: RemoteGameplayResult): void => {
    for (const resolve of pendingGameplay.values()) resolve(result);
    pendingGameplay.clear();
  };

  const updateDescriptors = (data: unknown): void => {
    const parsed = VagGameplayDescribeDataSchema.safeParse(data);
    if (!parsed.success) return;
    const actions: GameActionDescriptor[] = parsed.data.actions.map((descriptor) => ({
      id: descriptor.id,
      title: descriptor.title,
      ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
      argsSchema: descriptor.argsSchema === undefined ? null : descriptor.argsSchema as GameActionDescriptor['argsSchema'],
    }));
    const reads: GameReadDescriptor[] = parsed.data.reads.map((descriptor) => ({
      id: descriptor.id,
      title: descriptor.title,
      ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
    }));
    descriptors = { actions, reads };
  };

  const requestGameplay = (request: RemoteGameplayRequest): Promise<RemoteGameplayResult> => {
    const current = frame;
    if (current === null || (phase !== 'entering-play' && phase !== 'play')) {
      return Promise.resolve({ ok: false, error: {
        code: 'play-carrier-not-active',
        hint: 'remote gameplay projection requests require an active Play carrier',
        retryable: true,
      } });
    }
    const source = current.source ?? current.element.contentWindow;
    if (source === null) {
      return Promise.resolve({ ok: false, error: {
        code: 'play-carrier-window-unavailable',
        hint: 'remote Play did not expose a contentWindow for gameplay projection',
        retryable: true,
      } });
    }
    const requestId = `play-${current.generation}-${++requestSequence}`;
    const message = {
      type: 'VAG_GAMEPLAY_REQUEST' as const,
      payload: {
        version: VAG_GAMEPLAY_PROTOCOL_VERSION,
        requestId,
        ...request,
      },
    };
    const parsed = VagGameplayRequestSchema.safeParse(message);
    if (!parsed.success) {
      return Promise.resolve({ ok: false, error: {
        code: 'play-gameplay-request-invalid',
        hint: 'remote gameplay request did not satisfy the versioned projection contract',
      } });
    }
    return new Promise<RemoteGameplayResult>((resolve) => {
      const timer = setTimeout(() => {
        const pending = pendingGameplay.get(requestId);
        if (!pending) return;
        pendingGameplay.delete(requestId);
        pending({ ok: false, error: {
          code: 'play-gameplay-request-timeout',
          hint: 'remote Play did not answer the gameplay projection request before the deadline',
          retryable: true,
        } });
      }, 5_000);
      pendingGameplay.set(requestId, (result) => {
        clearTimeout(timer);
        if (request.operation === 'describe' && result.ok) updateDescriptors(result.data);
        resolve(result);
      });
      try {
        source.postMessage(parsed.data, '*');
      } catch (error) {
        clearTimeout(timer);
        pendingGameplay.delete(requestId);
        resolve({ ok: false, error: {
          code: 'play-gameplay-request-post-failed',
          hint: error instanceof Error ? error.message : String(error),
          retryable: true,
        } });
      }
    });
  };

  // A standalone editor can reload the Play child while Vite/plugin-pack HMR
  // settles after an asset upload. The carrier heartbeat may arrive from the
  // old document just before that reload, so the first idempotent descriptor
  // request can be lost. Retry only `describe`: reads and actions may have
  // producer side effects and must remain exactly-once from the carrier's
  // point of view.
  async function describeGameplayWithRetry(): Promise<RemoteGameplayResult> {
    let result: RemoteGameplayResult = {
      ok: false,
      error: {
        code: 'play-gameplay-request-timeout',
        hint: 'remote Play did not answer the gameplay descriptor request',
        retryable: true,
      },
    };
    for (let attempt = 0; attempt < GAMEPLAY_DESCRIBE_ATTEMPTS; attempt += 1) {
      result = await requestGameplay({ operation: 'describe' });
      if (result.ok || result.error.retryable !== true) return result;
    }
    return result;
  }

  const postToChild = (type: 'VAG_PREVIEW_PAUSE' | 'VAG_PREVIEW_PLAY'): void => {
    const current = frame;
    if (current === null) return;
    const source = current.source ?? current.element.contentWindow;
    try { source?.postMessage({ type }, '*'); } catch { /* child removal is authoritative */ }
  };

  /** Publish one terminal liveness verdict, then stop probing. Deduped by
   *  code+hint so a repeated verdict cannot raise a second card. */
  const reportLivenessFailure = (failure: { readonly code: string; readonly hint: string }): void => {
    const key = `${failure.code}\n${failure.hint}`;
    if (reportedFailureKey === key) return;
    terminalFailureReported = true;
    reportedFailureKey = key;
    deps.onFailure?.(failure);
    if (livenessTimer !== undefined) clearInterval(livenessTimer);
    livenessTimer = undefined;
  };

  async function stopFrame(restore: boolean): Promise<PlayCarrierResult> {
    const current = frame;
    frame = null;
    unsubscribeFrameMessages();
    unsubscribeFrameMessages = () => {};
    if (livenessTimer !== undefined) clearInterval(livenessTimer);
    livenessTimer = undefined;
    livenessProbeActive = false;
    consecutiveUnreachable = 0;
    terminalFailureReported = false;
    settleGameplay({ ok: false, error: {
      code: 'play-carrier-stopped',
      hint: 'remote Play stopped before the gameplay projection request completed',
      retryable: true,
    } });
    if (current !== null) {
      const source = current.source ?? current.element.contentWindow;
      try { source?.postMessage({ type: 'VAG_PREVIEW_PAUSE' }, '*'); } catch { /* hard removal remains authoritative */ }
      host.remove(current);
    }
    if (!restore) return { ok: true };
    return deps.restoreEditSurface();
  }

  async function start(): Promise<PlayCarrierResult> {
    if (phase === 'play') return { ok: true };
    if (phase !== 'edit') {
      return { ok: false, error: { code: 'play-carrier-transition-active', hint: `cannot start while carrier is ${phase}` } };
    }
    phase = 'entering-play';
    const released = await deps.releaseEditSurface();
    if (!released.ok) {
      phase = 'edit';
      return released;
    }

    const generation = ++nextGeneration;
    const childUrl = deps.url(generation);
    reportedFailureKey = undefined;
    terminalFailureReported = false;
    consecutiveUnreachable = 0;
    const expectedIdentity = readCarrierMessageIdentity(childUrl);
    const created = host.create(generation, childUrl);
    if (created === null) {
      phase = 'edit';
      await deps.restoreEditSurface();
      return { ok: false, error: { code: 'play-carrier-window-unavailable', hint: 'Play iframe did not expose a contentWindow' } };
    }
    frame = created;
    descriptors = { actions: [], reads: [] };
    host.mount(created, deps.container);
    const source = created.source ?? created.element.contentWindow;
    if (source === null) {
      await stopFrame(true);
      phase = 'edit';
      return { ok: false, error: { code: 'play-carrier-window-unavailable', hint: 'Play iframe did not expose a contentWindow after mount' } };
    }

    const isCurrentFrameSource = (eventSource: MessageEventSource | null): boolean => {
      const current = frame;
      if (current?.generation !== generation) return false;
      // Browser iframe WindowProxy identity can be refreshed by a full-document
      // HMR reload. Resolve contentWindow at delivery time so a response from
      // the current document is not discarded as stale merely because the
      // carrier was created before that navigation.
      const currentSource = current.source ?? current.element.contentWindow;
      return currentSource !== null && eventSource === currentSource;
    };

    unsubscribeFrameMessages = host.subscribe((event) => {
      if (!isCurrentFrameSource(event.source)) return;
      const carrierData = event.data as { type?: unknown; payload?: unknown } | null;
      if (matchesCarrierMessageIdentity(carrierData?.payload, expectedIdentity)) {
        if (carrierData?.type === 'VAG_CARRIER_HEARTBEAT') lastCarrierHeartbeatAt = Date.now();
        if (carrierData?.type === 'VAG_CARRIER_FAILURE' && phase === 'play') {
          const failure = record(record(carrierData.payload)?.failure);
          const code = typeof failure?.code === 'string' ? failure.code : 'renderer-error';
          const hint = typeof failure?.message === 'string'
            ? failure.message
            : typeof failure?.hint === 'string' ? failure.hint : 'Play carrier reported a terminal failure';
          const key = `${code}\n${hint}`;
          if (!terminalFailureReported && reportedFailureKey !== key) {
            terminalFailureReported = true;
            reportedFailureKey = key;
            deps.onFailure?.({ code, hint });
            if (livenessTimer !== undefined) clearInterval(livenessTimer);
            livenessTimer = undefined;
          }
        }
      }
      const parsed = VagFpsStatsSchema.safeParse(event.data);
      if (parsed.success) {
        lastCarrierHeartbeatAt = Date.now();
        deps.onFps?.(parsed.data.payload.fps, generation);
      }
      const gameplay = VagGameplayResponseSchema.safeParse(event.data);
      if (!gameplay.success) return;
      const pending = pendingGameplay.get(gameplay.data.payload.requestId);
      if (!pending) return;
      pendingGameplay.delete(gameplay.data.payload.requestId);
      if (gameplay.data.payload.ok) {
        pending({ ok: true, ...(gameplay.data.payload.data === undefined ? {} : { data: gameplay.data.payload.data }) });
      } else {
        const error = gameplay.data.payload.error;
        pending({ ok: false, error: {
          code: error?.code ?? 'play-gameplay-request-failed',
          hint: error?.hint ?? 'remote Play rejected the gameplay projection request',
          ...(error?.retryable === undefined ? {} : { retryable: error.retryable }),
        } });
      }
    });

    const ready = await new Promise<PlayCarrierResult>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      let unsubscribe = () => {};
      const finish = (result: PlayCarrierResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(result);
      };
      const onMessage = (event: MessageEvent): void => {
        if (!isCurrentFrameSource(event.source)) return;
        const data = event.data as { type?: unknown; payload?: unknown } | null;
        if (!matchesCarrierMessageIdentity(data?.payload, expectedIdentity)) return;
        const payload = record(data?.payload);
        if (data?.type === 'VAG_CARRIER_FAILURE') {
          const failure = record(payload?.failure);
          finish({ ok: false, error: {
            code: typeof failure?.code === 'string' ? failure.code : 'play-carrier-failed',
            hint: typeof failure?.message === 'string'
              ? failure.message
              : typeof failure?.hint === 'string' ? failure.hint : 'Play carrier reported a failure',
          } });
          return;
        }
        if ((data?.type === 'VAG_CARRIER_HEARTBEAT' || data?.type === 'VAG_CARRIER_HANDSHAKE')
          && payload?.renderReadiness === 'ready') {
          deps.onReady?.(payload);
          finish({ ok: true });
        }
      };
      timer = setTimeout(() => finish({
        ok: false,
        error: { code: 'play-carrier-ready-timeout', hint: 'Play iframe did not publish a ready first frame before the deadline' },
      }), deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
      unsubscribe = host.subscribe(onMessage);
    });

    if (!ready.ok) {
      await stopFrame(true);
      phase = 'edit';
      return ready;
    }
    // Descriptor discovery is useful metadata, but it is not a prerequisite
    // for mounting the live Play world. Asset/plugin HMR can reload the child
    // immediately after its first ready frame; making this idempotent lookup a
    // lifecycle gate turns that transient window into a false Play failure.
    phase = 'play';
    lastCarrierHeartbeatAt = Date.now();
    if (deps.livenessTimeoutMs !== false && deps.livenessTimeoutMs !== undefined) {
      const timeoutMs = deps.livenessTimeoutMs;
      const confirmations = Math.max(1, deps.unreachableConfirmations ?? 3);
      const probeIntervalMs = Math.max(250, Math.min(1_000, Math.floor(timeoutMs / 2)));
      // Keep each probe shorter than the tick so a hung server still yields one
      // countable verdict per interval instead of collapsing into one long wait.
      const probeTimeoutMs = Math.max(200, probeIntervalMs - 50);
      livenessTimer = setInterval(() => {
        if (phase !== 'play' || desiredPaused || terminalFailureReported || livenessProbeActive) return;
        // Frame cadence and runtime reachability are independent failures: a
        // carrier renders from already-loaded modules, so it keeps publishing
        // frames long after its runtime server died (HMR, asset loads, and the
        // next Play are all broken by then). Probe reachability on every tick
        // and let the frame clock only decide which failure it is.
        livenessProbeActive = true;
        // A frozen/hung server leaves the request pending forever rather than
        // rejecting it, which would both starve the unreachable counter and pin
        // livenessProbeActive true, silencing every later tick. Bound each probe
        // so "not answering" converges to "unreachable" — to a user, a runtime
        // that never answers is indistinguishable from a dead one.
        void fetch(childUrl, { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(probeTimeoutMs) })
          .then(async (response) => {
            try { await response.body?.cancel(); } catch { /* response cleanup is best effort */ }
            return response.ok;
          })
          .catch(() => false)
          .then((runtimeReachable) => {
            if (phase !== 'play' || desiredPaused || terminalFailureReported) return;
            const framesStalled = Date.now() - lastCarrierHeartbeatAt > timeoutMs;
            if (runtimeReachable) {
              consecutiveUnreachable = 0;
              // Reachable runtime + no frames = the child's renderer died.
              if (!framesStalled) return;
              reportLivenessFailure({
                code: 'renderer-process-terminated',
                hint: 'The Play carrier stopped publishing frames while its runtime URL remained reachable.',
              });
              return;
            }
            // Unreachable: confirm across ticks so one blip is not an outage.
            consecutiveUnreachable += 1;
            if (consecutiveUnreachable < confirmations) return;
            reportLivenessFailure({
              code: 'viewport-runtime-disconnected',
              hint: framesStalled
                ? 'The Play runtime stopped publishing frames and its runtime URL is unreachable.'
                : 'The Play runtime URL became unreachable while the carrier was still rendering already-loaded modules.',
            });
          })
          .finally(() => { livenessProbeActive = false; });
      }, probeIntervalMs);
    }
    void describeGameplayWithRetry();
    postToChild(desiredPaused ? 'VAG_PREVIEW_PAUSE' : 'VAG_PREVIEW_PLAY');
    return { ok: true };
  }

  async function stop(): Promise<PlayCarrierResult> {
    if (phase === 'edit') return { ok: true };
    phase = 'stopping';
    const restored = await stopFrame(true);
    phase = 'edit';
    return restored;
  }

  function captureFrame(frames: number): Promise<unknown> {
    if (phase !== 'play' || frame === null) {
      return Promise.reject({
        code: 'play-carrier-capture-unavailable',
        hint: 'the current Play carrier is not live; do not fall back to the paused Edit carrier',
      });
    }
    const source = frame.source ?? frame.element.contentWindow;
    if (source === null) {
      return Promise.reject({
        code: 'play-carrier-window-unavailable',
        hint: `Play carrier generation ${String(frame.generation)} has no live contentWindow`,
      });
    }
    try {
      const capture = (source as unknown as {
        __forgeax?: { captureFrame?: (count: number) => Promise<unknown> };
      }).__forgeax?.captureFrame;
      if (typeof capture !== 'function') {
        return Promise.reject({
          code: 'rhi-debug-unavailable',
          hint: `Play carrier generation ${String(frame.generation)} did not expose __forgeax.captureFrame`,
        });
      }
      const activeFrame = frame;
      return Promise.resolve().then(async () => {
        const artifact = await capture(frames);
        if (frame !== activeFrame || phase !== 'play' || activeFrame.generation !== nextGeneration) {
          throw { code: 'play-carrier-capture-stale', hint: 'the Play carrier changed while capture was running' };
        }
        if (!isArtifact(artifact)) {
          throw { code: 'play-carrier-capture-invalid', hint: 'the live Play carrier returned no typed capture artifact' };
        }
        const provenance = readCaptureProvenance(source, activeFrame.generation);
        if (provenance === undefined) {
          throw { code: 'play-carrier-provenance-unavailable', hint: 'the live Play carrier did not publish complete renderer and runtime provenance' };
        }
        return Object.freeze({ ...artifact, provenance });
      });
    } catch (error) {
      return Promise.reject({
        code: 'play-carrier-capture-unavailable',
        hint: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    start,
    stop,
    captureFrame,
    pause: () => {
      desiredPaused = true;
      postToChild('VAG_PREVIEW_PAUSE');
    },
    resume: () => {
      desiredPaused = false;
      postToChild('VAG_PREVIEW_PLAY');
    },
    state: () => phase,
    generation: () => nextGeneration,
    gameplayDescriptors: () => descriptors,
    gameplay: requestGameplay,
  };
}
