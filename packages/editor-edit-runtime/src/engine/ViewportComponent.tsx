// ViewportComponent — the in-process engine viewport surface (plan-strategy
// REPLAN D8; q2 viewport boundary; AC-04 single-realm).
//
// WHAT THIS IS
//   D8 extracted the ENGINE-SURFACE half of the 1652-line main.tsx bootEditor()
//   closure into this mount-on-canvas React component so the :15290 host can
//   render the viewport IN-PROCESS (no /editor iframe). Responsibilities (the q2
//   "viewport" boundary): canvas creation, createApp (MOVED, not copied — net-
//   zero world construction so lint-no-second-world stays green), world/renderer
//   unpack, bus.doc.world/registry injection, pack-index configure, the editor
//   orbit camera, createViewport (orbit/pan/zoom/pick/gizmo), resize +
//   game-camera discovery + active-camera wiring, the VAG console/network/error/
//   preview bridges, and the FPS report. The APPLICATION SESSION tail (seed,
//   scene load, ▶ Play run-lifecycle, skylight, preloads, mesh-stats, preview-
//   skin, sync, disk-watch) lives in host-boot.ts and runs on the world this
//   component boots (initHostSession).
//
// SINGLE-BOOT LATCH (AC-04)
//   React StrictMode double-invokes effects in dev; a naive effect would boot the
//   engine TWICE (two WebGPU devices, two worlds). A module-level latch enforces
//   "engine boots exactly once" — the literal AC-04 invariant. The standalone
//   host mounts this once; edit-runtime's main.tsx also mounts it once.
//
// WHY IT OWNS ITS DOM
//   In-process there is no index.html #app/#ui scaffold, so the component renders
//   its own layered container: a full-size <canvas> under a click-through overlay
//   layer that hosts ViewportChrome (ViewportBar / GameOverlay). Same pointer-
//   events discipline as edit-runtime/index.html (#ui pointer-events:none;
//   interactive chrome opts back in).
//
// Anchors: plan-strategy S2 D8 (ViewportComponent = canvas+world+renderer+camera+
// interaction, createApp moved), S4 R3 (net-zero world ctor), requirements C-1
// (single world), AC-04 (engine boots once in host), AC-12 (active-camera cut).

import { useEffect, useRef, useState } from 'react';
import {
  Transform,
  Camera,
  perspective,
  TONEMAP_REINHARD_EXTENDED,
  setActiveCamera,
} from '@forgeax/engine-runtime';
import { Entity } from '@forgeax/engine-ecs';
import { createApp } from '@forgeax/engine-app';
import { physicsPlugin } from '@forgeax/engine-physics';
import { INPUT_BACKEND_KEY, INPUT_SNAPSHOT_RESOURCE_KEY } from '@forgeax/engine-input';
import {
  sendVagMessage,
  onVagMessage,
  allowedParentOrigins,
  VagConsoleSchema,
  VagNetworkSchema,
  VagFpsStatsSchema,
} from '@forgeax/editor-core/protocol';
import {
  bus,
  getSceneId,
  switchSceneFile,
  broadcastAssetsChanged,
} from '@forgeax/editor-core';
import { injectEditMode } from '@forgeax/editor-core';
import { createViewport, type Viewport } from './viewport';
import {
  getInputTarget,
  getViewportQuadrant,
  setViewportQuadrant,
  onViewportQuadrantChange,
  setEditorCameraEntity,
  setGameCameraEntity,
  deriveActiveCameraEntity,
} from './viewport-quadrant';
import { _syncDisplayMode } from './display-bus';
import { setFps } from '../fps-store';
import { installAssetSpawnBridge } from '../asset-spawn-bridge';
import { ViewportChrome } from '../ViewportChrome';
import { configureHostSession, resolveEditPhysics, initHostSession, type HostSession } from '../host-boot';
import '../theme.css';

// ── single-boot latch (AC-04) — the engine boots exactly once per document ─────
let bootStarted = false;

// ── boot breadcrumb + dead-boot watchdog (was main.tsx :56-108) ───────────────
function emitBoot(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  try {
    window.parent?.postMessage(
      { type: 'forgeax:health', level, source: 'edit', code: 'boot', message, ts: Date.now() },
      '*',
    );
  } catch { /* no parent / cross-origin — overlay still covers the user */ }
}

interface BootFns {
  playSimulation: () => void;
  stopSimulation: () => void;
}

/**
 * The in-process editor viewport. Boots the forgeax engine on a self-owned
 * canvas and drives the full editor session (via host-boot). Renders nothing
 * until mounted; all engine work runs in the mount effect behind the single-boot
 * latch. Standalone injects this as DockShell's renderEdit; edit-runtime's thin
 * main.tsx mounts it directly.
 */
