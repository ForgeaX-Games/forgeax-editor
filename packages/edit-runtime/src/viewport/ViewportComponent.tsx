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
  gateway,
  getSceneId,
  switchSceneFile,
  registerSessionApplier,
  createEvalChannel,
} from '@forgeax/editor-core';
import { WorldManager } from '../world-manager';
import { createViewport, type Viewport } from './viewport';
// M6 extraction (plan-strategy §2 D-5, AC-08): the VAG / console / network /
// diagnostics bridges moved to viewport-vag-bridges.ts (decoupled from the
// createApp hotspot, AC-10). bootViewport keeps only the call sites.
import {
  installFpsReport,
  installConsoleBridge,
  installNetworkBridge,
  installPreviewControls,
  installErrorOverlay,
  paintDiagnosticMessage,
} from './viewport-vag-bridges';
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
            // M4 T4-7 (G-6): route the G button through the one gateway door as a
            // session op, so display toggle is ledger-visible + AI-equivalent.
            gateway.dispatch({ kind: 'setDisplay', display: q.display === 'game' ? 'scene' : 'game' }, 'human');
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

  // ── M4 (w18/w19/w21): world-manager — the super coordination layer ──────────
  // Created BEFORE createApp so its composite drawSource can be handed to the
  // engine frame-loop at boot. It owns the editorWorld (editor camera + gizmo) as
  // a separate engine World from the sceneWorld (= createApp's `world`, doc.world).
  // getSceneWorld reads gateway.doc.world LAZILY each frame (set below, before the
  // frame loop starts) so a scene swap (replaceDoc) is tracked without a second
  // reference to keep in sync (plan-strategy §2 D-5, Derive). editorWorld =
  // new World() here is a LEGAL construction — lint-no-second-world scans the
  // engine submodule diff only (AGENTS.md invariant 4 / research F3).
  const worldManager = new WorldManager(
    () => gateway.doc.world as unknown as import('@forgeax/engine-ecs').World | undefined,
  );
  // M5 (w29, D-4/AC-05): wire the two super seams — selection minting binds new
  // selections to the live (sceneWorld, epoch) pair, and a scene reload bumps the
  // sceneWorld epoch + revalidates the selection (batch invalidation). Registered
  // here (once, at boot) and torn down on realm reset so a cross-game boot starts
  // clean. Without this the handle-pair invalidation is dead — see w23.
  registerTeardown(worldManager.attach());

  // ── Engine boot (was :318). createApp MOVED here (not copied) — net-zero world
  // construction across the M2 diff (lint-no-second-world). ─────────────────────
  // M4 (w21, S6 / AC-07): the composite drawSource feeds [editorWorld, sceneWorld]
  // with cameraOwner=editorWorld / resourceOwner=sceneWorld into the engine
  // frame-loop's draw-source seam (D-3). This is the ONE composite-render wiring —
  // NO self-hosted rAF, NO direct renderer.draw (AC-07): the engine's frame loop
  // pulls drawSource each frame and draws both worlds.
  emitBoot('boot ▸ createApp');
  const app = await createApp(canvas, {
    // Pointer-lock gate: the EDITOR's own backend must NEVER request pointer lock.
    // It exists only for edit-mode orbit/pan/pick + play·scene free-look, all of
    // which use drag deltas (setPointerCapture, D-5) — never a locked cursor.
    //
    // Pointer lock during ▶ Play belongs SOLELY to the game's own play backend
    // (host-boot.ts attachPlayInput), which the game gates per view-mode via
    // ctx.setPointerLockAllowed(mode === 'fps'). Two backends share this one
    // canvas; if the editor backend also locked, it would override the game's
    // top-down/FPS decision — the exact bug where a top-down game locked the
    // cursor and threw on the next click (setPointerCapture-while-locked /
    // "lock cannot be acquired immediately after exit"). The old
    // `getInputTarget() === 'game'` predicate here was a pre-#78 leftover from
    // when the editor had a single backend that WAS the game backend during
    // play; after the world-fork split added a separate play backend it became
    // wrong. Always-deny is correct: the editor never consumes lock.
    pointerLockAllowed: () => false,
    // Composite two-world render: editorWorld (camera) + sceneWorld (resources).
    drawSource: worldManager.createDrawSource(),
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
  // The createApp world IS the sceneWorld (authored content, save's only source —
  // plan-strategy §2 D-2). doc.world lifecycle unchanged.
  //
  // D-7 (M6): no EditMode resource is injected here anymore. After M4 forked
  // editorWorld from sceneWorld, the sceneWorld's authored data carries no game
  // systems (game systems only exist in the transient playWorld built by
  // play-assemble), so there is nothing to "freeze" in edit mode — the old
  // injectEditMode(world, true) + notEditing gate was the "register + freeze"
  // shape that D-7 replaces with structural registration-surface removal.
  gateway.doc.world = world;
  gateway.doc.registry = renderer.assets;

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

  // editor orbit camera (was :531). Not part of the authored doc. M4 (w19, S4 /
  // AC-01): the editor camera now lives in the editorWorld — it is spawned through
  // world-manager's DEDICATED EngineFacade (worldManager.editorFacade), NOT the
  // gateway facade (which binds to the sceneWorld / doc.world). This is the
  // structural half of AC-01: the camera can never land in the sceneWorld because
  // the only write path onto editorWorld is this facade (plan-strategy §2 D-2/D-5).
  const aspect = canvas.width / canvas.height || 1;
  const cameraEntity = worldManager.editorFacade.spawn(
    { component: Transform, data: { pos: [0, 1.5, 9] } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 3, aspect }), tonemap: TONEMAP_REINHARD_EXTENDED, clearR: 0.42, clearG: 0.55, clearB: 0.78 } },
  ).unwrap();
  setEditorCameraEntity(cameraEntity as unknown as number);

  // viewport interaction: orbit/pan/zoom, click-to-select, drag-to-move (was :591).
  // M4 (w19/w20): the viewport receives TWO facades — `editorEngine`
  // (worldManager.editorFacade, for camera + gizmo writes onto editorWorld) and
  // `engine` (gateway facade, for sceneWorld reads via the drag/pick path). The
  // camera entity handle belongs to the editorWorld.
  const viewport = createViewport({
    canvas,
    engine: gateway.engineFacade(),
    editorEngine: worldManager.editorFacade,
    assets: renderer.assets as never,
    camera: cameraEntity,
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

  // possess-exit key removed (keyboard-router convergence M4 T4-7 / AC-Cb1): G /
  // Esc display-toggle now lives in the single global-shortcuts router
  // (interface submodule global-shortcuts.ts). Dispatching setDisplay through the
  // gateway makes display toggle ledger-visible + AI-equivalent (G-6), and the
  // router's play·game guard yields G to the game (T0-10 / RK-10).
  //
  // MERGE NOTE (main #96): main added a local `onPossessKey` here as a hotfix for
  // "no keyboard exit from edit·game (ViewportBar hidden → user stuck)". The
  // convergence SUPERSEDES that local handler: the global-shortcuts router catches
  // G/Esc for BOTH edit·game and play·game and dispatches setDisplay → the
  // registerSessionApplier('setDisplay') below applies scene⇄game. Keeping the
  // local handler too would double-handle the key, so it is intentionally dropped.

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

  // M4 T4-6 (G-6): setDisplay is a SESSION-domain op — display toggle (scene⇄game)
  // is ledger-visible + AI-equivalent, symmetric to play/stop. The router (and the
  // ViewportBar / GameOverlay G buttons) dispatch it; the real quadrant mutation
  // lives here in edit-runtime (DAG downstream — core stays headless, RK-11).
  const unregSetDisplay = registerSessionApplier('setDisplay', (op) => {
    const { display } = op as { display: 'scene' | 'game' };
    setViewportQuadrant({ display });
    return { ok: true };
  });
  registerTeardown(() => { unregSetDisplay(); });

  // game camera discovery now that the scene is loaded (was :695).
  discoverGameCameraFromWorld();
  applyActiveCamera();

  // Expose the viewport quadrant SSOT for out-of-frame scripting (was :503).
  (window as unknown as Record<string, unknown>).__forgeax_editor = {
    app: editorApp, world, renderer, gateway, switchScene: switchSceneFile,
    playSimulation: () => actionsRef.current.playSimulation(),
    stopSimulation: () => actionsRef.current.stopSimulation(),
    getViewportQuadrant, setViewportQuadrant, onViewportQuadrantChange,
    // M5 (w29): expose the super coordination layer so out-of-frame scripts (AC-02
    // e2e) can witness the separate editorWorld (camera + gizmo) + query bindings.
    worldManager,
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
