// viewport-runtime-bridges.ts — the console / network / diagnostics bridges
// factored out of ViewportComponent.tsx (M6 / AC-08 / plan-strategy §2 D-5).
//
// WHAT THIS IS
//   ViewportComponent.tsx had grown to ~800 lines because the whole set of
//   process-global bridges — the FPS reporter, in-process console/network
//   diagnostics, visibility pause, the render-error overlay, and the createApp-
//   failure diagnostic panel —
//   lived inline below the boot sequence. This file lifts that cohesive cluster out;
//   ViewportComponent.tsx keeps the React component + the engine boot sequence
//   (bootViewport) and imports these installers.
//
// WHY THIS IS DECOUPLED FROM THE createApp HOTSPOT (AC-10)
//   The sister loop world-partition semantically rewrites the createApp WIRING
//   (ViewportComponent.tsx:269 — how the booted world is threaded into the editor
//   session via a super world handle). None of the bridges below touch that wiring:
//   they monkeypatch document-lifetime globals (console/fetch/XHR/WebSocket),
//   emit typed in-process diagnostics, and paint DOM overlays. Moving them OUT
//   of ViewportComponent.tsx therefore REDUCES the controlled-intersection surface
//   rather than adding to it — bootViewport keeps only the call sites (verbatim),
//   and world-partition's rewrite stays confined to the world-handle seam it owns.
//
// OOS-1 / OOS-3 (zero behavior change, no semantic rewrite)
//   The original bridge bodies were moved VERBATIM from ViewportComponent.tsx
//   (installFpsReport, installConsoleBridge, installNetworkBridge,
//   installAssetCatalogRefresh, installErrorOverlay, paintDiagnosticMessage + the
//   install-once module flags). The later single-realm visibility helper also lives
//   here. Only the location changed; the
//   camera pose write, the createApp wiring, and the pick path (the three
//   world-partition rewrite points) stay in viewport.ts / ViewportComponent.tsx.
//
// Anchors:
//   (forward) plan-strategy feat-20260709-editor-large-file-di-decompose-wave2-c-domain-scen
//     plan-id; AC-05 (zero behavior) + AC-08 (edit-runtime max_file_loc drop) +
//     AC-07 (bidirectional anchors) + AC-10 (viewport three-file controlled
//     intersection — extracted off the createApp hotspot) + OOS-3 (no semantic
//     rewrite); plan-strategy §2 D-5 (M6 tail) + §8 naming (install<Thing>).
//   (backward) these bridges were split out of main.tsx bootEditor into
//     ViewportComponent.tsx during the REPLAN D8 in-process viewport landing; the
//     Cross-realm play telemetry remains in editor-core protocol.ts; this file is
//     the in-process edit-runtime bridge set.

import { gateway, panelBridge, broadcastAssetsChanged } from '@forgeax/editor-core';
import { Time, Update, type World } from '@forgeax/engine-ecs';
import { setFps } from '../fps-store';

// ── FPS report ────────────────────────────────────────────────────────────────
export function installFpsReport(
  world: World,
  onFps: (fps: number) => void,
): void {
  let frames = 0, accum = 0;
  world.addSystem(Update, {
    name: 'editor-fps-report',
    queries: [],
    fn: () => {
      const dt = world.getResource(Time).delta;
      frames++; accum += dt;
      if (accum >= 1) {
        const fps = Math.round(frames / accum);
        setFps(fps);   // feed the shared fps-store (GameOverlay reads it too)
        onFps(fps);    // feed this component's local state (ViewportChrome prop)
        frames = 0; accum = 0;
      }
    },
  }).unwrap();
}

// These two bridges monkeypatch process-global surfaces (console methods,
// window.fetch / XHR.prototype / WebSocket) that hold NO engine references, so
// they survive a cross-game realm reset untouched. Guard them install-once — a
// second install after resetEditRealm would double-wrap console.error (duplicate
// diagnostics) and re-wrap an already-wrapped fetch. They intentionally do NOT
// register teardown; they are document-lifetime, not per-boot.
let consoleBridgeInstalled = false;
let networkBridgeInstalled = false;

export function installConsoleBridge(): void {
  if (consoleBridgeInstalled) return;
  consoleBridgeInstalled = true;
  (['log', 'warn', 'error', 'info', 'debug'] as const).forEach((level) => {
    const original = (console[level] as (...a: unknown[]) => void).bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        const text = args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
        panelBridge.emit('editorConsole', { level, text, ts: Date.now() });
      } catch { /* cross-origin */ }
    };
  });
  window.addEventListener('error', (ev) => {
    panelBridge.emit('editorConsole', { level: 'error', text: `${ev.message}\n  at ${ev.filename}:${ev.lineno}`, ts: Date.now() });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    panelBridge.emit('editorConsole', { level: 'error', text: `unhandled rejection: ${String(ev.reason)}`, ts: Date.now() });
  });
}