export function ViewportComponent(): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [fps, setFpsState] = useState(0);
  // Deferred ▶/■ actions — wired once host-boot returns the run lifecycle. The
  // chrome mounts immediately (usable even if WebGPU is slow); its callbacks
  // resolve through this holder so they don't close over undefined references.
  const actionsRef = useRef<BootFns>({ playSimulation: () => {}, stopSimulation: () => {} });

  useEffect(() => {
    if (bootStarted) return;
    bootStarted = true;
    const container = containerRef.current;
    if (!container) return;
    let viewport: Viewport | null = null;
    let disposed = false;

    void bootViewport(container, actionsRef, setFpsState).then((vp) => {
      if (disposed) { vp?.dispose(); return; }
      viewport = vp;
    });

    return () => {
      disposed = true;
      viewport?.dispose();
      // NOTE: we do NOT reset bootStarted — a single document boots the engine
      // once (AC-04). StrictMode's dev double-mount is exactly what the latch
      // guards; the real teardown is a full page navigation.
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="ep-viewport-root"
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: '#16161a' }}
    >
      {/* The overlay layer for ViewportChrome. Click-through by default so
          viewport clicks reach the canvas; interactive chrome opts back in. */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <ViewportChrome
          fps={fps}
          onPlay={() => actionsRef.current.playSimulation()}
          onStop={() => actionsRef.current.stopSimulation()}
          onToggleDisplay={() => {
            const q = getViewportQuadrant();
            setViewportQuadrant({ display: q.display === 'game' ? 'scene' : 'game' });
          }}
          onFullscreen={() => {
            const slug = getSceneId();
            const url = slug && slug !== 'default' ? `/preview/?game=${encodeURIComponent(slug)}` : '/preview/';
            window.open(url, '_blank', 'noopener');
          }}
        />
      </div>
    </div>
  );
}

