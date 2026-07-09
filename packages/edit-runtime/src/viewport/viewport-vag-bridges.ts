// viewport-vag-bridges.ts — the VAG / console / network / diagnostics bridges
// factored out of ViewportComponent.tsx (M6 / AC-08 / plan-strategy §2 D-5).
//
// WHAT THIS IS
//   ViewportComponent.tsx had grown to ~800 lines because the whole set of
//   process-global bridges — the FPS reporter, the console/network monkeypatch
//   bridges that forward to the parent frame over VAG, the preview-control message
//   handler, the render-error overlay, and the createApp-failure diagnostic panel —
//   lived inline below the boot sequence. This file lifts that cohesive cluster out;
//   ViewportComponent.tsx keeps the React component + the engine boot sequence
//   (bootViewport) and imports these installers.
//
// WHY THIS IS DECOUPLED FROM THE createApp HOTSPOT (AC-10)
//   The sister loop world-partition semantically rewrites the createApp WIRING
//   (ViewportComponent.tsx:269 — how the booted world is threaded into the editor
//   session via a super world handle). None of the bridges below touch that wiring:
//   they monkeypatch document-lifetime globals (console/fetch/XHR/WebSocket), post
//   VAG frames to window.parent, and paint DOM overlays. Moving them OUT of
//   ViewportComponent.tsx therefore REDUCES the controlled-intersection surface
//   rather than adding to it — bootViewport keeps only the call sites (verbatim),
//   and world-partition's rewrite stays confined to the world-handle seam it owns.
//
// OOS-1 / OOS-3 (zero behavior change, no semantic rewrite)
//   Every body here is moved VERBATIM from ViewportComponent.tsx (installFpsReport,
//   installConsoleBridge, installNetworkBridge, installPreviewControls,
//   installErrorOverlay, paintDiagnosticMessage, and the isSpawnRef/isSpawnDoc
//   shape guards + the install-once module flags). Only the location changed; the
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
//     VAG protocol seam itself is the editor-core protocol.ts SSOT (16 VAG_* schemas).

import {
  sendVagMessage,
  onVagMessage,
  allowedParentOrigins,
  VagConsoleSchema,
  VagNetworkSchema,
  VagFpsStatsSchema,
} from '@forgeax/editor-core/protocol';
import { gateway, broadcastAssetsChanged } from '@forgeax/editor-core';
import { setFps } from '../fps-store';

// ── FPS report ────────────────────────────────────────────────────────────────
export function installFpsReport(
  editorApp: { registerUpdate(fn: (dt: number) => void): void },
  onFps: (fps: number) => void,
): void {
  let frames = 0, accum = 0;
  editorApp.registerUpdate((dt: number) => {
    frames++; accum += dt;
    if (accum >= 1) {
      const fps = Math.round(frames / accum);
      sendVagMessage(window.parent, VagFpsStatsSchema, { fps });
      setFps(fps);   // feed the shared fps-store (GameOverlay reads it too)
      onFps(fps);    // feed this component's local state (ViewportChrome prop)
      frames = 0; accum = 0;
    }
  });
}

// These two bridges monkeypatch process-global surfaces (console methods,
// window.fetch / XHR.prototype / WebSocket) that hold NO engine references, so
// they survive a cross-game realm reset untouched. Guard them install-once — a
// second install after resetEditRealm would double-wrap console.error (duplicate
// VAG frames) and re-wrap an already-wrapped fetch. They intentionally do NOT
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
        sendVagMessage(window.parent, VagConsoleSchema, { level, text, ts: Date.now() });
      } catch { /* cross-origin */ }
    };
  });
  window.addEventListener('error', (ev) => {
    try {
      sendVagMessage(window.parent, VagConsoleSchema, { level: 'error', text: `${ev.message}\n  at ${ev.filename}:${ev.lineno}`, ts: Date.now() });
    } catch { /* cross-origin */ }
  });
  window.addEventListener('unhandledrejection', (ev) => {
    try {
      sendVagMessage(window.parent, VagConsoleSchema, { level: 'error', text: `unhandled rejection: ${String(ev.reason)}`, ts: Date.now() });
    } catch { /* cross-origin */ }
  });
}