export function installNetworkBridge(): void {
  if (networkBridgeInstalled) return;
  networkBridgeInstalled = true;
  const send = (kind: 'fetch' | 'xhr' | 'ws', method: string, url: string, status: number, ms: number, ok: boolean): void => {
    panelBridge.emit('editorNetwork', {
      kind,
      method,
      url: String(url).slice(0, 2048),
      status,
      ms: Math.round(ms),
      ok,
      ts: Date.now(),
    });
  };
  const origFetch = window.fetch?.bind(window);
  if (origFetch) {
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const t0 = performance.now();
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET') ?? 'GET').toUpperCase();
      try {
        const res = await origFetch(input as RequestInfo, init);
        send('fetch', method, url, res.status, performance.now() - t0, res.ok);
        return res;
      } catch (e) {
        send('fetch', method, url, 0, performance.now() - t0, false);
        throw e;
      }
    }) as typeof fetch;
  }
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (this: XMLHttpRequest & { __fxN?: { m: string; u: string; t0: number } }, method: string, url: string, ...rest: unknown[]) {
      this.__fxN = { m: String(method).toUpperCase(), u: String(url), t0: 0 };
      // @ts-expect-error variadic passthrough
      return origOpen.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (this: XMLHttpRequest & { __fxN?: { m: string; u: string; t0: number } }, body?: Document | XMLHttpRequestBodyInit | null) {
      const n = this.__fxN;
      if (n) {
        n.t0 = performance.now();
        this.addEventListener('loadend', () => send('xhr', n.m, n.u, this.status, performance.now() - n.t0, this.status >= 200 && this.status < 400));
      }
      return origSend.call(this, body as Document);
    };
  }
  const OrigWS = window.WebSocket;
  if (OrigWS) {
    const WSProxy = function (this: unknown, url: string | URL, protocols?: string | string[]) {
      const t0 = performance.now();
      const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
      const u = typeof url === 'string' ? url : url.href;
      ws.addEventListener('open', () => send('ws', 'WS', u, 101, performance.now() - t0, true));
      ws.addEventListener('error', () => send('ws', 'WS', u, 0, performance.now() - t0, false));
      ws.addEventListener('close', () => send('ws', 'WS', u, 0, performance.now() - t0, false));
      return ws;
    } as unknown as typeof WebSocket;
    WSProxy.prototype = OrigWS.prototype;
    Object.defineProperty(WSProxy, 'CONNECTING', { value: OrigWS.CONNECTING });
    Object.defineProperty(WSProxy, 'OPEN', { value: OrigWS.OPEN });
    Object.defineProperty(WSProxy, 'CLOSING', { value: OrigWS.CLOSING });
    Object.defineProperty(WSProxy, 'CLOSED', { value: OrigWS.CLOSED });
    window.WebSocket = WSProxy;
  }
}

// Re-entrancy guard for the assetsChanged → refreshCatalog → re-broadcast cycle.
// The post-refresh broadcast reaches this same PanelBridge listener synchronously.
// A plain boolean would be cleared before emission and recurse forever; instead we
// count the self-echoes we owe. Every refresh emits exactly one echo and every
// receipt with a positive counter consumes one, so refreshes and echoes stay 1:1.
let pendingCatalogRefires = 0;

/** Refresh the engine catalog after a pack change, then notify panels once the
 * refreshed view is ready. This is an in-process PanelBridge listener: asset
 * mutation already happened through gateway operations; this is notification-only. */
export function installAssetCatalogRefresh(): () => void {
  return panelBridge.on('assetsChanged', ({ hint }) => {
    // D5 (O2): directory-only hint means no pack files changed — skip the
    // expensive refreshCatalog() and the echo broadcast entirely.
    if (hint === 'directory-only') return;
    if (pendingCatalogRefires > 0) {
      pendingCatalogRefires -= 1;
      return;
    }
    // A newly imported asset wrote a fresh pack-index on disk, but the registry
    // cached the pre-import index at boot and only re-fetches on a per-GUID miss.
    // Refresh now so Content Browser listCatalog + later loadByGuid see it.
    //
    // Do NOT call invalidateAll() here. `assetsChanged` is also a UI-notify
    // signal after boot and after a SceneInstance mount; neither changes asset
    // bytes. Clearing the payload catalogue at that point leaves existing
    // MaterialAsset shared refs alive while their texture GUIDs no longer resolve
    // in RenderSystem.extract, so every material silently binds 1x1 fallbacks.
    // A real reimport must invalidate its affected GUID explicitly at the asset
    // mutation boundary, rather than treating this broad notification as a cache
    // eviction command.
    const reg = gateway.doc.registry;
    if (reg?.refreshCatalog) {
      void reg.refreshCatalog().finally(() => {
        pendingCatalogRefires += 1;
        broadcastAssetsChanged();
      });
    }
  });
}