// ── boot sequence (was main.tsx bootEditor viewport half) ─────────────────────
async function bootViewport(
  container: HTMLDivElement,
  actionsRef: React.MutableRefObject<BootFns>,
  onFps: (fps: number) => void,
): Promise<Viewport | null> {
  const BASE = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');

  // Configure the session from URL params (scene id + game->disk path resolver +
  // scene manifest) BEFORE anything reads a game file. In the single-realm host
  // this is the ONLY place it runs (no edit-runtime iframe did it first); shared
  // with edit-runtime's thin main.tsx so the two hosts can't drift. Without this
  // the Assets panel's ContentBrowserV2 throws PATH_RESOLVER_NOT_SET.
  await configureHostSession();

  // canvas (was :185-191) — owned by this component, full-size, behind the overlay.
  // single-realm (feat-20260703): id="app" so a game's bootstrap (which does
  // `querySelector('#app')` for aspect / pointer-lock target / pick rect — see
  // templates/game-default/main.ts) resolves the SAME canvas the engine renders
  // to. Under the old iframe arch edit-runtime/index.html provided a static
  // <div id="app"> host; collapsing to the single realm removed that markup, so
  // ▶ Play crashed on `querySelector('#app')!.clientWidth` (null). Tagging the
  // real canvas is more correct than a stray empty #app div — pointer-lock and
  // click-pick both need the actual rendered surface, not a hidden placeholder.
  const canvas = document.createElement('canvas');
  canvas.id = 'app';
  canvas.style.cssText = 'position:absolute;inset:0;display:block;width:100%;height:100%';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = (container.clientWidth || window.innerWidth) * dpr;
  canvas.height = (container.clientHeight || window.innerHeight) * dpr;
  container.insertBefore(canvas, container.firstChild);

  installConsoleBridge();
  installNetworkBridge();

  // physics gate (host-boot.resolveEditPhysics — must precede createApp).
  const editPhysics = await resolveEditPhysics();

  // ── Engine boot (was :318). createApp MOVED here (not copied) — net-zero world
  // construction across the M2 diff (lint-no-second-world). ─────────────────────
  emitBoot('boot ▸ createApp');
  const app = await createApp(canvas, {
    // Pointer-lock gate: only the play·game quadrant captures the cursor.
    pointerLockAllowed: () => getInputTarget() === 'game',
    ...(editPhysics ? { plugins: [physicsPlugin(editPhysics)] } : {}),
  }, {
    shaderManifestUrl: `${BASE}/shaders/manifest.json`,
    importTransport: {
      async fetchPack(guid: string) {
        const importBase = (typeof __FORGEAX_GAME_DIR_ABS__ === 'string' && __FORGEAX_GAME_DIR_ABS__)
          ? `${BASE}/__import` : '/__import';
        try {
          const response = await fetch(`${importBase}/${guid}`, { method: 'POST' });
          if (!response.ok) return { ok: false };
          try {
            const body = await response.json();
            if (Array.isArray(body)) return { ok: true, entries: body };
          } catch { /* empty/non-JSON body */ }
          return { ok: true };
        } catch {
          return { ok: false };
        }
      },
    },
  });
  if (!app.ok) {
    console.error('[editor] createApp failed:', app.error);
    paintDiagnosticMessage(container, app.error);
    return null;
  }
  const editorApp = app.value;
  const { world, renderer } = editorApp;

  // pack-index catalog for loadByGuid (was :389).
  const sceneSlug = getSceneId();
  const selfHostPack = typeof __FORGEAX_GAME_DIR_ABS__ === 'string' && !!__FORGEAX_GAME_DIR_ABS__;
  const packIndexUrl = (!selfHostPack && sceneSlug && sceneSlug !== 'default')
    ? `/preview/pack-index/${sceneSlug}.json`
    : `${BASE}/pack-index.json`;
  renderer.assets.configurePackIndex(packIndexUrl);

  // Inject the engine World + AssetRegistry into the editor session (was :410).
  // No new World() — single-world model (C-1).
  bus.doc.world = world;
  bus.doc.registry = renderer.assets;
  injectEditMode(world, true);

  void renderer.ready.then((r: { ok: boolean; error?: { code?: string; expected?: unknown; hint?: string; detail?: unknown } }) => {
    if (!r.ok) console.error('[editor] renderer.ready err:', r.error?.code, r.error?.expected, r.error?.hint, r.error?.detail);
  });

  // resize (was :521). Track the container, not the window.
  const onResize = (): void => {
    const d = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = (container.clientWidth || window.innerWidth) * d;
    canvas.height = (container.clientHeight || window.innerHeight) * d;
  };
  window.addEventListener('resize', onResize);

  // editor orbit camera (was :531). Not part of the authored doc.
  const aspect = canvas.width / canvas.height || 1;
  const cameraEntity = world.spawn(
    { component: Transform, data: { posY: 1.5, posZ: 9 } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 3, aspect }), tonemap: TONEMAP_REINHARD_EXTENDED, clearR: 0.42, clearG: 0.55, clearB: 0.78 } },
  ).unwrap();
  setEditorCameraEntity(cameraEntity as unknown as number);

  // viewport interaction: orbit/pan/zoom, click-to-select, drag-to-move (was :591).
  const viewport = createViewport({
    canvas, world: world as never, assets: renderer.assets as never, camera: cameraEntity,
    getInputTarget,
  });
  window.addEventListener('resize', () => viewport.refresh());

  // possess-exit key (was :617). Esc / G un-possesses play·game -> play·scene.
  function onPossessKey(e: KeyboardEvent): void {
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
    const q = getViewportQuadrant();
    if (q.run !== 'play' || q.display !== 'game') return;
    const k = e.key;
    if (k === 'Escape' || k === 'g' || k === 'G') setViewportQuadrant({ display: 'scene' });
  }
  window.addEventListener('keydown', onPossessKey, { capture: true });

  // play·scene non-commit (was :638). transientMode true exactly in play·scene.
  function syncTransientMode(q: { run: string; display: string }): void {
    bus.transientMode = q.run === 'play' && q.display === 'scene';
  }
  syncTransientMode(getViewportQuadrant());
  onViewportQuadrantChange(syncTransientMode);

  // active-camera derivation (was :658-710). Game-camera discovery walks the live
  // world archetype graph for the first non-editor Camera entity.
  const discoverGameCameraFromWorld = (): void => {
    interface ArchCam { columns: Map<number, Map<string, { view: Uint32Array }>>; size: number }
    interface WorldGraph { _getGraph: () => { archetypes: ArchCam[] } }
    const graph = (world as unknown as WorldGraph)._getGraph();
    const editorCam = cameraEntity as unknown as number;
    for (const arch of graph.archetypes) {
      if (!arch.columns.has(Camera.id)) continue;
      const selfCol = arch.columns.get(Entity.id)?.get('self');
      if (!selfCol) continue;
      for (let row = 0; row < arch.size; row++) {
        const packed = selfCol.view[row]!;
        if (packed !== 0 && (packed as unknown as number) !== editorCam) {
          setGameCameraEntity(packed as unknown as number);
          return;
        }
      }
    }
  };
  const applyActiveCamera = (): void => {
    const camEnt = deriveActiveCameraEntity();
    if (camEnt !== undefined) setActiveCamera(world as never, camEnt as unknown as number);
  };
  applyActiveCamera();
  onViewportQuadrantChange(() => applyActiveCamera());

  // display bus <-> quadrant bridge (was :892).
  _syncDisplayMode(getViewportQuadrant().display);
  onViewportQuadrantChange((q) => _syncDisplayMode(q.display));

  // ── run the application session tail on this world (host-boot, D8) ──────────
  let session: HostSession;
  try {
    session = await initHostSession({
      app: editorApp as never,
      world: world as never,
      renderer: renderer as never,
      cameraEntity: cameraEntity as unknown as number,
      viewport,
      viewportContainer: container,
      emitBoot,
      setBootStage: (s: string) => emitBoot(`boot ▸ ${s}`),
      discoverGameCameraFromWorld,
      applyActiveCamera,
    });
  } catch (err) {
    console.error('[editor] host session init failed:', err);
    session = { playSimulation: () => {}, stopSimulation: () => {} };
  }

  // Wire the deferred ▶/■ chrome actions now that the lifecycle exists (was :505).
  actionsRef.current = {
    playSimulation: () => { setViewportQuadrant({ run: 'play', display: 'game' }); session.playSimulation(); },
    stopSimulation: () => { session.stopSimulation(); setViewportQuadrant({ run: 'edit', display: 'scene' }); },
  };

  // game camera discovery now that the scene is loaded (was :695).
  discoverGameCameraFromWorld();
  applyActiveCamera();

  // Expose the viewport quadrant SSOT for out-of-frame scripting (was :503).
  (window as unknown as Record<string, unknown>).__forgeax_editor = {
    app: editorApp, world, renderer, bus, switchScene: switchSceneFile,
    playSimulation: () => actionsRef.current.playSimulation(),
    stopSimulation: () => actionsRef.current.stopSimulation(),
    getViewportQuadrant, setViewportQuadrant, onViewportQuadrantChange,
  };

  // start the live render loop + reporters (was :895).
  editorApp.start();
  installFpsReport(editorApp, onFps);
  installAssetSpawnBridge();
  installPreviewControls(editorApp);
  installErrorOverlay(container);
  emitBoot('boot ✓ ready');

  // game input-chain liveness breadcrumb (was :919). createApp already wired the
  // DOM->InputBackend->InputSnapshot chain; verify + report, do NOT re-attach.
  {
    const liveWorld = world as unknown as { hasResource(key: string): boolean };
    const hasBackend = liveWorld.hasResource(INPUT_BACKEND_KEY);
    requestAnimationFrame(() => {
      const hasSnapshot = liveWorld.hasResource(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (hasBackend && hasSnapshot) emitBoot('input ▸ game input chain live');
      else emitBoot(`input ▸ game input chain incomplete (backend=${hasBackend} snapshot=${hasSnapshot})`, 'warn');
    });
  }

  return viewport;
}