export function installNetworkBridge(): void {
  if (networkBridgeInstalled) return;
  networkBridgeInstalled = true;
  const send = (kind: 'fetch' | 'xhr' | 'ws', method: string, url: string, status: number, ms: number, ok: boolean): void => {
    try {
      sendVagMessage(window.parent, VagNetworkSchema, { kind, method, url: String(url).slice(0, 2048), status, ms: Math.round(ms), ok, ts: Date.now() });
    } catch { /* cross-origin */ }
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

// Shape guards for VAG_SPAWN_ENTITY (schema declares entity/doc as z.unknown()).
type SpawnRef = { name: string; components: Record<string, unknown> };
type SpawnDoc = {
  order: number[];
  entities: Record<number, { name: string; parent: number | null; components: Record<string, unknown> }>;
};
function isSpawnRef(x: unknown): x is SpawnRef {
  const r = x as SpawnRef | null;
  return !!r && typeof r === 'object' && typeof r.name === 'string'
    && typeof r.components === 'object' && r.components !== null;
}
function isSpawnDoc(x: unknown): x is SpawnDoc {
  const d = x as SpawnDoc | null;
  return !!d && typeof d === 'object'
    && Array.isArray(d.order) && d.order.every((n) => typeof n === 'number')
    && typeof d.entities === 'object' && d.entities !== null;
}

// Re-entrancy guard for the VAG_ASSETS_CHANGED → refreshCatalog → re-broadcast
// cycle: the post-refresh re-broadcast is itself a VAG_ASSETS_CHANGED that
// reaches this same handler (self-origin is allowed). A plain boolean that is
// cleared BEFORE the re-broadcast fails — the self-post arrives after the flag
// is already down and re-triggers refreshCatalog → re-broadcast → infinite loop
// (each turn also fires the panel's /api/files/tree fetch, exhausting the vite
// proxy's ephemeral ports → EADDRNOTAVAIL flood). Instead we COUNT the self-fires
// we still owe: every started refresh emits exactly one re-broadcast on
// completion (++), and every receipt that finds the counter positive is that
// echo (── and return, no refresh). Refreshes and echoes stay paired 1:1, so the
// cycle can never self-sustain even if a genuine change lands mid-refresh.
let pendingCatalogRefires = 0;

export function installPreviewControls(editorApp: { pause(): void; resume(): void }): () => void {
  return onVagMessage(window, {
    allowedOrigins: allowedParentOrigins(),
    handlers: {
      VAG_PREVIEW_PAUSE: () => editorApp.pause(),
      VAG_PREVIEW_PLAY: () => editorApp.resume(),
      VAG_PREVIEW_RELOAD: () => location.reload(),
      VAG_SPAWN_ENTITY: (msg) => {
        const p = msg.payload;
        if (p.mode === 'reference' && isSpawnRef(p.entity)) {
          gateway.dispatch({ kind: 'spawnEntity', name: p.entity.name, components: p.entity.components });
        } else if (p.mode === 'full' && isSpawnDoc(p.doc)) {
          const spawnDoc = p.doc;
          const spawnEnts = spawnDoc.entities;
          const cmds = spawnDoc.order.map((id) => {
            const ent = spawnEnts[id]!;
            return { kind: 'spawnEntity' as const, name: ent.name, parent: ent.parent ?? undefined, components: ent.components };
          });
          gateway.dispatch({ kind: 'transaction', label: `Import: ${p.name ?? 'GLB'}`, commands: cmds });
        } else {
          console.warn('[edit] VAG_SPAWN_ENTITY: malformed entity/doc payload — ignored');
          return;
        }
        broadcastAssetsChanged();
      },
      VAG_ASSETS_CHANGED: () => {
        // A newly imported asset wrote a fresh pack-index on disk, but the
        // registry cached the pre-import index at boot and only re-fetches on a
        // per-GUID miss — so the new scene/mesh GUIDs are absent from listCatalog
        // (Content Browser shows nothing new until reload) AND unresolvable by
        // loadByGuid (Add to Scene silently no-ops per spawn-asset-ref.ts:162).
        // refreshCatalog() re-fetches the whole index NOW so the panel's next
        // synchronous listCatalog() and the subsequent Add-to-Scene loadByGuid
        // both see the new asset — no page reload needed. The panel is a separate
        // VAG_ASSETS_CHANGED listener that reloads from listCatalog; to hand it
        // fresh data we re-fire the event AFTER the refresh lands (self-posts
        // reach here because allowedParentOrigins includes self.origin).
        //
        // Swallow our own post-refresh echo (see pendingCatalogRefires above):
        // if we owe an echo, THIS is it — consume it and stop, or we'd loop.
        if (pendingCatalogRefires > 0) {
          pendingCatalogRefires -= 1;
          return;
        }
        const reg = gateway.doc.registry;
        if (reg?.refreshCatalog) {
          void reg.refreshCatalog().finally(() => {
            // Owe exactly one echo, then fire it: panels reload from the now-
            // fresh catalog; the echo returns to us above and is consumed.
            pendingCatalogRefires += 1;
            broadcastAssetsChanged();
          });
        }
      },
    },
  });
}

/** Returns a disposer that restores console.error, removes the window listeners,
 *  and drops the overlay box — so a cross-game realm reset doesn't stack another
 *  console.error wrapper (each stack layer duplicates output) or leak listeners. */
export function installErrorOverlay(container: HTMLElement): () => void {
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;top:8px;left:8px;right:8px;max-height:45%;overflow:auto;z-index:99999;'
    + 'background:rgba(140,10,10,0.94);color:#fff;font:12px/1.45 ui-monospace,monospace;padding:10px 12px;'
    + 'border-radius:6px;white-space:pre-wrap;display:none;pointer-events:none;box-shadow:0 2px 12px rgba(0,0,0,.5)';
  container.appendChild(box);
  const seen = new Set<string>();
  let count = 0;
  const stringifyArg = (x: unknown): string => {
    if (x instanceof Error) {
      const d = (x as unknown as { detail?: unknown }).detail;
      return x.message + (d !== undefined ? ` | detail=${(() => { try { return JSON.stringify(d); } catch { return String(d); } })()}` : '');
    }
    return typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })();
  };
  const show = (text: string): void => {
    if (!/error|rhi|fail|exception|unsupported|invalid|adapter|gpu/i.test(text)) return;
    if (seen.has(text) || seen.size > 40) return;
    seen.add(text);
    box.style.display = 'block';
    box.textContent = `⚠ editor render error (${++count}):\n` + [...seen].join('\n');
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
