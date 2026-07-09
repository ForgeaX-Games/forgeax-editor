// ViewportComponent — the in-process engine viewport surface (plan-strategy
// REPLAN D8; q2 viewport boundary; AC-04 single-realm).
//
// WHAT THIS IS
//   D8 extracted the ENGINE-SURFACE half of the 1652-line main.tsx bootEditor()
//   closure into this mount-on-canvas React component so the :15290 host can
//   render the viewport IN-PROCESS (no /editor iframe). Responsibilities (the q2
//   "viewport" boundary): canvas creation, createApp (MOVED, not copied — net-
//   zero world construction so lint-no-second-world stays green), world/renderer
//   unpack, gateway.doc.world/registry injection, pack-index configure, the editor
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
  gateway,
  getSceneId,
  switchSceneFile,
  broadcastAssetsChanged,
  registerSessionApplier,
  createEvalChannel,
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
import { CommandPalette } from '../panels/command-palette';
import { configureHostSession, resolveEditPhysics, initHostSession, type HostSession } from '../host-boot';
import '../theme.css';

// ── single-boot latch (AC-04) — the engine boots exactly once per document ─────
let bootStarted = false;

// ── per-boot teardown registry (single-realm multi-game host) ──────────────────
// The standalone editor boots once and tears down only by page navigation, so it
// never needs these. A MULTI-game host (studio single-realm) switches games at
// runtime; because the physics backend + pack roots are bound once at createApp,
// a cross-game switch must DESTROY this realm (GPU device + world + session +
// window listeners) and re-boot fresh. bootViewport pushes each per-boot teardown
// handle here; resetEditRealm() runs them LIFO, disposes the engine, and clears
// the latch so the next mount re-boots. Everything a boot installs GLOBALLY and
// engine-scoped must register here or it leaks/duplicates across a switch.
const teardownFns: Array<() => void> = [];
function registerTeardown(fn: () => void): void {
  teardownFns.push(fn);
}

/**
 * Tear down the current in-process editor realm for a deliberate cross-game
 * switch (studio single-realm host). Runs every per-boot teardown handle (window
 * listeners, quadrant subscriptions, host-session disk-watch/beacons), disposes
 * the engine app (app.stop() → renderer.dispose() releases the WebGPU device),
 * and resets the single-boot latch so the next <ViewportComponent> mount boots a
 * fresh engine for the new game.
 *
 * MUST be called deliberately (on game switch) — NEVER on a StrictMode unmount,
 * or dev double-mount would tear down the live realm. The single-game standalone
 * host never calls this (its teardown is a full page navigation, AC-04).
 */
