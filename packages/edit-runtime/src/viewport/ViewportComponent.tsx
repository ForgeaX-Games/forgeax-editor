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
//   game-camera discovery + active-camera wiring, in-process diagnostics /
//   visibility bridges, and the FPS report. The APPLICATION SESSION tail (seed,
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
import { Entity, getRegisteredSystems } from '@forgeax/engine-ecs';
import { createApp } from '@forgeax/engine-app';
import {
  attachBrowserInputBackend,
  createCanvasInputBoundary,
  INPUT_BACKEND_KEY,
  INPUT_SNAPSHOT_RESOURCE_KEY,
} from '@forgeax/engine-input';
import {
  gateway,
  panelBridge,
  getSceneId,
  getSelection,
  entComponents,
  switchSceneFile,
  registerSessionApplier,
  createEvalChannel,
} from '@forgeax/editor-core';
import { WorldManager } from '../world-manager';
import { createViewport, type Viewport } from './viewport';
import { installColliderDebugOverlay } from './collider-debug-overlay';
// M6 extraction (plan-strategy §2 D-5, AC-08): console / network / diagnostics
// bridges moved to viewport-runtime-bridges.ts (decoupled from the createApp
// hotspot, AC-10). bootViewport keeps only the call sites.
import {
  installFpsReport,
  installConsoleBridge,
  installNetworkBridge,
  installAssetCatalogRefresh,
  installVisibilityPause,
  installErrorOverlay,
  paintDiagnosticMessage,
} from './viewport-runtime-bridges';
import {
  getInputTarget,
  getViewportQuadrant,
  setViewportQuadrant,
  onViewportQuadrantChange,
  setEditorCameraEntity,
  setGameCameraEntity,
  deriveActiveCameraEntity,
} from './viewport-quadrant';
import { _syncDisplayMode, isAuxVisible } from './display-bus';
import { installAssetSpawnBridge, installViewportDropZone } from '../asset-spawn-bridge';
import { ViewportChrome } from '../ViewportChrome';
import { CommandPalette } from '../panels/command-palette';
import { configureHostSession, resolveEditPhysics, initHostSession, type HostSession, type HostGameSession } from '../host-boot';
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
let currentResetOptions: ResetEditRealmOptions = {};
function registerTeardown(fn: () => void): void {
  teardownFns.push(fn);
}

