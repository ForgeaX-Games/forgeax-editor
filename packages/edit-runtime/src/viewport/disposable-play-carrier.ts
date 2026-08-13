import { VagFpsStatsSchema } from '@forgeax/editor-core/protocol';

export interface DisposablePlayFrame {
  readonly generation: number;
  /** Browser iframes acquire their WindowProxy only after mount; native hosts may provide it at create time. */
  readonly source: WindowProxy | null;
  readonly element: HTMLIFrameElement;
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
  pause(): void;
  resume(): void;
  state(): 'edit' | 'entering-play' | 'play' | 'stopping';
  generation(): number;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;

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

  const postToChild = (type: 'VAG_PREVIEW_PAUSE' | 'VAG_PREVIEW_PLAY'): void => {
    const current = frame;
    if (current === null) return;
    const source = current.source ?? current.element.contentWindow;
    try { source?.postMessage({ type }, '*'); } catch { /* child removal is authoritative */ }
  };

  async function stopFrame(restore: boolean): Promise<PlayCarrierResult> {
    const current = frame;
    frame = null;
    unsubscribeFrameMessages();
    unsubscribeFrameMessages = () => {};
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
    const created = host.create(generation, deps.url(generation));
    if (created === null) {
      phase = 'edit';
      await deps.restoreEditSurface();
      return { ok: false, error: { code: 'play-carrier-window-unavailable', hint: 'Play iframe did not expose a contentWindow' } };
    }
    frame = created;
    host.mount(created, deps.container);
    const source = created.source ?? created.element.contentWindow;
    if (source === null) {
      await stopFrame(true);
      phase = 'edit';
      return { ok: false, error: { code: 'play-carrier-window-unavailable', hint: 'Play iframe did not expose a contentWindow after mount' } };
    }

    unsubscribeFrameMessages = host.subscribe((event) => {
      if (event.source !== source || frame?.generation !== generation) return;
      const parsed = VagFpsStatsSchema.safeParse(event.data);
      if (parsed.success) deps.onFps?.(parsed.data.payload.fps, generation);
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
        if (event.source !== source || frame?.generation !== generation) return;
        const data = event.data as { type?: unknown; payload?: { renderReadiness?: unknown; failure?: { code?: unknown; hint?: unknown } | null } } | null;
        if (data?.type === 'VAG_CARRIER_FAILURE') {
          finish({ ok: false, error: {
            code: typeof data.payload?.failure?.code === 'string' ? data.payload.failure.code : 'play-carrier-failed',
            hint: typeof data.payload?.failure?.hint === 'string' ? data.payload.failure.hint : 'Play carrier reported a failure',
          } });
          return;
        }
        if ((data?.type === 'VAG_CARRIER_HEARTBEAT' || data?.type === 'VAG_CARRIER_HANDSHAKE')
          && data.payload?.renderReadiness === 'ready') {
          deps.onReady?.(data.payload);
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
    phase = 'play';
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

  return {
    start,
    stop,
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
  };
}