// ── VAG bridges (moved verbatim from main.tsx) ────────────────────────────────
function installFpsReport(editorApp: { registerUpdate(fn: (dt: number) => void): void }, onFps: (fps: number) => void): void {
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

function installConsoleBridge(): void {
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

function installNetworkBridge(): void {
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

function installPreviewControls(editorApp: { pause(): void; resume(): void }): void {
  onVagMessage(window, {
    allowedOrigins: allowedParentOrigins(),
    handlers: {
      VAG_PREVIEW_PAUSE: () => editorApp.pause(),
      VAG_PREVIEW_PLAY: () => editorApp.resume(),
      VAG_PREVIEW_RELOAD: () => location.reload(),
      VAG_SPAWN_ENTITY: (msg) => {
        const p = msg.payload;
        if (p.mode === 'reference' && isSpawnRef(p.entity)) {
          bus.dispatch({ kind: 'spawnEntity', name: p.entity.name, components: p.entity.components });
        } else if (p.mode === 'full' && isSpawnDoc(p.doc)) {
          const spawnDoc = p.doc;
          const spawnEnts = spawnDoc.entities;
          const cmds = spawnDoc.order.map((id) => {
            const ent = spawnEnts[id]!;
            return { kind: 'spawnEntity' as const, name: ent.name, parent: ent.parent ?? undefined, components: ent.components };
          });
          bus.dispatch({ kind: 'transaction', label: `Import: ${p.name ?? 'GLB'}`, commands: cmds });
        } else {
          console.warn('[edit] VAG_SPAWN_ENTITY: malformed entity/doc payload — ignored');
          return;
        }
        broadcastAssetsChanged();
      },
      VAG_ASSETS_CHANGED: () => broadcastAssetsChanged(),
    },
  });
}

function installErrorOverlay(container: HTMLElement): void {
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
  console.error = (...a: unknown[]): void => { origErr(...a); try { show(a.map(stringifyArg).join(' ')); } catch { /* */ } };
  window.addEventListener('error', (ev) => {
    const stack = (ev.error as Error | undefined)?.stack;
    show(`window error: ${ev.message} @ ${ev.filename}:${ev.lineno}\n${stack ?? ''}`);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = (ev as PromiseRejectionEvent).reason;
    const stack = (reason as { stack?: string } | undefined)?.stack;
    show(`unhandled rejection: ${String(reason)}\n${stack ?? '(no stack)'}`);
  });
}

function paintDiagnosticMessage(container: HTMLElement, err: unknown): void {
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