export interface ResetEditRealmOptions {
  readonly flushPendingSave?: boolean;
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
export function resetEditRealm(options: ResetEditRealmOptions = {}): void {
  const previousResetOptions = currentResetOptions;
  currentResetOptions = options;
  // Run per-boot teardown LIFO (reverse install order) so late-installed handles
  // that depend on earlier ones unwind first. Swallow individual failures so one
  // bad teardown can't strand the rest (a half-torn realm wedges the next boot).
  try {
    for (let i = teardownFns.length - 1; i >= 0; i--) {
      try { teardownFns[i]!(); } catch (e) { console.warn('[editor] resetEditRealm teardown step failed:', e); }
    }
  } finally {
    currentResetOptions = previousResetOptions;
  }
  teardownFns.length = 0;
  // Drop the global handle so nothing keeps the dead app/world/renderer alive.
  try { delete (window as unknown as Record<string, unknown>).__forgeax_editor; } catch { /* non-config */ }
  bootStarted = false;
}

// ── boot breadcrumb + dead-boot watchdog (was main.tsx :56-108) ───────────────
function emitBoot(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  panelBridge.emit('editorHealth', { level, code: 'boot', message, ts: Date.now() });
}

interface BootFns {
  playSimulation: () => void;
  stopSimulation: () => void;
}

/**
 * The active game the host wants this viewport to boot. The host is the single
 * source of truth for "which game" (editor standalone: CLI `--game`; studio: the
 * server active-slug) and passes it as props — NOT via `?scene=`/`?gameRoot=` URL
 * params. The single-realm collapse removed the editor iframe that URL params used
 * to address, so hosts inject the game directly. Omitted / { slug: null } = no
 * game (opens on an empty scene).
 */
export interface ViewportComponentProps {
  /** Scene/game pointer. null or 'default' = no on-disk game (empty scene). */
  readonly gameSlug?: string | null;
  /** Host game->disk layout root. Required when gameSlug names a real game. */
  readonly gameRoot?: string;
  /** Host-owned asset catalog URL for this game. */
  readonly packIndexUrl?: string;
  /** Host-selected initial SceneAsset GUID. Omitted = forge.json defaultScene. */
  readonly selectedSceneGuid?: string;
}

/**
 * The in-process editor viewport. Boots the forgeax engine on a self-owned
 * canvas and drives the full editor session (via host-boot). Renders nothing
 * until mounted; all engine work runs in the mount effect behind the single-boot
 * latch. Standalone injects this as DockShell's renderEdit; edit-runtime's thin
 * main.tsx mounts it directly. The host passes the active game via props.
 */
export function ViewportComponent({
  gameSlug = null,
  gameRoot,
  packIndexUrl,
  selectedSceneGuid,
}: ViewportComponentProps = {}): React.ReactElement {
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

    void bootViewport(container, actionsRef, setFpsState, {
      slug: gameSlug,
      gameRoot,
      packIndexUrl,
      selectedSceneGuid,
    });
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
          onControlGame={() => gateway.dispatch({ kind: 'grantGameControl' }, 'human')}
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
  gameSession: HostGameSession,
): Promise<Viewport | null> {
  const BASE = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');

  // Configure the session (scene id + game->disk path resolver + scene manifest)
  // from the host-supplied game BEFORE anything reads a game file. In the single-
  // realm host this is the ONLY place it runs; shared with edit-runtime's thin
  // main.tsx so the two hosts can't drift. Without this the Assets panel's
  // ContentBrowser throws PATH_RESOLVER_NOT_SET.
  await configureHostSession(gameSession);

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
  canvas.tabIndex = 0;
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
  // Task 1 (render-system-no-camera timing race): clear gateway.doc.world
  // on teardown so a new boot's WorldManager.getSceneWorld() returns undefined
  // during the transition gap (preventing stale world references). Registered
  // FIRST so it runs LAST (LIFO) — after editorApp.stop() releases the GPU
  // device and all other teardown handles unwind.
  registerTeardown(() => {
    gateway.doc.world = undefined as any;
  });

  // M5 (w29, D-4/AC-05): wire the two super seams — selection minting binds new
  // selections to the live (sceneWorld, epoch) pair, and a scene reload bumps the
  // sceneWorld epoch + revalidates the selection (batch invalidation). Registered
  // here (once, at boot) and torn down on realm reset so a cross-game boot starts
  // clean. Without this the handle-pair invalidation is dead — see w23.
  registerTeardown(worldManager.attach());

  // One physical canvas owns one browser acquisition backend. Its routed editor
  // and game views are injected into their respective worlds; no second Play
  // attach may subscribe to window keyboard events.
  const canvasInput = createCanvasInputBoundary(attachBrowserInputBackend(canvas).backend);
  registerTeardown(() => canvasInput.detach());

  // ── Engine boot (was :318). createApp MOVED here (not copied) — net-zero world
  // construction across the M2 diff (lint-no-second-world). ─────────────────────
  // M4 (w21, S6 / AC-07): the composite drawSource feeds [editorWorld, sceneWorld]
  // with cameraOwner=editorWorld / resourceOwner=sceneWorld into the engine
  // frame-loop's draw-source seam (D-3). This is the ONE composite-render wiring —
  // NO self-hosted rAF, NO direct renderer.draw (AC-07): the engine's frame loop
  // pulls drawSource each frame and draws both worlds.
  emitBoot('boot ▸ createApp');
  const app = await createApp(canvas, {
    input: canvasInput.editor,
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
    // NO physics in the EDIT world (D-7 invariant, see :378-383 + solo P7
    // round-15): physics is a game SIMULATION system, and per D-7 "game systems
    // only exist in the transient playWorld built by play-assemble" — the
    // sceneWorld (= this createApp world, save's only source) must carry no
    // ticking game systems. Assembling physicsPlugin here made a `RigidBody`
    // authored at rest FALL to the floor on load (gravity integrating every edit
    // frame), so a save persisted the fallen pose — Edit ≠ Play, authored-intent
    // corruption. The plugin registers only the tick SYSTEMS + PhysicsWorld
    // resource (nothing in the editor reads either); the physics COMPONENTS
    // auto-register at import via defineComponent, so authoring (spawn / set /
    // serialize / describe) stays fully functional without it. ▶ Play still
    // simulates: play-assemble.ts assembles physicsPlugin(deps.physics) into the
    // fresh play world (editPhysics is threaded there via `physics:` below).
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

  // solo P7 round-31: selected collider chrome reuses the engine's existing
  // immediate-mode DebugDraw overlay. It reads the active scene-world SSOT each
  // frame and emits no authored state; debug-draw's graph pass owns its flush.
  installColliderDebugOverlay({
    app: editorApp,
    getSelection,
    getEntityComponents: (entity) => entComponents(gateway.doc.world, entity),
    isAuxVisible,
    isEditMode: () => getViewportQuadrant().run === 'edit',
  });

  // The host owns asset delivery. Its configured pack-index URL is the base the
  // registry uses for every catalog entry, which keeps Studio dev asset traffic
  // on the play-engine origin without a global fetch patch. Standalone hosts that
  // do not inject a URL retain their local pack-index convention.
  const sceneSlug = getSceneId();
  const selfHostPack = typeof __FORGEAX_GAME_DIR_ABS__ === 'string' && !!__FORGEAX_GAME_DIR_ABS__;
  const resolvedPackIndexUrl = gameSession.packIndexUrl ?? (
    (!selfHostPack && sceneSlug && sceneSlug !== 'default')
      ? `/preview/pack-index/${sceneSlug}.json`
      : `${BASE}/pack-index.json`
  );
  renderer.assets.configurePackIndex(resolvedPackIndexUrl);

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
    { component: Camera, data: { ...perspective({ fov: Math.PI / 3, aspect }), tonemap: TONEMAP_REINHARD_EXTENDED, clearColor: [0.42, 0.55, 0.78, 1] } },
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
  //
  // The bridge's eval-queue drain is bound to editorApp.registerUpdate, which
  // stops ticking when ▶ Play pauses the edit App — so a CLI eval submitted during
  // play would queue forever. We hoist the drain here and hand it to the host
  // session so the run-lifecycle re-registers it on the PLAY App while playing
  // (follow-the-live-app). Undefined unless the bridge block below assigns it.
  let bridgeDrainForPlay: ((dt: number) => void) | undefined;
  if (import.meta.env.DEV) {
    const channel = createEvalChannel(gateway, {
      rawScope: { world, renderer, assets: renderer.assets },
    });
    (globalThis as Record<string, unknown>).__forgeaxEval = channel;

    // ── live gateway bridge (DEV-only) ────────────────────────────────────
    // Companion to __forgeaxEval: instead of a headless playwright instance
    // page.evaluate-ing the channel (a SEPARATE browser sharing only the disk
    // backend), this dials OUT to the loopback relay (scripts/gateway-bridge-
    // server.mjs) so a CLI can drive THIS already-open window in real time —
    // same in-memory world, changes visible instantly, no CDP debug port, no
    // save-to-disk+refresh round-trip. The page can only dial out, so the relay
    // is the shared meeting point. DEV-only + loopback + gated behind the same
    // import.meta.env.DEV as the eval channel: production never opens this.
    // Opt-in: CI and ordinary `bun run dev` do not start the loopback relay, so
    // they must never emit browser-level ECONNREFUSED noise. dev-standalone turns
    // this on explicitly alongside launching the relay.
    const bridgeEnabled = import.meta.env.VITE_FORGEAX_BRIDGE === '1';
    if (bridgeEnabled) {
      const bridgePort = import.meta.env.VITE_FORGEAX_BRIDGE_PORT ?? '15295';
      let bridgeWs: WebSocket | null = null;
      let bridgeBackoff = 1000;
      let bridgeStopped = false;

      // Frame-start eval queue (Part 5 — phase stability). A WebSocket `message`
      // fires at an arbitrary point relative to the engine's rAF tick, so running
      // channel.eval → gateway.dispatch inline would land the world write at an
      // unpredictable phase (before/after world.update() this frame). Instead we
      // ENQUEUE each eval and drain the queue from editorApp.registerUpdate, which
      // runs at frame start (between Time injection and world.update()) — so every
      // bridge write is guaranteed to pass through this frame's systems, making
      // the outcome deterministic and reproducible across runs. The reply is
      // deferred to that drain (sub-millisecond; imperceptible for live editing).
      // UI dispatch is unaffected: it goes through React's event loop directly,
      // not this queue.
      const evalQueue: Array<{ id: number; code: string }> = [];
      const drainEvalQueue = (): void => {
        if (evalQueue.length === 0) return;
        // Snapshot + clear so an eval that itself enqueues runs next frame, not
        // in an unbounded same-frame loop.
        const jobs = evalQueue.splice(0, evalQueue.length);
        for (const job of jobs) {
          const reply = (payload: unknown): void => {
            // Reply on the CURRENT socket, not the one captured at enqueue time.
            // Between enqueue and this frame-start drain the bridge socket may have
            // reconnected (a fresh WebSocket instance); the relay keys replies by
            // request id, so sending on the live socket still resolves the pending
            // request. Capturing the enqueue-time socket would send on a closed one.
            try { bridgeWs?.send(JSON.stringify({ type: 'result', id: job.id, payload })); }
            catch { /* socket gone; relay will time the request out */ }
          };
          // eval returns {ok, value|error}; value may be a Promise (async IIFE /
          // _import). Await it, then send a JSON-safe envelope back. Non-
          // serializable values (opaque engine handles) degrade to a marker so
          // one bad field never wedges the channel.
          void (async () => {
            let res: unknown;
            try { res = channel.eval(job.code); } catch (e) {
              return reply({ ok: false, error: { code: 'BRIDGE_EVAL_THREW', hint: String((e as Error)?.message ?? e) } });
            }
            const r = res as { ok?: boolean; value?: unknown };
            if (r?.ok && r.value != null && typeof (r.value as { then?: unknown }).then === 'function') {
              try { r.value = await (r.value as Promise<unknown>); }
              catch (e) { return reply({ ok: false, error: { code: 'SCRIPT_RUNTIME_ERROR', hint: `async rejected: ${String((e as Error)?.message ?? e)}` } }); }
            }
            try { JSON.stringify(res); reply(res); }
            catch { reply({ ok: true, value: '[unserializable value — check the live window]' }); }
          })();
        }
      };
      editorApp.registerUpdate(drainEvalQueue);
      // Follow-the-live-app: expose the drain so the host session registers it on
      // the PLAY App too (the edit App is paused during play → its registerUpdate
      // goes quiet, and a bridge eval submitted while playing would never drain).
      bridgeDrainForPlay = drainEvalQueue;

      const connectBridge = (): void => {
        if (bridgeStopped) return;
        try { bridgeWs = new WebSocket(`ws://127.0.0.1:${bridgePort}/bridge`); }
        catch { return; }
        bridgeWs.addEventListener('open', () => { bridgeBackoff = 1000; });
        bridgeWs.addEventListener('message', (ev) => {
          let msg: { type?: string; id?: number; code?: string };
          try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); }
          catch { return; }
          if (msg?.type !== 'eval' || typeof msg.id !== 'number' || typeof msg.code !== 'string') return;
          // Enqueue — the drain (editorApp.registerUpdate) runs it at frame start
          // and replies on whatever socket is live then (see reply() above).
          evalQueue.push({ id: msg.id, code: msg.code });
        });
        const retryBridge = (): void => {
          bridgeWs = null;
          if (bridgeStopped) return;
          setTimeout(connectBridge, bridgeBackoff);
          bridgeBackoff = Math.min(bridgeBackoff * 2, 15000);
        };
        bridgeWs.addEventListener('close', retryBridge);
        bridgeWs.addEventListener('error', () => { try { bridgeWs?.close(); } catch { /* */ } });
      };
      connectBridge();
      registerTeardown(() => {
        bridgeStopped = true;
        const s = bridgeWs; bridgeWs = null;
        if (s) { try { s.onclose = null; s.close(); } catch { /* */ } }
      });
    }
  }

  // Keyboard ownership lives in interface's single global-shortcuts router
  // (keyboard-router convergence M4 T4-7 / AC-Cb1). Escape is Play-only and
  // dispatches `stop`; plain G remains game-owned; Shift+G toggles play·game ⇄
  // play·scene. Do not restore a local listener here: it would violate the
  // one-keydown-router invariant and double-handle shortcuts.

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
      // ▶ Play receives the game view of the single host-owned canvas boundary;
      // it never attaches a second browser backend to this physical canvas.
      playInput: canvasInput.game,
      // Keep the play App's sole frame loop, but switch its declared renderer
      // projection by quadrant: game camera in play·game; editor camera over the
      // live play world in play·scene.
      createPlayDrawSource: (playWorld) => worldManager.createPlayDrawSource(
        playWorld as import('@forgeax/engine-ecs').World,
        () => getViewportQuadrant().display === 'scene',
      ),
      physics: editPhysics,
      ...(gameSession.selectedSceneGuid ? { selectedSceneGuid: gameSession.selectedSceneGuid } : {}),
      // DEV bridge follow-the-live-app: keep the eval-queue drain ticking on the
      // play App while the edit App is paused during play (undefined in prod).
      ...(bridgeDrainForPlay ? { onPlayFrame: bridgeDrainForPlay } : {}),
      onPlayStarted: () => {
        // The lifecycle has already atomically moved gateway.activeWorld to the
        // play world. Publish the matching UI state only now, never during async
        // assembly, so Hierarchy cannot claim Play while showing the edit tree.
        canvas.focus({ preventScroll: true });
        canvasInput.grantGame();
        setViewportQuadrant({ run: 'play', display: 'game', control: 'game' });
      },
      onPlayFailed: () => {
        // Degrade back to a coherent edit viewport if fresh-world assembly fails.
        canvasInput.revokeGame();
        setViewportQuadrant({ run: 'edit', display: 'scene', control: 'editor' });
      },
    });
  } catch (err) {
    console.error('[editor] host session init failed:', err);
    session = { playSimulation: async () => {}, stopSimulation: () => {}, dispose: () => {} };
  }
  const revokeGameControl = (): void => {
    canvasInput.revokeGame();
    setViewportQuadrant({ control: 'editor' });
  };
  const grantGameControl = (): void => {
    const q = getViewportQuadrant();
    if (q.run !== 'play' || q.display !== 'game') return;
    canvasInput.grantGame();
    setViewportQuadrant({ control: 'game' });
  };
  // Scripted state transitions use the same physical boundary transition as UI
  // gestures; the quadrant remains the SSOT, while the boundary owns cleanup.
  registerTeardown(onViewportQuadrantChange((q) => {
    if (q.inputTarget === 'game') canvasInput.grantGame();
    else canvasInput.revokeGame();
  }));

  // A capture-phase activation grants the game lease only from the play·game
  // observation state. In edit·scene and play·scene the same physical canvas is
  // owned by the editor, so swallowing its pointerdown would disable selection,
  // gizmo drag, and camera navigation before createViewport can receive them.
  const activateGameFromCanvas = (event: PointerEvent): void => {
    const q = getViewportQuadrant();
    if (q.inputTarget === 'game' || q.run !== 'play' || q.display !== 'game') return;
    canvas.focus({ preventScroll: true });
    grantGameControl();
    event.stopImmediatePropagation();
  };
  canvas.addEventListener('pointerdown', activateGameFromCanvas, true);
  registerTeardown(() => canvas.removeEventListener('pointerdown', activateGameFromCanvas, true));

  // The browser backend owns window-level keyboard listeners, so focus alone does
  // not stop a leased game from sampling keys. Any pointer interaction outside the
  // viewport is therefore an ownership boundary: dock panels, tabs, and shell
  // controls all return input to the editor without each panel knowing about games.
  const revokeOnExternalPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (getInputTarget() === 'game' && !(target instanceof Node && container.contains(target))) {
      revokeGameControl();
    }
  };
  const revokeOnFocus = (event: FocusEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target?.matches('input, textarea, select, [contenteditable="true"]') || target?.isContentEditable) {
      revokeGameControl();
    }
  };
  const revokeOnHidden = (): void => {
    if (document.visibilityState === 'hidden') revokeGameControl();
  };
  document.addEventListener('pointerdown', revokeOnExternalPointerDown, true);
  window.addEventListener('focusin', revokeOnFocus, true);
  window.addEventListener('blur', revokeGameControl);
  document.addEventListener('visibilitychange', revokeOnHidden);
  registerTeardown(() => {
    document.removeEventListener('pointerdown', revokeOnExternalPointerDown, true);
    window.removeEventListener('focusin', revokeOnFocus, true);
    window.removeEventListener('blur', revokeGameControl);
    document.removeEventListener('visibilitychange', revokeOnHidden);
  });

  // Wire the deferred ▶/■ chrome actions now that the lifecycle exists (was :505).
  actionsRef.current = {
    playSimulation: () => {
      canvasInput.revokeGame();
      // `session.playSimulation()` assembles asynchronously. Its lifecycle
      // callback publishes play·game only after gateway.activeWorld is live.
      void session.playSimulation();
    },
    stopSimulation: () => {
      revokeGameControl();
      session.stopSimulation();
      setViewportQuadrant({ run: 'edit', display: 'scene', control: 'editor' });
    },
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
  // ViewportBar / GameOverlay display buttons) dispatch it; the real quadrant mutation
  // lives here in edit-runtime (DAG downstream — core stays headless, RK-11).
  const unregSetDisplay = registerSessionApplier('setDisplay', (op) => {
    const { display } = op as { display: 'scene' | 'game' };
    if (display !== 'game') revokeGameControl();
    setViewportQuadrant({ display });
    return { ok: true };
  });
  const unregReleaseGameControl = registerSessionApplier('releaseGameControl', () => {
    revokeGameControl();
    return { ok: true };
  });
  const unregGrantGameControl = registerSessionApplier('grantGameControl', () => {
    grantGameControl();
    return { ok: true };
  });
  registerTeardown(() => { unregSetDisplay(); unregReleaseGameControl(); unregGrantGameControl(); });

  // addSystem·removeSystem are SESSION-domain ops — enabling/disabling an engine
  // system is ledger-visible + AI-equivalent but NOT undoable, exactly like
  // play/stop/setDisplay (D-1: domain = registration site). The ep:systems PANEL
  // (systems-panel.tsx) was REMOVED as orphan dead code — it lived in the
  // EDITOR_PANELS SSOT but had no EDITOR_PANEL_COMPONENTS entry, so it could
  // never render. These add/remove-system ops stay gateway-registered here, so
  // the capability remains reachable via gateway.dispatch (human/AI parity) even
  // without a UI surface. Route the MUTATION through the one gateway door. The
  // mutation lives in edit-runtime (DAG downstream — core stays headless and must
  // not import @forgeax/engine-ecs, RK-11). We use the same `world` closure
  // play/stop/setDisplay use — the live edit world (gateway.doc.world, line ~328).
  // System toggles happen only in edit mode, so this is never a stale cross-play handle.
  const unregRemoveSystem = registerSessionApplier(
    'removeSystem',
    (op) => {
      const { name } = op as { name: string };
      world.removeSystem(name);
      return { ok: true };
    },
    {
      argsSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      title: 'Disable system',
    },
  );
  const unregAddSystem = registerSessionApplier(
    'addSystem',
    (op) => {
      const { name } = op as { name: string };
      const handle = getRegisteredSystems().get(name);
      if (!handle) return { ok: false, error: { code: 'INVALID_ARGS', hint: 'unknown system: ' + name } };
      world.addSystem(handle);
      return { ok: true };
    },
    {
      argsSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      title: 'Enable system',
    },
  );
  registerTeardown(() => { unregAddSystem(); unregRemoveSystem(); });

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
  // Tear the host session down before editorApp.stop() disposes the shared
  // renderer. In Play, this stops the live playApp first; otherwise its rAF would
  // keep drawing the renderer after the edit App releases it.
  registerTeardown(() => session.dispose({ flushPendingSave: currentResetOptions.flushPendingSave }));
  installFpsReport(editorApp, onFps);
  registerTeardown(installAssetSpawnBridge());
  // Single-realm drag-to-viewport + pause-when-hidden live on the viewport's own
  // container (drop → gateway spawn; visibility → editorApp.pause/resume).
  registerTeardown(installViewportDropZone(container));
  registerTeardown(installVisibilityPause(container, editorApp));
  registerTeardown(installAssetCatalogRefresh());
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