export function resetEditRealm(): void {
  // Run per-boot teardown LIFO (reverse install order) so late-installed handles
  // that depend on earlier ones unwind first. Swallow individual failures so one
  // bad teardown can't strand the rest (a half-torn realm wedges the next boot).
  for (let i = teardownFns.length - 1; i >= 0; i--) {
    try { teardownFns[i]!(); } catch (e) { console.warn('[editor] resetEditRealm teardown step failed:', e); }
  }
  teardownFns.length = 0;
  // Drop the global handle so nothing keeps the dead app/world/renderer alive.
  try { delete (window as unknown as Record<string, unknown>).__forgeax_editor; } catch { /* non-config */ }
  bootStarted = false;
}

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
  const [paletteOpen, setPaletteOpen] = useState(false);

  // ── Global Cmd+K / Ctrl+K — toggle the command palette (M4, w9) ──────────────
  // Owned by the viewport overlay layer so the palette can open from closed state
  // (command-palette.tsx's internal hook could only close, never open — open is a
  // parent-owned state). Same discipline as the possess-exit key handler in
  // bootViewport: skip when an input/textarea/select/contentEditable is focused
  // so the user can still type 'k' in panels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (bootStarted) return;
    bootStarted = true;
    const container = containerRef.current;
    if (!container) return;

    void bootViewport(container, actionsRef, setFpsState);
    // No cleanup returned: the viewport lifecycle is NOT managed by React.
    // Standalone teardown = page navigation. Multi-game host teardown =
    // resetEditRealm() which runs registerTeardown() handles (viewport.dispose
    // is registered inside bootViewport). Returning a cleanup here would let
    // StrictMode's dev double-mount dispose the viewport immediately after
    // boot resolves (the disposed-flag race condition).
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
          // M3 (AC-02, D-11): ▶/■ go through the one gateway door as session ops.
          // The play/stop appliers (registered at boot below) route back to
          // actionsRef.current, so the button and an AI `gateway.dispatch({kind:'play'},
          // 'ai')` are the same action. Defined here (the single callback source
          // shared by ViewportBar + GameOverlay) so both surfaces dispatch uniformly.
          onPlay={() => gateway.dispatch({ kind: 'play' })}
          onStop={() => gateway.dispatch({ kind: 'stop' })}
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

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
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
  // the Assets panel's ContentBrowser throws PATH_RESOLVER_NOT_SET.
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
  gateway.doc.world = world;
  gateway.doc.registry = renderer.assets;
  injectEditMode(world, true);

  void renderer.ready.then((r: { ok: boolean; error?: { code?: string; expected?: unknown; hint?: string; detail?: unknown } }) => {
    if (!r.ok) console.error('[editor] renderer.ready err:', r.error?.code, r.error?.expected, r.error?.hint, r.error?.detail);
  });

  // resize — ResizeObserver on the container so dock-panel drags (which do NOT
  // fire `window resize`) still update the canvas backing store + camera aspect.
  // The observer is already batched by the browser (once per frame), so no rAF
  // throttle is needed; the skip-when-unchanged guard prevents redundant GPU
  // swapchain rebuilds (canvas.width assignment invalidates the current texture
  // even when the value is the same on WebKit). Math.round is required because
  // non-integer DPR produces fractional px that canvas truncates — without
  // rounding the comparison would fail every frame, triggering a full
  // render-graph recompile. `onContainerResize` is late-bound so
  // viewport.refresh() can be wired after createViewport below.
  let onContainerResize: (() => void) | null = null;
  const syncCanvasSize = (): void => {
    const d = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round((container.clientWidth || 1) * d);
    const h = Math.round((container.clientHeight || 1) * d);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    onContainerResize?.();
  };
  const resizeObserver = new ResizeObserver(syncCanvasSize);
  resizeObserver.observe(container);
  registerTeardown(() => resizeObserver.disconnect());

  // editor orbit camera (was :531). Not part of the authored doc. M3 t21 (S4 /
  // AC-04): the boot camera spawn is view scaffolding — it goes through the
  // core-minted EngineFacade (the write gate), not the raw world. gateway.doc.world
  // was injected just above, so engineFacade() binds to the live world.
  const aspect = canvas.width / canvas.height || 1;
  const cameraEntity = gateway.engineFacade().spawn(
    { component: Transform, data: { posY: 1.5, posZ: 9 } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 3, aspect }), tonemap: TONEMAP_REINHARD_EXTENDED, clearR: 0.42, clearG: 0.55, clearB: 0.78 } },
  ).unwrap();
  setEditorCameraEntity(cameraEntity as unknown as number);

  // viewport interaction: orbit/pan/zoom, click-to-select, drag-to-move (was :591).
  // M3 t16 (S4 / AC-05): the viewport receives the core-minted EngineFacade (the
  // sole controlled write proxy), NOT the raw world. gateway.doc.world was
  // injected just above, so engineFacade() binds to the live world.
  const viewport = createViewport({
    canvas, engine: gateway.engineFacade(), assets: renderer.assets as never, camera: cameraEntity,
    getInputTarget,
  });
  // Wire viewport.refresh() into the container ResizeObserver created above so
  // the editor camera projection + gizmo track the new aspect ratio on every
  // container resize (dock-panel drags + window resizes).
  onContainerResize = () => viewport.refresh();
  registerTeardown(() => { try { viewport.dispose(); } catch { /* already disposed */ } });

  // M5 t32 (plan-strategy §2 D-4 Q-5): mount eval channel on globalThis in DEV
  // builds only. AI CLI accesses it via playwright page.evaluate — zero new
  // network surface (OOS-9). Production builds do NOT get this hook — the AI
  // eval channel is dev-only (AC-02 scope② production lock).
  // D-4: the host (edit-runtime) injects rawScope ONLY in DEV so unlockRawScope()
  // can grant scope② raw engine access here; production omits rawScope entirely
  // → unlockRawScope() returns SCOPE_LOCKED. Without this the DEV channel would
  // report scope② permanently locked, contradicting SKILL.md (verify F-V3).
  if (import.meta.env.DEV) {
    const channel = createEvalChannel(gateway, {
      rawScope: { world, renderer, assets: renderer.assets },
    });
    (globalThis as Record<string, unknown>).__forgeaxEval = channel;
  }

  // game-view-exit key (was :617). Esc / G exits display='game' back to 'scene'
  // for ANY run mode: play·game -> play·scene (un-possess) AND edit·game ->
  // edit·scene. `run` is left untouched (orthogonal-axis contract). Without the
  // edit·game case there was no keyboard exit: entering game view from Edit hides
  // the ViewportBar (its G button) and only leaves the barely-discoverable
  // GameOverlay hover, so the user could get stuck with no aids and no toolbar.
  function onPossessKey(e: KeyboardEvent): void {
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
    const q = getViewportQuadrant();
    if (q.display !== 'game') return;
    const k = e.key;
    if (k === 'Escape' || k === 'g' || k === 'G') setViewportQuadrant({ display: 'scene' });
  }
  window.addEventListener('keydown', onPossessKey, { capture: true });
  registerTeardown(() => window.removeEventListener('keydown', onPossessKey, { capture: true } as EventListenerOptions));

  // play·scene non-commit (was :638). transientMode true exactly in play·scene.
  function syncTransientMode(q: { run: string; display: string }): void {
    gateway.transientMode = q.run === 'play' && q.display === 'scene';
  }
  syncTransientMode(getViewportQuadrant());
  registerTeardown(onViewportQuadrantChange(syncTransientMode));

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
  registerTeardown(onViewportQuadrantChange(() => applyActiveCamera()));

  // display bus <-> quadrant bridge (was :892).
  _syncDisplayMode(getViewportQuadrant().display);
  registerTeardown(onViewportQuadrantChange((q) => _syncDisplayMode(q.display)));

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
      // M2: the shared canvas + resolved physics backend feed ▶ Play's fresh-world
      // assembly (play-assemble). play attaches its own input backend to this
      // canvas and mirrors the edit assembly's physics plugin (D-1/D-7).
      canvas,
      physics: editPhysics,
    });
  } catch (err) {
    console.error('[editor] host session init failed:', err);
    session = { playSimulation: () => {}, stopSimulation: () => {}, dispose: () => {} };
  }
  // Tear the host session down (disk-watch socket, flush beacons, VAG flush) on a
  // cross-game realm reset, flushing any pending save first.
  registerTeardown(() => session.dispose());

  // Wire the deferred ▶/■ chrome actions now that the lifecycle exists (was :505).
  actionsRef.current = {
    playSimulation: () => { setViewportQuadrant({ run: 'play', display: 'game' }); session.playSimulation(); },
    stopSimulation: () => { session.stopSimulation(); setViewportQuadrant({ run: 'edit', display: 'scene' }); },
  };

  // ── D-11 (plan-strategy §2): register the REAL play/stop session appliers ────
  // play·stop are session-domain ops whose state machine lives here in edit-runtime
  // (DAG downstream — core must not import it). Registering them into core's
  // sessionAppliers table (injection direction edit-runtime→core, same shape as the
  // ApiClient seam) is exactly what makes them SESSION-domain ops (D-1: domain =
  // registration site). They route through actionsRef.current so an op-driven
  // play/stop is byte-for-byte the same action the ▶/■ button fires (AC-02 human=AI
  // parity, including the implicit active-op cancel the gateway performs before any
  // session op runs — D-2 interrupt). Registered here, AFTER actionsRef is wired, so
  // a dispatch that arrives at the gateway always finds a live applier (before this
  // point the gateway would legitimately return UNKNOWN_OP — headless form). The
  // returned unregister fns run on teardown to avoid leaking a stale applier across
  // a cross-game realm reset.
  const unregPlay = registerSessionApplier('play', () => { actionsRef.current.playSimulation(); return { ok: true }; });
  const unregStop = registerSessionApplier('stop', () => { actionsRef.current.stopSimulation(); return { ok: true }; });
  registerTeardown(() => { unregPlay(); unregStop(); });

  // game camera discovery now that the scene is loaded (was :695).
  discoverGameCameraFromWorld();
  applyActiveCamera();

  // Expose the viewport quadrant SSOT for out-of-frame scripting (was :503).
  (window as unknown as Record<string, unknown>).__forgeax_editor = {
    app: editorApp, world, renderer, gateway, switchScene: switchSceneFile,
    playSimulation: () => actionsRef.current.playSimulation(),
    stopSimulation: () => actionsRef.current.stopSimulation(),
    getViewportQuadrant, setViewportQuadrant, onViewportQuadrantChange,
  };

  // start the live render loop + reporters (was :895).
  editorApp.start();
  // Cross-game teardown: stop the rAF loop + release the WebGPU device (app.stop()
  // chains into renderer.dispose()'s GPU-lifecycle cascade, feat-20260612-rhi-
  // destroy-renderer-dispose-gpu-lifecycle) and drop the canvas so the next boot
  // starts from a clean container. Registered LAST so it runs FIRST on teardown
  // (LIFO) — freeze the engine before unwinding the listeners it drove.
  registerTeardown(() => {
    try { editorApp.stop(); } catch (e) { console.warn('[editor] editorApp.stop() failed:', e); }
    try { canvas.remove(); } catch { /* already detached */ }
  });
  installFpsReport(editorApp, onFps);
  registerTeardown(installAssetSpawnBridge());
  registerTeardown(installPreviewControls(editorApp));
  registerTeardown(installErrorOverlay(container));
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