// ── Visibility-driven pause (single-realm) ──────────────────────────────────
// The host (studio SurfaceKeepAliveLayer) parks the viewport off-screen +
// visibility:hidden when its dock tab is inactive. This observer watches the
// viewport's OWN container and pauses the render loop directly — no cross-realm
// control message.
//
//   - IntersectionObserver: fires when the container leaves/enters the viewport
//     (off-screen parking trips it).
//   - document visibilitychange: covers tab/window backgrounding (the observer
//     alone doesn't fire when the whole document is hidden).
//
// Play-mode awareness (D-2 dual-App mutual exclusion):
//   During ▶ Play, editorApp is paused and playApp drives the sole rAF. If the
//   viewport is hidden and then shown, this must NOT resume editorApp (that would
//   break the D-2 invariant — two Apps driving one renderer). Instead:
//     hide  → pause the ACTIVE app (editorApp in edit, playApp in play)
//     show  → resume the ACTIVE app only
//   getPlayApp returns the live playApp handle during play, null in edit mode.
//
// Guards against IntersectionObserver being absent (jsdom/older runtimes): the
// visibilitychange listener still installs. Returns a disposer for cross-game
// teardown (registered via registerTeardown at boot).
export function installVisibilityPause(
  container: HTMLElement,
  editorApp: { pause(): void; resume(): void },
  getPlayApp?: () => { pause(): void; resume(): void } | null,
): () => void {
  let hiddenByViewport = false;
  let hiddenByDocument = false;
  const apply = (): void => {
    const shouldHide = hiddenByViewport || hiddenByDocument;
    const playApp = getPlayApp?.() ?? null;
    if (shouldHide) {
      if (playApp !== null) playApp.pause();
      else editorApp.pause();
    } else {
      if (playApp !== null) playApp.resume();
      else editorApp.resume();
    }
  };

  let io: IntersectionObserver | null = null;
  if (typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver((entries) => {
      const visible = entries.some((e) => e.isIntersecting);
      hiddenByViewport = !visible;
      apply();
    });
    io.observe(container);
  }

  const onVisibility = (): void => {
    hiddenByDocument = document.visibilityState === 'hidden';
    apply();
  };
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    try { io?.disconnect(); } catch { /* already gone */ }
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/** Returns a disposer that restores console.error, removes the window listeners,
 *  and drops the overlay box — so a cross-game realm reset doesn't stack another
 *  console.error wrapper (each stack layer duplicates output) or leak listeners. */
export function installErrorOverlay(container: HTMLElement): () => void {
  // Task 2 (render-system-no-camera timing race): 500 ms startup grace window.
  // During boot the render loop may tick before the editorWorld camera entity
  // is spawned — suppress the red error banner for render-system-no-camera
  // during that window (console.warn is still emitted so the log is preserved).
  const bootTime = Date.now();
  const GRACE_MS = 500;

  const box = document.createElement('div');
  // Keep the diagnostic panel below the viewport toolbar. WebGPU init failures
  // are intentionally visible (and the smoke suite allows the expected driver
  // noise), but an error banner beginning at top:8px sat on top of ▶ and made
  // Play impossible to click on SwiftShader runners.
  box.style.cssText = 'position:absolute;top:48px;left:8px;right:8px;max-height:45%;overflow:auto;z-index:99999;'
    + 'background:rgba(140,10,10,0.94);color:#fff;font:12px/1.45 ui-monospace,monospace;padding:10px 12px;'
    + 'border-radius:6px;white-space:pre-wrap;display:none;pointer-events:auto;box-shadow:0 2px 12px rgba(0,0,0,.5)';
  container.appendChild(box);
  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss editor render error');
  close.title = 'Dismiss editor render error';
  close.style.cssText = [
    'position:sticky', 'top:0', 'float:right', 'margin:-4px -4px 6px 10px',
    'width:24px', 'height:24px', 'border:1px solid rgba(255,255,255,.35)',
    'border-radius:4px', 'background:rgba(255,255,255,.12)', 'color:#fff',
    'display:inline-grid', 'place-items:center', 'padding:0', 'cursor:pointer',
  ].join(';');
  close.innerHTML = [
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"',
    ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    '<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>',
    '</svg>',
  ].join('');
  const body = document.createElement('div');
  box.append(close, body);
  const seen = new Set<string>();
  let count = 0;
  let dismissedSeenSize = 0;
  close.addEventListener('click', () => {
    dismissedSeenSize = seen.size;
    box.style.display = 'none';
  });
  const stringifyArg = (x: unknown): string => {
    if (x instanceof Error) {
      const d = (x as unknown as { detail?: unknown }).detail;
      return x.message + (d !== undefined ? ` | detail=${(() => { try { return JSON.stringify(d); } catch { return String(d); } })()}` : '');
    }
    return typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })();
  };
  const show = (text: string): void => {
    // React duplicate-key warnings match /error/ but are not GPU/render failures.
    // Keep them in the console; do not paint the red viewport banner.
    if (/two children with the same key/i.test(text)) return;
    if (!/error|rhi|fail|exception|unsupported|invalid|adapter|gpu/i.test(text)) return;
    // Grace-period suppression for render-system-no-camera: if a transient boot
    // gap lets the renderer tick before camera spawn completes, skip the banner
    // but keep the console.warn below so the event is still traceable.
    if (/render-system-no-camera/.test(text) && Date.now() - bootTime < GRACE_MS) {
      console.warn('[editor] suppressed startup transient: render-system-no-camera');
      return;
    }
    if (seen.has(text) || seen.size > 40) return;
    seen.add(text);
    if (seen.size > dismissedSeenSize) box.style.display = 'block';
    body.textContent = `⚠ editor render error (${++count}):\n` + [...seen].join('\n');
  };
  const origErr = console.error.bind(console);
  const wrappedErr = (...a: unknown[]): void => { origErr(...a); try { show(a.map(stringifyArg).join(' ')); } catch { /* */ } };
  console.error = wrappedErr;
  const onError = (ev: ErrorEvent): void => {
    const stack = (ev.error as Error | undefined)?.stack;
    show(`window error: ${ev.message} @ ${ev.filename}:${ev.lineno}\n${stack ?? ''}`);
  };
  const onRejection = (ev: PromiseRejectionEvent): void => {
    const reason = ev.reason;
    const stack = (reason as { stack?: string } | undefined)?.stack;
    show(`unhandled rejection: ${String(reason)}\n${stack ?? '(no stack)'}`);
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    // Only restore if still ours — a later install may have re-wrapped it.
    if (console.error === wrappedErr) console.error = origErr;
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    try { box.remove(); } catch { /* already gone */ }
  };
}

export function paintDiagnosticMessage(container: HTMLElement, err: unknown): void {
  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:absolute', 'inset:0', 'display:flex', 'align-items:center', 'justify-content:center',
    'background:#1a1a1f', 'color:#ff8a8a', 'font:14px/1.5 ui-monospace,monospace',
    'padding:24px', 'box-sizing:border-box', 'z-index:1', 'white-space:pre-wrap', 'text-align:left',
  ].join(';');
  const lines: string[] = [
    '⚠ forgeax editor: engine init failed',
    '',
    `createApp error: ${err instanceof Error ? err.message : String(err)}`,
  ];
  const e = err as Record<string, unknown> | null;
  const detail = e && typeof e === 'object' ? (e.detail as Record<string, unknown> | undefined) : undefined;
  function dumpInner(label: string, re: unknown): void {
    if (!re || typeof re !== 'object') return;
    const r = re as Record<string, unknown>;
    lines.push('', `── ${label} ──`);
    if (r.message) lines.push(`message:  ${String(r.message)}`);
    if (r.code) lines.push(`code:     ${String(r.code)}`);
    if (r.expected) lines.push(`expected: ${String(r.expected)}`);
    if (r.hint) lines.push(`hint:     ${String(r.hint)}`);
    if (r.detail !== undefined) {
      try { lines.push(`detail:   ${JSON.stringify(r.detail)}`); }
      catch { lines.push(`detail:   ${String(r.detail)}`); }
    }
  }
  if (detail) {
    dumpInner('webgpu (Channel 2)', detail.webgpuError);
    dumpInner('wgpu (Channel 3 fallback)', detail.wgpuError);
  }
  const hasInner = !!(detail && (detail.webgpuError || detail.wgpuError));
  if (!hasInner) {
    lines.push('', 'Likely causes:', '  • No GPU adapter (headless VM without GPU)', '  • Insecure context (WebGPU needs HTTPS or localhost)', '  • iframe permissions policy blocking WebGPU');
  }
  overlay.textContent = lines.join('\n');
  container.appendChild(overlay);
}