// These two bridges monkeypatch process-global surfaces (console methods,
// window.fetch / XHR.prototype / WebSocket) that hold NO engine references, so
// they survive a cross-game realm reset untouched. Guard them install-once — a
// second install after resetEditRealm would double-wrap console.error (duplicate
// VAG frames) and re-wrap an already-wrapped fetch. They intentionally do NOT
// register teardown; they are document-lifetime, not per-boot.
let consoleBridgeInstalled = false;
let networkBridgeInstalled = false;

function installConsoleBridge(): void {
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

function installNetworkBridge(): void {
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
// cycle: the re-broadcast is itself a VAG_ASSETS_CHANGED that reaches this same
// handler (self-origin is allowed), so without this flag it would loop forever.
let refreshingCatalog = false;

function installPreviewControls(editorApp: { pause(): void; resume(): void }): () => void {
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
        // fresh data we re-fire the event AFTER the refresh lands, guarded by a
        // module flag so this handler's own re-fire doesn't recurse forever
        // (allowedParentOrigins includes self.origin, so self-posts reach here).
        if (refreshingCatalog) return;
        const reg = gateway.doc.registry;
        if (reg?.refreshCatalog) {
          refreshingCatalog = true;
          void reg.refreshCatalog().finally(() => {
            refreshingCatalog = false;
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
function installErrorOverlay(container: HTMLElement): () => void {
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
