// forgeax editor-runtime — P1.
//
// Boots the forgeax engine on a canvas (same path as @forgeax-studio/preview-
// runtime: createApp + VAG postMessage bridge + diagnostic overlay) AND mounts
// the React editor chrome (ViewportBar + ViewportHints). The authored EditSession
// is projected onto the forgeax world by src/engine/sync.ts so what you edit renders
// with the SAME engine the game plays on (WYSIWYG). Editor self-built dock retired;
// default route is viewport-only. Panels live in outer DockShell as ep:* iframes.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Transform,
  Camera,
  perspective,
  TONEMAP_REINHARD_EXTENDED,
} from '@forgeax/engine-runtime';
import { Entity } from '@forgeax/engine-ecs';
import { createApp } from '@forgeax/engine-app';
import { INPUT_BACKEND_KEY, INPUT_SNAPSHOT_RESOURCE_KEY } from '@forgeax/engine-input';
import { loadGltfRuntime, _clearGltfCache } from '@forgeax/editor-core';
import {
  sendVagMessage,
  onVagMessage,
  allowedParentOrigins,
  VagConsoleSchema,
  VagNetworkSchema,
  VagFpsStatsSchema,
} from '@forgeax/editor-core/protocol';
import { ViewportChrome } from './ViewportChrome';
import { DetachedPanel } from './DetachedPanel';
import { ContextMenuHost } from '@forgeax/editor-shared';
import { createEngineSync } from './engine/sync';
import { setupEditorSkylight } from './engine/skylight';
import { createViewport } from './engine/viewport';
import { getInputTarget, getViewportQuadrant, setViewportQuadrant, onViewportQuadrantChange, setEditorCameraEntity, setGameCameraEntity, deriveActiveCameraEntity } from './engine/viewport-quadrant';
import { setActiveCamera } from '@forgeax/engine-runtime';
import { _syncDisplayMode } from './engine/display-bus';
import { setFps, getFps } from './fps-store';
import { loadGameAssets, makeMaterialResolver, makeMeshResolver } from '@forgeax/editor-core';
import { bus, loadDocFromStorage, loadDocFromDisk, setSceneId, getSceneId, switchSceneFile, initSync, initDiskWatch, initSceneList, broadcastAssetsChanged, flushPendingSaveBeacon, cancelPendingDiskSave, setPathResolver, getAssetSelection, onAssetSelectionChange, getSelection, onSelectionChange, publishMeshStats } from '@forgeax/editor-shared';
import { openProject, createFetchReader, resolveGamePath, getApiClient, injectEditMode } from '@forgeax/editor-core';
import { createRunLifecycle, type RunLifecycle } from './engine/run-lifecycle';
import { loadGameProject, FORGE_JSON } from '@forgeax/engine-project';
import { getPopoutPanel } from '@forgeax/editor-core';
import './theme.css';

// ── Boot watchdog (root-cause-agnostic dead-boot backstop) ───────────────────
// The editor boots behind several top-level `await`s (initSceneList,
// loadDocFromDisk, createApp/WebGPU init). If ANY stalls — a dev-server bounced
// mid-session, vite re-optimizing deps, a WKWebView WebGPU init that never
// returns — the module never finishes evaluating and the user is stuck on a dead
// black viewport (FPS '--', clicks dead) with no error and no recovery. This
// timer is registered SYNCHRONOUSLY before the first await; a stalled top-level
// await suspends the module but the event loop still fires this timer. If boot
// hasn't completed in time it paints a reload affordance instead of a silent
// hang. (Per-fetch timeouts in editor-core handle the fetch variant; this is the
// backstop for everything else, incl. createApp.)
let bootCompleted = false;
let bootStage = 'init';
// Emit a boot breadcrumb to the shell health feed (Info panel + .forgeax/logs).
// Posts DIRECTLY to the parent rather than via console — installConsoleBridge runs
// late in boot, so a stall BEFORE it would otherwise be invisible. This makes a
// hang observable: the Info panel shows the boot stages and exactly where Edit
// got stuck, instead of a silent dead viewport you have to guess about.
function emitBoot(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  try {
    window.parent?.postMessage(
      { type: 'forgeax:health', level, source: 'edit', code: 'boot', message, ts: Date.now() },
      '*',
    );
  } catch { /* no parent / cross-origin — overlay still covers the user */ }
}
function setBootStage(s: string): void { bootStage = s; emitBoot(`boot ▸ ${s}`); }
const bootWatchdog = setTimeout(() => {
  if (bootCompleted) return;
  emitBoot(`Edit 启动卡在「${bootStage}」阶段 >15s — 已显示重载入口`, 'error');
  try {
    const o = document.createElement('div');
    o.style.cssText =
      'position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:rgba(26,26,30,.82);backdrop-filter:blur(2px);color:#eee;font:14px system-ui;text-align:center;padding:24px';
    const title = document.createElement('div');
    title.style.cssText = 'font-size:15px;font-weight:600';
    title.textContent = '编辑器启动卡住了';
    const desc = document.createElement('div');
    desc.style.cssText = 'opacity:.7;max-width:420px;line-height:1.5';
    desc.textContent = `Edit 卡在「${bootStage}」阶段（dev server 刚重启 / WebGPU 初始化未返回）。点下面重载即可恢复。`;
    const btn = document.createElement('button');
    btn.textContent = '↻ 重新加载编辑器';
    btn.style.cssText = 'padding:8px 18px;border-radius:8px;border:1px solid #555;background:#2a2a30;color:#fff;cursor:pointer;font:13px system-ui';
    btn.onclick = () => location.reload();
    o.append(title, desc, btn);
    (document.getElementById('ui') ?? document.body).appendChild(o);
  } catch { /* DOM unavailable — nothing we can do */ }
}, 15000);
function markBootComplete(): void {
  bootCompleted = true;
  clearTimeout(bootWatchdog);
  emitBoot('boot ✓ ready');
}

// Bind persistence to the active game/scene (`?scene=<slug>` passed by the
// interface EditMode iframe). Each game gets its OWN editor scene — without this
// every game shared one global doc, so picking shoot-opt showed whatever was
// last edited (or the demo). Must run before loadDocFromStorage below.
setSceneId(new URLSearchParams(location.search).get('scene'));
// Install the game→disk path resolver (layout decoupling, 2026-06-25). editor-core
// is layout-agnostic: it asks for game-relative paths ('forge.json', 'scenes/…')
// and THIS adapter (the host) maps them to disk. The studio convention
// `.forgeax/games/<slug>/…` lives here in the runtime adapter, NOT in the pure
// library. Three tensions resolved:
//   (i)  pure lib zero-convention — the literal only lives at this seam;
//   (ii) self-contained — standalone with no game (slug 'default') yields an
//        empty root, but the call sites' `currentSceneId === 'default'` guards
//        mean the resolver is never reached, so the demo seed / build / tests run
//        with no studio changes;
//   (iii) studio override seam — a host can pass `?gameRoot=<path>` (flat /
//        nested / workspace layouts) or replace this resolver entirely before
//        boot to fully own slug→path translation.
{
  const qp = new URLSearchParams(location.search);
  const slug = (qp.get('scene') ?? '').trim();
  const gameRoot = qp.get('gameRoot') ?? (slug && slug !== 'default' ? `.forgeax/games/${slug}` : '');
  setPathResolver((rel) => (rel ? `${gameRoot}/${rel}` : gameRoot));
}
// Discover the game's multi-scene manifest (forge.json `scenes`) BEFORE any doc
// load so paths/storage keys resolve to the active scene file (UE level model).
setBootStage('initSceneList');
await initSceneList();

// ── Viewport-only mode (default path) ──────────────────────────────────────────
// Default route: the editor runtime renders only the engine canvas with ViewportBar.
// The `?viewportOnly=1` query is semantically identical to the default path after
// dock retirement. All editor panels live in an outer DockShell as separate `ep:*`
// panel iframes (?panel=X), each connecting via BroadcastChannel.
const viewportOnly = new URLSearchParams(location.search).has('viewportOnly');

// ── Pop-out window entry (design §0.2.2) ──────────────────────────────────────
// Launched with `?panel=<id>`, this OS window renders ONE panel that mirrors the
// main window's bus over a BroadcastChannel — no engine boot, no toolbar. It
// requests a snapshot on open (initSync → 'hello') and tracks every edit live.
const popoutPanel = getPopoutPanel();
if (popoutPanel) {
  document.title = `forgeax · ${popoutPanel}`;
  const root = document.getElementById('ui') ?? document.body;
  // Seed the doc so the popped panel shows the scene IMMEDIATELY — a separate OS
  // window (Tauri) can be its own process where BroadcastChannel won't reach the
  // main window, so we must not depend on a live snapshot to have content. disk →
  // localStorage mirror; initSync then keeps it live (channel + cross-process
  // `storage` events).
  await loadDocFromDisk().then((ok) => { if (!ok) loadDocFromStorage(); }).catch(() => loadDocFromStorage());
  initSync();
  createRoot(root).render(
    <StrictMode>
      <DetachedPanel panel={popoutPanel} />
      {/* Pop-out fallback renderer for context menus (embedded ep:* iframes
          post to the interface parent instead — see contextMenuService). */}
      <ContextMenuHost />
    </StrictMode>,
  );
  markBootComplete();
} else {
  await bootEditor();
}

async function bootEditor(): Promise<void> {

const BASE = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');

const appRoot = document.getElementById('app') ?? document.body;

const canvas = document.createElement('canvas');
canvas.style.width = '100%';
canvas.style.height = '100%';
const dpr = Math.min(window.devicePixelRatio || 1, 2);
canvas.width = window.innerWidth * dpr;
canvas.height = window.innerHeight * dpr;
appRoot.appendChild(canvas);

installConsoleBridge();
installNetworkBridge();

// ── Seed / restore the authored document ──────────────────────────────────────
// A small demo scene so the editor opens with something to edit + render. These
// are ordinary commands → they land in the ledger and are undoable.
function seed(): void {
  if (Object.keys(bus.doc.entities).length > 0) return;
  // Mirrors the new-game template's scene.json (packages/engine/templates/
  // game-default/scene.json): a lowpoly vignette + a movable `Player`. A scene-
  // less game (or fresh workspace) opens on this same starter, fully editable.
  bus.dispatch({ kind: 'spawnEntity', name: 'Level', components: {} });
  const level = (bus.ledger.at(-1) as { _id: number })._id;
  const add = (name: string, components: Record<string, unknown>, source?: { plugin: string; docId: string }) =>
    bus.dispatch({ kind: 'spawnEntity', name, parent: level, components, ...(source ? { source } : {}) });

  add('Ground', { Transform: { x: 0, y: -0.1, z: 0, scaleX: 24, scaleY: 0.2, scaleZ: 24 }, Mesh: { kind: 'cube' }, Material: { albedo: '#7a9e5a', metallic: 0, roughness: 0.95 }, Collider: { shape: 'box' } });
  add('Sun', { Transform: { x: 0, y: 6, z: 0 }, Light: { type: 'directional', color: '#fff5e0', intensity: 3.2, directionX: -0.4, directionY: -1, directionZ: -0.3, castShadow: true } });
  add('TreeTrunk', { Transform: { x: -4, y: 0.9, z: -3, scaleX: 0.4, scaleY: 1.8, scaleZ: 0.4 }, Mesh: { kind: 'cylinder' }, Material: { albedo: '#8a5a2b', metallic: 0, roughness: 0.9 } });
  add('TreeCanopy', { Transform: { x: -4, y: 2.4, z: -3, scaleX: 1.4, scaleY: 1.4, scaleZ: 1.4 }, Mesh: { kind: 'sphere' }, Material: { albedo: '#5fae4f', metallic: 0, roughness: 0.85 } });
  add('RedBox', { Transform: { x: 3, y: 0.5, z: -2, scaleX: 1, scaleY: 1, scaleZ: 1 }, Mesh: { kind: 'cube' }, Material: { albedo: '#e76f51', metallic: 0, roughness: 0.7 } }, { plugin: 'lowpoly', docId: 'crate-01' });
  add('BlueBall', { Transform: { x: 4.5, y: 0.8, z: 1.5, scaleX: 0.8, scaleY: 0.8, scaleZ: 0.8 }, Mesh: { kind: 'sphere' }, Material: { albedo: '#4aa3df', metallic: 0.1, roughness: 0.4 } });
  add('YellowPillar', { Transform: { x: 2, y: 0.75, z: 3.5, scaleX: 0.6, scaleY: 1.5, scaleZ: 0.6 }, Mesh: { kind: 'cylinder' }, Material: { albedo: '#f4c542', metallic: 0, roughness: 0.6 } });
  add('Player', { Transform: { x: 0, y: 0.55, z: 0, scaleX: 0.7, scaleY: 1.1, scaleZ: 0.7 }, Mesh: { kind: 'cylinder' }, Material: { albedo: '#ff79c6', metallic: 0, roughness: 0.5 }, Collider: { shape: 'cylinder', radius: 0.35 }, Velocity: { vx: 0, vy: 0, vz: 0 } });
}
// Load order: the game's on-disk authored scene → localStorage mirror → demo
// seed. So opening a game shows ITS saved scene (if authored); a fresh game
// starts from the seed and persists per-game from there.
setBootStage('loadDoc');
// Load order: on-disk authored scene → localStorage mirror → demo seed. Seed
// whenever the result is EMPTY (sceneless game, fresh workspace, OR a prior
// session that persisted a 0-entity doc) — otherwise the viewport opens blank
// and looks "dead". seed() self-guards against clobbering a non-empty doc.
await loadDocFromDisk().then((ok) => { if (!ok) loadDocFromStorage(); }).catch(() => { loadDocFromStorage(); });
if (Object.keys(bus.doc.entities).length === 0) {
  seed();
  // The bare seed is a viewport convenience for a scene-less game — do NOT
  // auto-persist it to the game dir (avoids creating an unauthored scene.pack.json
  // / masking a real scene). The user's first real edit re-schedules a save.
  cancelPendingDiskSave();
}

// Mount the React chrome immediately so the editor is usable even if WebGPU is
// unavailable (the canvas behind it shows the diagnostic overlay in that case).
// Default path: always render ViewportBar (editor self-built dock retired; default
// route is now viewport-only). The `?panel=X` and `?viewportOnly=1` query paths
// are handled above (popout panel path) or are semantically identical.
// ── FPS store for ViewportChrome / GameOverlay (w24). The GameOverlay needs a
// live FPS readout. The frame-loop accumulator (installFpsReport) writes into
// this store; ViewportChrome reads it on a subscription. Initial value is 0
// (the first frame hasn't landed yet — the overlay shows '? FPS' until then).
let fpsStoreValue = 0;
// Deferred action references: playSimulation/stopSimulation are defined inside
// bootEditor() (after the engine world is live), but the React mount runs before
// it. The ViewportChrome callbacks resolve through this indirection so they don't
// close over undefined references.
const actions = {
  play: (): void => { /* wired after engine boot */ },
  stop: (): void => { /* wired after engine boot */ },
};

const uiRoot = document.getElementById('ui');
if (uiRoot) {
  createRoot(uiRoot).render(
    <StrictMode>
      <ViewportChrome
        fps={fpsStoreValue}
        onPlay={() => actions.play()}
        onStop={() => actions.stop()}
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
    </StrictMode>,
  );
}

// ── Engine boot ───────────────────────────────────────────────────────────────
// engine #311 reshaped createApp: shaderManifestUrl moved off the 2nd-arg
// options onto the 3rd-arg BundlerOptions. The editor supplies its own manifest
// path (not the virtual:forgeax/bundler adapter), so pass it as the bundler arg.
setBootStage('createApp');
const app = await createApp(canvas, {
  // Pointer-lock gate (w19, requirements C-4 / OOS-4): the game's input backend
  // auto-locks the cursor on a canvas click, which in the edit world would steal
  // the mouse from editor orbit/pick. Gate it on the SAME derived inputTarget the
  // viewport input gate reads — only the play·game quadrant captures the cursor.
  // The engine stays editor-agnostic: it only calls this neutral predicate.
  pointerLockAllowed: () => getInputTarget() === 'game',
}, {
  shaderManifestUrl: `${BASE}/shaders/manifest.json`,
  // Dev-mode import transport — POSTs /__import/<guid> on a loadByGuid miss
  // so the editor viewport can lazily cook glTF sub-assets (skin, animation
  // clips, skeleton) needed for Edit-mode skeletal animation preview. Studio
  // outer proxy routes /__import + /__forgeax-ddc to the play engine, which
  // owns the per-game pluginPack catalog. MUST be in the BundlerOptions (3rd
  // arg) — the 2nd-arg CreateAppOptions silently drops it (engine #311 split).
  importTransport: {
    async fetchPack(guid: string) {
      try {
        const response = await fetch(`/__import/${guid}`, { method: 'POST' });
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
const CREATE_APP_RETRY_KEY = 'forgeax.editor.createApp.retries';
if (!app.ok) {
  // WKWebView/WebGPU (the desktop Studio app) transiently fails to (re)create
  // the GPU device on a reload or under concurrent surface boots — the device
  // request rejects and the Edit viewport goes pitch-black, while a FRESH page
  // load succeeds (Chromium never hits this). This is exactly what a scene/level
  // switch (switchSceneFile → location.reload) and HMR trigger. Rather than leave
  // a black viewport, auto-reload a BOUNDED number of times to recover; the
  // counter resets on the next success so the budget refills per session.
  let retries = 0;
  try { retries = Number(sessionStorage.getItem(CREATE_APP_RETRY_KEY) ?? '0') || 0; } catch { /* no storage */ }
  if (retries < 3) {
    try { sessionStorage.setItem(CREATE_APP_RETRY_KEY, String(retries + 1)); } catch { /* no storage */ }
    console.warn(`[editor] createApp failed (auto-reload ${retries + 1}/3 to recover):`, app.error);
    setTimeout(() => location.reload(), 500 + retries * 500);
    throw new Error('[editor] createApp failed — reloading to recover');
  }
  console.error('[editor] createApp failed after 3 reload attempts — giving up:', app.error);
  paintDiagnosticMessage(app.error);
  throw new Error('[editor] createApp failed');
}
// Booted cleanly — refill the auto-reload budget for the next reload/scene switch.
try { sessionStorage.removeItem(CREATE_APP_RETRY_KEY); } catch { /* no storage */ }

const { world, renderer } = app.value;
// Point at the play engine's per-game catalog (proxied through the studio's
// /preview/* route) when a game slug is active. Edit-runtime's own pluginPack
// has empty roots, so without this every loadByGuid on a game asset (witch.glb
// skin, animation-clip) would miss the catalog and bail before /__import.
const sceneSlug = getSceneId();
const packIndexUrl = (sceneSlug && sceneSlug !== 'default')
  ? `/preview/pack-index/${sceneSlug}.json`
  : `${BASE}/pack-index.json`;
renderer.assets.configurePackIndex(packIndexUrl);

// ── EditMode resource: boot in edit state (▶/■ Simulate, w11) ─────────────────
// Single-world model (requirements C-1): one edit-runtime world hosts both editor
// and game systems. Game systems are gated by `notEditing` (w10), which reads
// EditMode.active. Inject EditMode.active=true at boot so discovered game systems
// freeze in the default edit·scene state (AC-03). ▶ Play flips it to false to let
// them tick; ■ Stop flips it back to true. This is the ONLY EditMode writer chain
// (Append-Only/SSOT): no other code path touches EditMode.active.
injectEditMode(world, true);

// ▶/■ command chain (w11/w12 — bootstrap-entry model, plan-strategy D-1/D-1c).
// The run lifecycle lives in ./engine/run-lifecycle (testable, DI'd); here we
// only wire the real world / app / bus / engineSync into it. It is CREATED later
// (after engineSync + the active-camera derivation exist), so these two names are
// thin wrappers over a `runLifecycle` holder assigned at that point. The
// ViewportBar (actions.play/stop) and __forgeax_editor call the wrappers at
// runtime — long after boot has assigned the holder.
//
//   ▶  snapshot bus.doc once (AC-07) → loadGame(slug) → bootstrap(world, ctx)
//      (game registers systems/callbacks) → injectEditMode(false) opens the gate.
//   ■  injectEditMode(true) freezes → epoch.bump() silences run callbacks →
//      removeSystem the bootstrap systems → replaceDoc(snapshot) restores the doc
//      → despawn runtime-spawned entities (four-layer idempotent undo, D-1c).
let runLifecycle: RunLifecycle | null = null;
function playSimulation(): void {
  void runLifecycle?.playSimulation();
}
function stopSimulation(): void {
  runLifecycle?.stopSimulation();
}

/**
 * Collect all live entity handles from the world by walking the archetype graph.
 * The Entity.self column in each archetype row stores the packed entity handle.
 * Reads @internal `world._getGraph()` — charter P4 engine-neutral reading.
 */
function collectWorldEntityHandles(w: typeof world): Set<number> {
  const handles = new Set<number>();
  interface ArchWithSelf { columns: Map<number, Map<string, { view: Uint32Array }>>; size: number }
  interface WorldWithGraph { _getGraph: () => { archetypes: ArchWithSelf[] } }
  const graph = (w as unknown as WorldWithGraph)._getGraph();
  for (const arch of graph.archetypes) {
    const selfCol = arch.columns.get(Entity.id)?.get('self');
    if (!selfCol) continue;
    for (let row = 0; row < arch.size; row++) {
      const packed = selfCol.view[row]!;
      if (packed !== 0) handles.add(packed as unknown as number);
    }
  }
  return handles;
}

// Expose the viewport quadrant SSOT (get/set/subscribe) so an out-of-iframe AI
// can script-drive the run x display quadrants (verify V-2 affordances finding).
(window as unknown as Record<string, unknown>).__forgeax_editor = { app: app.value, world, renderer, bus, switchScene: switchSceneFile, playSimulation, stopSimulation, getViewportQuadrant, setViewportQuadrant, onViewportQuadrantChange };

	// Wire deferred action references for ViewportChrome callbacks (w24). The
	// React mount runs before bootEditor, so the callbacks were stubbed. Now
	// that playSimulation/stopSimulation are defined, close the loop.
	actions.play = () => {
	  setViewportQuadrant({ run: 'play', display: 'game' });
	  playSimulation();
	};
	actions.stop = () => {
	  stopSimulation();
	  setViewportQuadrant({ run: 'edit', display: 'scene' });
	};

  // ── openProject proof-of-life (M3 w15): call openProject with fetch reader ──
  // This call path is an ADDITION (does not replace the existing EditSession
  // flow). It proves the openProject contract works end-to-end; both paths now
  // project through SceneAsset (M6). The result world is exposed on the window
  // object for manual verification (AC-06 human part).
  if (sceneSlug && sceneSlug !== 'default') {
    openProject(sceneSlug, createFetchReader()).then((projectResult) => {
      if (projectResult.sceneRoot !== null) {
        console.log(`[editor] openProject: scene instantiated (${projectResult.world.inspect().entityCount} entities, root=${projectResult.sceneRoot})`);
      } else {
        console.log('[editor] openProject: no defaultScene, graceful skip');
      }
      (window as unknown as Record<string, unknown>).__forgeax_project = projectResult;
    }).catch((err: unknown) => {
      console.warn('[editor] openProject failed:', err);
    });
  }
void renderer.ready.then((r: { ok: boolean; error?: { code?: string; expected?: unknown; hint?: string; detail?: unknown } }) => {
  if (!r.ok) console.error('[editor] renderer.ready err:', r.error?.code, r.error?.expected, r.error?.hint, r.error?.detail);
});

window.addEventListener('resize', () => {
  const d = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = window.innerWidth * d;
  canvas.height = window.innerHeight * d;
});

// Editor camera (not part of the authored doc — it's a viewport, not scene
// content). createViewport drives its pose (orbit/pan/zoom); the spawn values are
// placeholders it overwrites on first frame.
const aspect = canvas.width / canvas.height || 1;
const cameraEntity = world.spawn(
  { component: Transform, data: { posY: 1.5, posZ: 9 } },
  // tonemap must be active for the HDR SkyboxBackground pass to draw.
  // clearR/G/B = visible sky background. On WebKit/WKWebView (the desktop app)
  // the cubemap SkyboxBackground can't render (needs rgba16float render targets),
  // so without this the Edit viewport background is pure black; a neutral studio
  // blue reads as sky. On Chromium the cubemap skybox draws over it. Linear/pre-
  // tonemap. The viewport drives only the camera Transform, so this clear sticks.
  { component: Camera, data: { ...perspective({ fov: Math.PI / 3, aspect }), tonemap: TONEMAP_REINHARD_EXTENDED, clearR: 0.42, clearG: 0.55, clearB: 0.78 } },
).unwrap();

// Register the editor orbit camera with the quadrant SSOT (w22). The quadrant
// derivation uses this id whenever the quadrant is NOT play·game.
setEditorCameraEntity(cameraEntity as unknown as number);

// Load the open game's asset packs once, so a Material.materialAsset GUID
// renders as the referenced asset material (registered from the pack payload —
// the editor's pack-index is empty, so we can't loadByGuid). Sync lookup → the
// instantiator stays synchronous.
const packAssets = await loadGameAssets(getSceneId());
// Original glTF materials recovered for a dropped mesh (Material.submeshMaterials)
// live in DDC/meta, NOT in the game *.pack.json — so makeMaterialResolver can't
// see them. They're loaded async via loadByGuid below and minted into this cache;
// the resolver consults it first (mirrors the preloaded-mesh resolver).
const preloadedMaterials = new Map<string, unknown>();
const baseMaterialResolver = makeMaterialResolver(world as never, packAssets);
const resolveMaterialAsset = (guid: string): unknown | null =>
  preloadedMaterials.has(guid) ? (preloadedMaterials.get(guid) ?? null) : baseMaterialResolver(guid);
// Imported mesh sub-assets (glTF mesh dragged from Content Browser) live in
// .meta.json/DDC, not *.pack.json — they're loaded async via loadByGuid below and
// minted into this cache; the sync resolver consults it so split-mesh drags
// render their real geometry (mirrors the GltfRef preload + resolveMaterialAsset).
const preloadedMeshes = new Map<string, unknown>();
const resolveMeshAsset = makeMeshResolver(world as never, packAssets, preloadedMeshes);
// Submesh counts keyed by mesh GUID. The engine requires
// MeshRenderer.materials.length === MeshAsset.submeshes.length; the editor authors
// a single material per entity, so the instantiator broadcasts it across this many
// submesh slots (instantiate.ts materialSlots). Preloaded imports (loaded async
// below) win over pack meshes; unknown → the instantiator uses the engine's
// per-submesh default instead of risking a count mismatch. Must stay in lockstep
// with resolveMeshAsset (same GUIDs populated together).
const preloadedMeshSubmeshCounts = new Map<string, number>();
const packMeshSubmeshCounts = new Map<string, number>(
  packAssets
    .filter((a) => a.kind === 'mesh')
    .map((a) => {
      const subs = (a.payload as { submeshes?: { length?: number } } | undefined)?.submeshes;
      return [a.guid, typeof subs?.length === 'number' && subs.length > 0 ? subs.length : 1] as const;
    }),
);
const resolveMeshSubmeshCount = (guid: string): number | undefined =>
  preloadedMeshSubmeshCounts.get(guid) ?? packMeshSubmeshCounts.get(guid);

// Wire the authored doc → forgeax world (rebuilds on every bus change). The
// doc→world mapping is @forgeax/scene's instantiateScene — the same path ▶ Play
// uses — so the editor renders geometry/PBR/emissive/lights at full fidelity.
const engineSync = createEngineSync(world as never, renderer as never, resolveMaterialAsset, resolveMeshAsset, resolveMeshSubmeshCount);

// Viewport interaction: orbit/pan/zoom camera, click-to-select, drag-to-move.
const viewport = createViewport({
  canvas, world: world as never, assets: renderer.assets as never, camera: cameraEntity, sync: engineSync,
  // w17/w19: the viewport input gate reads the derived inputTarget from the
  // {run, display} SSOT (viewport-quadrant). Only play·game returns 'game', at
  // which point the editor handlers early-return so events reach the game canvas.
  getInputTarget,
});
window.addEventListener('resize', () => viewport.refresh());

// ── possess exit (feat-20260630-viewport M4 / w20, requirements §3.2 + AC-15) ──
// In play·game the game owns the cursor + input (PIE). Esc "un-possesses": it
// switches display→scene (→ play·scene = UE Simulate), handing input back to the
// editor for free observation. This moves ONLY the display axis — it does NOT
// touch run / EditMode / the world, so the game keeps ticking continuously
// (requirements §3.3 hard constraint 3: play·game ⇄ play·scene never resets).
//
// G is the fallback (AC-15): WKWebView (desktop .app) may swallow Esc as a system
// gesture, so G performs the same play·game → play·scene exit. (G is also the
// universal display toggle in requirements §3.2; the universal keyboard handler
// for the other quadrants lands with the M5 ViewportBar/state-machine work — w20
// owns only the possess-exit direction so the PIE → Simulate path works now.)
//
// This listener is intentionally OUTSIDE the viewport.ts editor handlers: those
// early-return in play·game (w17), so a possess-exit key must be handled here
// where it fires regardless of inputTarget. Capture phase so it runs before the
// game's own keydown consumer can stop propagation.
function onPossessKey(e: KeyboardEvent): void {
  const el = e.target as HTMLElement | null;
  const tag = el?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
  const q = getViewportQuadrant();
  if (q.run !== 'play' || q.display !== 'game') return; // only un-possess from play·game
  const k = e.key;
  if (k === 'Escape' || k === 'g' || k === 'G') {
    setViewportQuadrant({ display: 'scene' }); // → play·scene; run/EditMode/world untouched
  }
}
window.addEventListener('keydown', onPossessKey, { capture: true });

// ── play·scene non-commit (feat-20260630-viewport M4 / w27, AC-11) ──────────────
// play·scene (run=play ∧ display=scene = UE Simulate) lets the user edit the
// running game for observation, but those edits must NOT persist. bus.transientMode
// gates that: while true, dispatch applies + repaints but does not grow undo/ledger
// (editor-core bus.ts). Keep it in lock-step with the quadrant — true exactly in
// play·scene, false everywhere else. Sync once at boot (default is edit·scene →
// false) and on every quadrant change. The ■ Stop snapshot (w14/w15) is the second
// safety net that discards the transient world state on exit (AC-07 double-safety).
function syncTransientMode(q: { run: string; display: string }): void {
  bus.transientMode = q.run === 'play' && q.display === 'scene';
}
syncTransientMode(getViewportQuadrant());
onViewportQuadrantChange(syncTransientMode);

// ── activeCamera derivation (feat-20260630-viewport M5 / w22) ───────────────────
// The quadrant SSOT derives which camera entity should be active per quadrant:
//   - play·game: game camera (setGameCameraEntity registered entity, or undefined)
//   - other three: editor orbit camera (setEditorCameraEntity registered entity)
// The engine's ActiveCamera resource (w12) receives the entity id via setActiveCamera,
// and the renderer's record stage reads it to select the render camera (D-2, OOS-4).
// Game camera discovery is best-effort: if the authored scene has no Camera entity,
// setGameCameraEntity stays undefined → play·game falls back to editor orbit camera
// (the renderer's ActiveCamera selection also falls back to first-hit).
//
// Game camera registration: walk the doc entities after boot+sync and set the
// first found Camera entity as gameCameraEntity. This is a snapshot at boot —
// the setGameCameraEntity call is idempotent and the quadrant derivation reads
// the latest registered id.
function discoverGameCamera(): void {
  // Walk the authored doc for the first Camera entity (the game scene's camera).
  // This runs after the initial engineSync, so the scene is projected into the world.
  for (const eid of Object.keys(bus.doc.entities)) {
    const comps = bus.doc.entities[eid as unknown as number]?.components;
    if (comps && 'Camera' in comps) {
      const worldEnt = engineSync.worldEntityFor(eid as unknown as number);
      if (worldEnt !== undefined) {
        setGameCameraEntity(worldEnt as unknown as number);
        return;
      }
    }
  }
  // D-8 (requirements §10.2 / plan §3.3): no game Camera in the scene. play·game
  // will fall back to the editor orbit camera. Surface a structured diagnostic
  // instead of silently reverting (verify V-1 affordances finding).
  console.warn('[viewport] no-game-camera: scene has no entity with a Camera component; play·game will render through the editor orbit camera. hint: add a Camera component to a scene entity.');
}

// After ▶ Play's bootstrap, a game may spawn its camera DIRECTLY on the world
// (e.g. spin-cube / cow-level `world.spawn({ Camera })`) rather than through the
// authored doc — discoverGameCamera (doc walk) would miss it. Walk the live world
// archetype graph for the first Camera entity that is not the editor orbit
// camera and register it as the game camera (D-2 / AC-12 hard cut). Reads
// @internal `world._getGraph()` — same charter-P4 engine-neutral read as
// collectWorldEntityHandles.
function discoverGameCameraFromWorld(): void {
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
  // No non-editor camera found — leave the doc-discovered game camera (if any).
  // If none was found there either, play·game falls back to first-hit (D-8).
}

// Run game camera discovery after the initial sync populates the world.
// engineSync is sync (not async), so this runs immediately after project.
engineSync.resync();
discoverGameCamera();

// Wire activeCamera to the engine on every quadrant change. The setter directly
// writes the engine's ActiveCamera KV resource — the renderer reads it on the
// next extract stage (hard cut, no interpolation — requirements AC-12).
function applyActiveCamera(): void {
  const camEnt = deriveActiveCameraEntity();
  if (camEnt !== undefined) {
    setActiveCamera(world as never, camEnt as unknown as number);
  }
}
// Apply once at boot (default is edit·scene → editor orbit camera), then on every
// quadrant change. The transientMode subscriber above is separate — both fire
// on the same quadrant change event.
applyActiveCamera();
onViewportQuadrantChange(() => applyActiveCamera());

// ── ▶ Play run lifecycle (feat-20260630-viewport M2 / w11-w12, D-1/D-1a/D-1c) ──
// Wire the DI'd run lifecycle to the real world / app / bus / engineSync. The
// game entry is imported through the SAME /preview/.forgeax/games/<slug>/ proxy
// play-runtime uses, resolving the entry filename from forge.json (falling back
// to main.ts / src/main.ts). The BootstrapContext defaultScene comes from the
// doc projection (D-1a): defaultSceneRoot is EngineSync's instanceRoot (carries
// the SceneInstance the game reads for its localId→entity mapping), and
// defaultScene is the SceneAsset PAYLOAD loaded by GUID (read-only data — NOT a
// second instantiate, which would duplicate the doc-projected entities).
// getDefaultScene reads a cache resolveGameModule fills, since loadGame (which
// calls resolveGameModule) always runs before ctx assembly in playSimulation.
let cachedDefaultScene: unknown;
async function resolveGameModuleForPlay(): Promise<unknown> {
  const slug = getSceneId();
  // The `/preview/*` route is a ROOT-absolute same-origin proxy served by the
  // studio server (→ play-runtime's per-game catalog), NOT under the editor's
  // vite base (`/editor`). Every other /preview reference here is root-absolute
  // (packIndexUrl @330, fullscreen @254, shared-assets @784); prefixing the
  // editor BASE here made the HEAD hit `/editor/preview/...` which the vite dev
  // server answers with the SPA index.html (content-type text/html), so the
  // `javascript` check failed, loadGame errored, and ▶ Play opened the gate
  // with ZERO game systems registered — the game never started.
  const gameBase = `/preview/.forgeax/games/${slug}`;
  // Resolve entry candidates from forge.json (authoritative), then defaults.
  const candidates: string[] = [];
  cachedDefaultScene = undefined;
  try {
    const gameForgePath = resolveGamePath(FORGE_JSON);
    const gp = await loadGameProject(async () => {
      const r = await getApiClient().fetch(`/api/files?path=${encodeURIComponent(gameForgePath)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { content?: string };
      if (!j.content) throw new Error('Empty content');
      return j.content;
    });
    if (gp.ok) {
      const entry = gp.value.entry;
      if (typeof entry === 'string' && entry) candidates.push(entry.replace(/^\.?\//, ''));
      // D-1a: load the defaultScene SceneAsset payload (data only) so bootstrap
      // can recover its author-side entity list (Name → localId). loadByGuid
      // returns the payload; we do NOT instantiate (the doc projection already
      // built the live scene, which supplies defaultSceneRoot).
      const dsGuid = gp.value.defaultScene;
      if (typeof dsGuid === 'string' && dsGuid.length > 0) {
        const { AssetGuid } = await import('@forgeax/engine-pack/guid');
        const parsed = AssetGuid.parse(dsGuid);
        if (parsed.ok) {
          await renderer.ready.catch(() => null);
          const assetRes = await renderer.assets.loadByGuid(parsed.value);
          if (assetRes.ok) cachedDefaultScene = assetRes.value;
          else console.warn('[editor] ▶ Play defaultScene load failed:', (assetRes.error as { code?: string })?.code);
        }
      }
    }
  } catch (e) {
    console.warn('[editor] ▶ Play forge.json read failed (using entry defaults):', e);
  }
  for (const fallback of ['main.ts', 'src/main.ts']) {
    if (!candidates.includes(fallback)) candidates.push(fallback);
  }
  // Dynamic-import the first candidate that resolves as JS (mirrors play-runtime).
  for (const rel of candidates) {
    const url = `${gameBase}/${rel}`;
    try {
      const head = await fetch(url, { method: 'HEAD' });
      const ct = head.headers.get('content-type') ?? '';
      if (head.ok && ct.includes('javascript')) {
        return await import(/* @vite-ignore */ `${url}?t=${Date.now()}`);
      }
    } catch { /* try next candidate */ }
  }
  // Signal module-not-found to loadGame (slug in the message → 'module-not-found').
  throw new Error(`module not found: ${getSceneId()}`);
}

runLifecycle = createRunLifecycle({
  world: world as never,
  app: app.value as never,
  renderer: renderer as never,
  bus: bus as never,
  collectEntityHandles: () => collectWorldEntityHandles(world),
  resolveGameModule: resolveGameModuleForPlay,
  getSlug: () => getSceneId(),
  getDefaultSceneRoot: () => engineSync.sceneRoot(),
  getDefaultScene: () => cachedDefaultScene,
  // AC-12: after bootstrap the game may have spawned its own camera directly on
  // the world (not through the doc). Re-discover it and re-apply the active
  // camera so play·game hard-cuts to the game camera.
  onAfterBootstrap: () => {
    discoverGameCameraFromWorld();
    applyActiveCamera();
  },
});

// Wire display bus to quadrant SSOT (w23). The bus holds currentDisplay and a
// listener set; this bridge synchronizes the two modules once the quadrant is
// live, then on every quadrant change.
_syncDisplayMode(getViewportQuadrant().display);
onViewportQuadrantChange((q) => _syncDisplayMode(q.display));

app.value.start();
installFpsReport();
installPreviewControls();
installErrorOverlay();
markBootComplete(); // boot reached the live render loop — cancel the dead-boot watchdog

// ── Game input chain liveness (feat-20260630-viewport M4 / w18, §8 + AC-10) ──
// Single-world model (C-1): the game's systems run in THIS edit world. For the
// play·game quadrant their input must flow DOM → InputBackend → InputFrameStartScan
// → InputSnapshot resource → game system (requirements §8). createApp's canvas
// form already wires that chain: it calls attachInputAuto(canvas, world) — which
// inserts INPUT_BACKEND_KEY and mounts the DOM listeners — and runs inputPlugin(),
// which registers InputFrameStartScan (engine/app create-app.ts:472 + plugin-
// factories inputPlugin). So the chain is LIVE here through createApp, NOT absent:
// research Finding 5 grepped main.tsx for a literal `attachInputAuto` (0 hits) and
// read it as "edit-runtime has no game input chain", but the engine's M3/w15 cut
// (canvas form always attaches input) means the chain rides createApp. We do NOT
// re-attach here — a second attachInputAuto would double-bind the DOM listeners.
//
// Instead verify the chain at boot and emit a health breadcrumb (the AC's required
// observable surface). The InputBackend resource is present immediately; the
// InputSnapshot resource is written by InputFrameStartScan on the first world
// update, so it appears one frame after start().
{
  const liveWorld = world as unknown as { hasResource(key: string): boolean };
  const hasBackend = liveWorld.hasResource(INPUT_BACKEND_KEY);
  // The scan system is registered iff the backend resource was present when
  // inputPlugin ran (inputPlugin is a no-op without it). InputSnapshot lands on
  // the first tick — check on the next frame so we observe the populated chain.
  requestAnimationFrame(() => {
    const hasSnapshot = liveWorld.hasResource(INPUT_SNAPSHOT_RESOURCE_KEY);
    if (hasBackend && hasSnapshot) {
      emitBoot('input ▸ game input chain live (InputBackend + InputFrameStartScan + InputSnapshot)');
    } else {
      emitBoot(`input ▸ game input chain incomplete (backend=${hasBackend} snapshot=${hasSnapshot})`, 'warn');
    }
  });
}

// ── Game logic startup (feat-20260630-viewport M2 / w10-w12, research Finding 2) ──
// Single-world model (requirements C-1): the game runs in THIS edit world, its
// systems gated by `notEditing`, flipped by ▶/■ via injectEditMode. The game's
// real system-registration point is its `bootstrap(world, ctx)` entry (all shipped
// games register through `world.addSystem` / `ctx.registerUpdate` inside bootstrap
// — grep `defineSystem` = 0 hits). ▶ Play calls that entry on the edit world
// (createRunLifecycle below, D-1). The former discoverModules `src/` tree-walk was
// deleted here: it found zero systems for real games (no `defineSystem` side
// effects to diff) and was never their startup path.

// Environment: load an HDR → IBL Skylight (ambient/specular fill) + visible
// SkyboxBackground. Uses the shared template HDR (matches what ▶ Play installs
// through the engine asset pack catalog at GUID 81eec382-...) — interface vite
// proxies `/preview/*` to the editor-play-runtime, which serves shared-assets/
// from its vite root. Falls back to a synthetic neutral gradient only when
// the shared HDR doesn't resolve. Async precompute; the scene renders
// meanwhile. Chromium-only (WebKit can't do the rgba16float IBL path).
//
// Per-game HDR overrides used to be probed at `assets/sky.hdr` first, but no
// shipped game uses that mechanism (cow-survivor + the template both go through
// the GUID catalog), so the eager probe just produced a guaranteed 404 in the
// browser console. If a future game wants its own HDR, surface it via forge.json
// instead and prepend the explicit path here — the multi-URL fallback already
// supports it.
void setupEditorSkylight(
  world as never,
  renderer.assets as never,
  (renderer as unknown as { store: never }).store,
  { hdrUrl: '/preview/shared-assets/template-game-default/sky.hdr' },
);

// Preload any GltfRef GLBs so ✎ Edit shows the SAME real geometry as ▶ Play.
// instantiateScene only spawns a placeholder cube for a GltfRef until its GLB
// is decoded into the shared @forgeax/scene gltf cache — the editor never did
// this, so GLB-based scenes (e.g. fps's IntelliScene arena) showed a placeholder
// in Edit. Mirror fps/main.ts's Play-side preload, then resync so the real
// geometry renders. GLBs fetch via the server's raw-file endpoint.
{
  const fetchGlb = async (p: string): Promise<ArrayBuffer> => {
    const r = await getApiClient().fetch(`/api/files/raw?path=${encodeURIComponent(p)}`);
    if (!r.ok) throw new Error(`glb ${r.status}`);
    return r.arrayBuffer();
  };
  // Track already-decoded GLBs so the bus-driven re-run (below) only fetches a
  // freshly-added GltfRef once, not on every doc mutation. `failedGltfPaths`
  // holds GLBs whose expansion threw at instantiate time — they stay as
  // placeholder cubes and are NOT retried (otherwise every bus tick re-throws).
  const loadedGltfPaths = new Set<string>();
  const failedGltfPaths = new Set<string>();
  const preloadGltfRefs = async (): Promise<void> => {
    const paths = new Set<string>();
    for (const e of Object.values(bus.doc.entities)) {
      const p = (e?.components as { GltfRef?: { path?: string } } | undefined)?.GltfRef?.path;
      if (typeof p === 'string' && p && !loadedGltfPaths.has(p) && !failedGltfPaths.has(p)) paths.add(p);
    }
    if (paths.size === 0) return;
    let landed = false;
    await Promise.all([...paths].map((p) =>
      loadGltfRuntime(p, fetchGlb, renderer.assets as never, world as never)
        .then(() => { loadedGltfPaths.add(p); landed = true; })
        .catch((err) => console.warn('[editor] GLB preload failed:', p, (err as Error)?.message ?? err))));
    // The GLB landed in the gltf-runtime cache but the doc sig is unchanged, so a
    // plain resync() would no-op — force a rebuild so sceneEntities re-projects
    // the now-loaded GLB into its real per-node geometry.
    // Guard the rebuild: if the expanded GLB trips a mid-instantiate throw (e.g.
    // a per-mesh material/submesh count mismatch), an unguarded forceResync leaves
    // the WHOLE scene despawned (everything vanishes). On failure, EVICT the just-
    // loaded GLBs from the gltf cache (so getLoadedGltf → null → placeholder cube)
    // and quarantine them in failedGltfPaths (so the next bus tick doesn't reload
    // + re-throw forever), then resync to a degraded-but-visible scene.
    if (landed) {
      try {
        engineSync.forceResync();
      } catch (err) {
        console.warn('[editor] GLB preload resync failed — reverting to placeholder:', (err as Error)?.message ?? err);
        for (const p of paths) {
          _clearGltfCache(p);
          loadedGltfPaths.delete(p);
          failedGltfPaths.add(p);
        }
        try { engineSync.forceResync(); } catch { /* leave as-is */ }
      }
    }
  };
  // Initial pass + re-run whenever the doc changes (a fresh whole-GLB drag adds a
  // GltfRef entity — without the re-run it stays a placeholder cube forever).
  void preloadGltfRefs();
  bus.subscribe(() => { void preloadGltfRefs(); });
}

// Preload imported mesh sub-assets referenced by Mesh.meshAsset (e.g. a glTF mesh
// dragged from the Content Browser). These live in .meta.json/DDC, not in the
// game's *.pack.json, so loadGameAssets never sees them — load each via the
// runtime asset registry (loadByGuid → allocSharedRef), mint a MeshAsset handle
// into `preloadedMeshes`, then forceResync so instantiateScene's resolveMeshAsset
// hits the cache and renders real geometry instead of the placeholder cube.
// (Mirrors the GltfRef preload above + the preview.skin loadByGuid path.)
{
  // GUIDs whose load already failed (bad guid / catalog miss / loader throw).
  // preloadMeshes re-runs on EVERY bus mutation, and a failed GUID never lands
  // in `preloadedMeshes`, so without this quarantine a stale/dangling meshAsset
  // ref (e.g. an old builtin-cube GUID a pre-migration scene still carries)
  // re-issues loadByGuid → POST /__import → 404 on every doc edit, flooding the
  // console. Mirrors the `failedGltfPaths` quarantine in the GltfRef preload.
  const failedMeshGuids = new Set<string>();
  const collectMeshGuids = (): Set<string> => {
    const guids = new Set<string>();
    const packMeshGuids = new Set(packAssets.filter((a) => a.kind === 'mesh').map((a) => a.guid));
    for (const e of Object.values(bus.doc.entities)) {
      const g = (e?.components as { Mesh?: { meshAsset?: string } } | undefined)?.Mesh?.meshAsset;
      if (typeof g === 'string' && g && !packMeshGuids.has(g) && !preloadedMeshes.has(g) && !failedMeshGuids.has(g)) guids.add(g);
    }
    return guids;
  };
  const preloadMeshes = async (): Promise<void> => {
    const guids = collectMeshGuids();
    if (guids.size === 0) return;
    // loadByGuid takes a PARSED AssetGuid (it keys on AssetGuid.format(guid)),
    // NOT a raw string — passing the string yields a garbage key → catalog miss
    // → the mesh never loads and the entity stays a placeholder cube.
    const { AssetGuid } = await import('@forgeax/engine-pack/guid');
    let landed = false;
    await Promise.all([...guids].map(async (g) => {
      try {
        const parsed = (AssetGuid as { parse: (s: string) => { ok: boolean; value?: unknown } }).parse(g);
        if (!parsed.ok || parsed.value === undefined) { failedMeshGuids.add(g); console.warn('[editor] mesh preload bad guid:', g); return; }
        const res = await (renderer.assets as never as { loadByGuid: (guid: unknown) => Promise<{ ok: boolean; value?: unknown; error?: { code?: string } }> }).loadByGuid(parsed.value);
        if (!res.ok) { failedMeshGuids.add(g); console.warn('[editor] mesh preload miss:', g, res.error?.code); return; }
        const handle = (world as never as { allocSharedRef: (brand: string, payload: unknown) => unknown }).allocSharedRef('MeshAsset', res.value);
        preloadedMeshes.set(g, handle);
        // Capture the submesh count alongside the handle so the instantiator can
        // size MeshRenderer.materials to it (equal-length contract). Set together
        // with the handle → resolveMeshAsset / resolveMeshSubmeshCount stay in lockstep.
        const subs = (res.value as { submeshes?: { length?: number } } | undefined)?.submeshes;
        if (typeof subs?.length === 'number' && subs.length > 0) preloadedMeshSubmeshCounts.set(g, subs.length);
        landed = true;
      } catch (err) {
        failedMeshGuids.add(g);
        console.warn('[editor] mesh preload failed:', g, (err as Error)?.message ?? err);
      }
    }));
    // Re-instantiate so resolveMeshAsset picks up the freshly-minted handles. If
    // a handle is somehow incompatible, re-instantiate would throw mid-rebuild
    // and leave the scene despawned (a dropped mesh — and everything else —
    // vanishes). Guard it: on failure, drop the just-loaded handles so the next
    // resync falls back to the placeholder cube (degraded but visible) instead
    // of an empty viewport.
    if (landed) {
      try {
        engineSync.forceResync();
      } catch (err) {
        console.warn('[editor] mesh preload resync failed — reverting to placeholder:', (err as Error)?.message ?? err);
        for (const g of guids) { preloadedMeshes.delete(g); preloadedMeshSubmeshCounts.delete(g); }
        try { engineSync.forceResync(); } catch { /* leave as-is */ }
      }
    }
  };
  // Initial pass + re-run whenever the doc changes (a fresh drag adds a meshAsset).
  void preloadMeshes();
  bus.subscribe(() => { void preloadMeshes(); });
}

// Preload ORIGINAL per-submesh materials recovered for a dropped mesh
// (Material.submeshMaterials — see editor-core/resolveMeshOriginalMaterials).
// These glTF material sub-assets live in .meta.json/DDC, not the game pack, so
// loadGameAssets never sees them. Load each via loadByGuid → allocSharedRef →
// preloadedMaterials, then forceResync so materialSlots resolves them per submesh
// (restoring the source materials instead of the grey placeholder). The recursive
// loader pulls each material's texture sub-asset refs. Mirrors preloadMeshes.
{
  const collectMaterialGuids = (): Set<string> => {
    const guids = new Set<string>();
    const packMatGuids = new Set(packAssets.filter((a) => a.kind === 'material').map((a) => a.guid));
    for (const e of Object.values(bus.doc.entities)) {
      const subs = (e?.components as { Material?: { submeshMaterials?: string[] } } | undefined)?.Material?.submeshMaterials;
      if (!Array.isArray(subs)) continue;
      for (const g of subs) {
        if (typeof g === 'string' && g && !packMatGuids.has(g) && !preloadedMaterials.has(g)) guids.add(g);
      }
    }
    return guids;
  };
  const preloadMaterials = async (): Promise<void> => {
    const guids = collectMaterialGuids();
    if (guids.size === 0) return;
    const { AssetGuid } = await import('@forgeax/engine-pack/guid');
    let landed = false;
    await Promise.all([...guids].map(async (g) => {
      try {
        const parsed = (AssetGuid as { parse: (s: string) => { ok: boolean; value?: unknown } }).parse(g);
        if (!parsed.ok || parsed.value === undefined) { console.warn('[editor] material preload bad guid:', g); return; }
        const res = await (renderer.assets as never as { loadByGuid: (guid: unknown) => Promise<{ ok: boolean; value?: unknown; error?: { code?: string } }> }).loadByGuid(parsed.value);
        if (!res.ok) { console.warn('[editor] material preload miss:', g, res.error?.code); return; }
        const handle = (world as never as { allocSharedRef: (brand: string, payload: unknown) => unknown }).allocSharedRef('MaterialAsset', res.value);
        preloadedMaterials.set(g, handle);
        landed = true;
      } catch (err) {
        console.warn('[editor] material preload failed:', g, (err as Error)?.message ?? err);
      }
    }));
    // Re-instantiate so materialSlots picks up the freshly-minted handles. Guard
    // the resync (an incompatible handle would throw mid-rebuild → blank scene):
    // on failure drop the just-loaded handles so the next resync falls back to the
    // single placeholder material (degraded but visible).
    if (landed) {
      try {
        engineSync.forceResync();
      } catch (err) {
        console.warn('[editor] material preload resync failed — reverting to placeholder:', (err as Error)?.message ?? err);
        for (const g of guids) preloadedMaterials.delete(g);
        try { engineSync.forceResync(); } catch { /* leave as-is */ }
      }
    }
  };
  // Initial pass + re-run whenever the doc changes (a fresh drag adds submeshMaterials).
  void preloadMaterials();
  bus.subscribe(() => { void preloadMaterials(); });
}

// Selected mesh sub-asset → publish geometry stats to the Mesh panel.
// meta.json mesh sub-assets carry no geometry in the Content Browser payload and
// the panel iframes hold no asset registry — so the MAIN window (which owns the
// registry) loads the selected mesh via loadByGuid, derives geometry-free stats
// (vertices / primitives-by-topology / submeshes / index format / AABB) and
// broadcasts them (store.publishMeshStats). Design: docs/design/editor-mesh-panel.md §4.3.
{
  const primCount = (topology: string, indexCount: number, vertexCount: number): number => {
    const n = indexCount > 0 ? indexCount : vertexCount;
    switch (topology) {
      case 'triangle-list': return Math.floor(n / 3);
      case 'triangle-strip': return Math.max(0, n - 2);
      case 'line-list': return Math.floor(n / 2);
      case 'line-strip': return Math.max(0, n - 1);
      case 'point-list': return n;
      default: return Math.floor(n / 3);
    }
  };
  const emptyStats = (guid: string, error: string) =>
    ({ guid, vertexCount: 0, primitiveCount: 0, indexFormat: 'none' as const, submeshes: [], attributes: [], error });
  // The "active mesh" mirrors MeshPanel's render precedence so the guid we publish
  // ALWAYS matches the guid the panel wants to show (else the panel waits forever on
  // a guid mismatch). Precedence: a selected entity WITH a Mesh component owns the
  // panel (entity mode) → its meshAsset guid (or null for an inline primitive — no
  // geometry to load); otherwise a selected mesh sub-asset (asset-preview mode).
  // Design: docs/design/editor-mesh-panel-ue58-parity.md.
  const activeMeshGuid = (): string | null => {
    const selId = getSelection();
    if (selId !== null) {
      const mesh = bus.doc.entities[selId]?.components.Mesh as Record<string, unknown> | undefined;
      if (mesh) {
        const g = typeof mesh.meshAsset === 'string' ? mesh.meshAsset : '';
        return g.length > 0 ? g : null; // inline primitive → no guid → no stats
      }
      // entity without a Mesh component → panel falls back to asset preview
    }
    const a = getAssetSelection();
    return a?.kind === 'mesh' ? a.guid : null;
  };
  let lastGuid: string | null = null;
  const publishForActiveMesh = async (): Promise<void> => {
    const guid = activeMeshGuid();
    if (guid === lastGuid) return; // active mesh unchanged — skip reload
    lastGuid = guid;
    if (guid === null) { publishMeshStats(null); return; } // no mesh in focus → clear
    try {
      const { AssetGuid } = await import('@forgeax/engine-pack/guid');
      const parsed = (AssetGuid as { parse: (s: string) => { ok: boolean; value?: unknown } }).parse(guid);
      if (!parsed.ok || parsed.value === undefined) { publishMeshStats(emptyStats(guid, 'bad guid')); return; }
      const res = await (renderer.assets as never as { loadByGuid: (g: unknown) => Promise<{ ok: boolean; value?: unknown; error?: { code?: string } }> }).loadByGuid(parsed.value);
      if (activeMeshGuid() !== guid) return; // focus moved on — drop stale result
      if (!res.ok || res.value === undefined) { publishMeshStats(emptyStats(guid, res.error?.code ?? 'load miss')); return; }
      const mesh = res.value as {
        vertices?: { byteLength?: number };
        indices?: unknown;
        attributes?: Record<string, unknown>;
        aabb?: { length: number; [i: number]: number };
        submeshes?: readonly { topology: string; indexCount: number; vertexCount: number }[];
      };
      const indices = mesh.indices;
      const indexFormat: 'u16' | 'u32' | 'none' =
        indices instanceof Uint32Array ? 'u32' : indices instanceof Uint16Array ? 'u16' : 'none';
      const subs = (mesh.submeshes ?? []).map((s) => ({
        topology: s.topology, indexCount: s.indexCount, vertexCount: s.vertexCount,
        primitiveCount: primCount(s.topology, s.indexCount, s.vertexCount),
      }));
      const ab = mesh.aabb;
      const aabb = ab && ab.length === 6 ? [0, 1, 2, 3, 4, 5].map((i) => ab[i] ?? 0) : undefined;
      // CPU geometry footprint (interleaved vertex buffer + index buffer). NOT the
      // GPU resource size. See editor-mesh-panel-ue58-parity.md §6.4.
      const vBytes = typeof mesh.vertices?.byteLength === 'number' ? mesh.vertices.byteLength : 0;
      const iBytes = indices instanceof Uint16Array || indices instanceof Uint32Array ? indices.byteLength : 0;
      const byteSize = vBytes + iBytes;
      // `vertices` is an INTERLEAVED buffer (stride 12/18 floats — pos/nrm/uv/tan
      // [+skin]); its length is NOT a vertex count. Per-stream position is absent
      // from `attributes` (only skinIndex/skinWeight ride along). So derive the
      // vertex count by summing each submesh's vertex span — glTF primitives don't
      // share vertices, so the sum is the mesh total. See engine mesh-bin.ts.
      publishMeshStats({
        guid,
        vertexCount: subs.reduce((a, s) => a + s.vertexCount, 0),
        primitiveCount: subs.reduce((a, s) => a + s.primitiveCount, 0),
        indexFormat,
        submeshes: subs,
        ...(aabb ? { aabb } : {}),
        ...(byteSize > 0 ? { byteSize } : {}),
        attributes: mesh.attributes ? Object.keys(mesh.attributes) : [],
      });
    } catch (err) {
      publishMeshStats(emptyStats(guid, (err as Error)?.message ?? 'load failed'));
    }
  };
  // Re-publish when any focus that drives the panel changes: asset selection
  // (asset-preview), entity selection (entity mode), or a doc edit rebinding the
  // selected entity's meshAsset. The activeMeshGuid()+lastGuid dedupe keeps the
  // frequent bus.subscribe callback a cheap string compare unless the guid moved.
  onAssetSelectionChange(() => { void publishForActiveMesh(); });
  onSelectionChange(() => { void publishForActiveMesh(); });
  bus.subscribe(() => { void publishForActiveMesh(); });
  void publishForActiveMesh();
}

// Cross-window sync: this is the MAIN window — broadcast snapshots to any
// popped-out panel windows and apply their forwarded edits (design §0.2.2).
initSync();

// ── Skinned-mesh + animation preview hook (per-game) ──────────────────────────
// Edit-mode wants to preview a skinned glb (e.g. hellforge's witch) alongside
// the authored scene, so artists can verify rig + anim clips without flipping
// to ▶ Play. Edit-mode persistence (Y.Doc → bus.doc) doesn't model Skin /
// AnimationPlayer / animation-clip, so we sidestep the doc layer entirely and
// instantiate the GLB sub-scene directly via the runtime asset registry — the
// SAME path hellforge Play uses (assets.loadByGuid(scene) + assets.instantiate
// + addComponent(AnimationPlayer)). Per-game opt-in via forge.json `preview:
// { skin: { sceneGuid, clipGuids[], clipDefault, scale?, pos? } }`.
void (async () => {
  const slug = getSceneId();
  if (!slug || slug === 'default') return;
  // Wait for the renderer to come online — loadByGuid before then races the
  // pack-index fetch and lands at `asset-not-imported` with no chance to retry.
  await renderer.ready.catch(() => null);
  try {
    // Load forge.json via the authoritative loader (AC-11) instead of fetch+parse.
    // fetchRead wraps the studio /api/files endpoint to match loadGameProject injection.
    const gameForgePath = resolveGamePath(FORGE_JSON);
    const fetchRead = async (path: string): Promise<string> => {
      const r = await getApiClient().fetch(`/api/files?path=${encodeURIComponent(gameForgePath)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { content?: string };
      if (!j.content) throw new Error('Empty content');
      return j.content;
    };
    const gpResult = await loadGameProject(fetchRead);
    if (!gpResult.ok) return;
    const skin = gpResult.value.preview?.skin;
    if (!skin?.sceneGuid) return;
    const { AnimationPlayer, Skin, SceneInstance, Transform, perspective: _p } = await import('@forgeax/engine-runtime');
    const { AssetGuid } = await import('@forgeax/engine-pack/guid');
    const assets = renderer.assets;
    const sceneGid = AssetGuid.parse(skin.sceneGuid);
    if (!sceneGid.ok) return;
    const sceneRes = await assets.loadByGuid(sceneGid.value);
    if (!sceneRes.ok) { console.warn('[editor] preview skin scene load failed:', (sceneRes.error as { code?: string })?.code); return; }
    // Teardown/switch guard: if the game changed while we awaited the scene
    // load, the previous world's shared-refs have been released. Instantiating
    // now resolves released handles ('shared-ref-released') and leaves a partial
    // skinned SceneInstance that wedges the renderer (engine runs but renders
    // nothing). Bail silently — the new game's hook will run its own preview.
    if (getSceneId() !== slug) return;
    // engine e53f4616: `loadByGuid` returns the PAYLOAD; `instantiate` wants a
    // Handle. Mint a shared-ref from the payload (mirrors hellforge Play). The
    // old code passed the payload straight in, where it was read as a released
    // handle → 'shared-ref-released' + a wedged partial instantiate on EVERY
    // hellforge Edit load (the only game with preview.skin).
    const sceneHandle = (world as never as { allocSharedRef: (brand: string, payload: unknown) => unknown }).allocSharedRef('SceneAsset', sceneRes.value);
    const inst = assets.instantiate(sceneHandle as never, world as never);
    if (!inst.ok) { console.warn('[editor] preview skin instantiate failed:', (inst.error as { code?: string })?.code); return; }
    const skinRoot = inst.value as { generation: number; index: number };
    // Apply preview placement (pos + scale) on the SceneInstance root.
    const [px, py, pz] = skin.pos ?? [0, 0, 0];
    const s = skin.scale ?? 1;
    (world as never as { set: (e: unknown, c: unknown, d: unknown) => unknown }).set(
      skinRoot, Transform, { posX: px, posY: py, posZ: pz, scaleX: s, scaleY: s, scaleZ: s, quatX: 0, quatY: 0, quatZ: 0, quatW: 1 },
    );
    // Find the Skin entity inside the instantiated hierarchy.
    const sceneInst = (world as never as { get: (e: unknown, c: unknown) => { ok: boolean; value?: { mapping: unknown[] } } }).get(skinRoot, SceneInstance);
    if (!sceneInst.ok || !sceneInst.value) return;
    let skinEnt: unknown = null;
    for (const ent of sceneInst.value.mapping) {
      if (!ent) continue;
      const r = (world as never as { get: (e: unknown, c: unknown) => { ok: boolean } }).get(ent, Skin);
      if (r.ok) { skinEnt = ent; break; }
    }
    if (!skinEnt) return;
    // Pick the default clip — load its handle if a guid was given, else first.
    const defaultName = skin.clipDefault ?? 'idle';
    const clipGuids = skin.clipGuids ?? [];
    if (clipGuids.length === 0) return;
    // Author convention: clipGuids[] mirrors the manifest order; clipDefault
    // matches one of those names — but we only get guids, so just use the
    // first available one. Authors who want a specific default put it first.
    const firstGid = AssetGuid.parse(clipGuids[0]!);
    if (!firstGid.ok) return;
    const clipRes = await assets.loadByGuid(firstGid.value);
    if (!clipRes.ok) { console.warn('[editor] preview skin clip load failed:', (clipRes.error as { code?: string })?.code); return; }
    if (getSceneId() !== slug) return; // game switched while loading the clip — don't touch a stale world
    // loadByGuid returns the PAYLOAD; AnimationPlayer.clip wants a Handle — mint
    // a shared-ref (brand 'AnimationClip'), same as hellforge Play.
    const clipHandle = (world as never as { allocSharedRef: (brand: string, payload: unknown) => unknown }).allocSharedRef('AnimationClip', clipRes.value);
    (world as never as { addComponent: (e: unknown, p: unknown) => unknown }).addComponent(skinEnt, {
      component: AnimationPlayer,
      data: { clip: clipHandle, time: 0, speed: 1, paused: false, looping: true },
    });
    console.log(`[editor] preview skin loaded for ${slug} (default clip via guid ${clipGuids[0]!.slice(0, 8)}, ${defaultName})`);
  } catch (err) {
    console.warn('[editor] preview skin hook failed:', (err as Error).message ?? err);
  }
})();

// Live-reload the scene when an external writer (an AI agent editing scene.json
// on disk) changes it — subscribes to the server's file-event WebSocket so the
// viewport rebuilds without a manual refresh. No-op in popout windows.
initDiskWatch();

// ── Flush pending edits before this editor surface goes away ──────────────────
// The editor autosaves on a short debounce, but ▶ Play reads the on-disk pack and
// the interface UNMOUNTS this iframe on a mode switch (edit→play) — which would
// kill an in-flight debounce timer and lose the last edit, so Play would render a
// stale scene. Flush eagerly via a teardown-safe sendBeacon when the page is
// hidden / unloaded, AND when the interface explicitly asks (VAG_EDITOR_FLUSH,
// posted right before it tears us down). Net: Play always reads the latest scene
// the instant the user flips to it — no race against the debounce, no lost edit.
window.addEventListener('pagehide', () => flushPendingSaveBeacon());
window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPendingSaveBeacon();
});
onVagMessage(window, {
  allowedOrigins: allowedParentOrigins(),
  handlers: { VAG_EDITOR_FLUSH: () => flushPendingSaveBeacon() },
});

// ── VAG postMessage bridge (parity with preview-runtime) ──────────────────────
function installFpsReport(): void {
  let frames = 0, accum = 0;
  app.value.registerUpdate((dt: number) => {
    frames++; accum += dt;
    if (accum >= 1) {
      const fps = Math.round(frames / accum);
      sendVagMessage(window.parent, VagFpsStatsSchema, { fps });
      setFps(fps); // feed the in-viewport FPS counter (GameOverlay + ViewportBar)
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

// Network bridge — fetch / XHR / WebSocket proxy → VAG_NETWORK (mirrors the
// console bridge). Feeds the Studio Network panel. Best-effort, never throws.
function installNetworkBridge(): void {
  const send = (kind: 'fetch' | 'xhr' | 'ws', method: string, url: string, status: number, ms: number, ok: boolean): void => {
    try {
      sendVagMessage(window.parent, VagNetworkSchema, { kind, method, url: String(url).slice(0, 2048), status, ms: Math.round(ms), ok, ts: Date.now() });
    } catch { /* cross-origin */ }
  };
  const origFetch = window.fetch?.bind(window);
  if (origFetch) {
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
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
    };
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

// On-canvas error surface. A per-frame render throw leaves the viewport BLACK
// with no visible signal (fps stays 60 because the draw fast-fails) — invisible
// in the desktop WKWebView where DevTools is off by default. This paints the
// underlying RhiError (incl. its .detail) into a red overlay so it can be read
// from a screenshot. De-dupes so it doesn't grow unbounded.
function installErrorOverlay(): void {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;top:8px;left:8px;right:8px;max-height:45%;overflow:auto;z-index:99999;'
    + 'background:rgba(140,10,10,0.94);color:#fff;font:12px/1.45 ui-monospace,monospace;padding:10px 12px;'
    + 'border-radius:6px;white-space:pre-wrap;display:none;pointer-events:none;box-shadow:0 2px 12px rgba(0,0,0,.5)';
  document.body.appendChild(box);
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

// Shape guards for VAG_SPAWN_ENTITY's `entity`/`doc` — the schema declares them
// `z.unknown()` (the engine ECS doc shape evolves independently), so we validate
// them HERE before they reach the authoritative bus.
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

function installPreviewControls(): void {
  // Origin-gated + schema-validated via onVagMessage. Previously this accepted
  // VAG_PREVIEW_* / VAG_SPAWN_ENTITY from ANY window with NO origin/source check
  // and fed `entity`/`doc` to bus.dispatch UNVALIDATED — any embedder could
  // pause/reload or spawn arbitrary entities into the authoritative editor bus.
  onVagMessage(window, {
    allowedOrigins: allowedParentOrigins(),
    handlers: {
      VAG_PREVIEW_PAUSE: () => app.value.pause(),
      VAG_PREVIEW_PLAY: () => app.value.resume(),
      VAG_PREVIEW_RELOAD: () => location.reload(),

      // Emitted by the interface shell after a successful auto-import pipeline
      // (upload → cook meta (engine toAssetPack) → import-scene). Dispatch to the authoritative
      // bus so the entity appears in Hierarchy and the BroadcastChannel snapshot
      // propagates to all ep:* panel iframes immediately.
      VAG_SPAWN_ENTITY: (msg) => {
        const p = msg.payload;
        if (p.mode === 'reference' && isSpawnRef(p.entity)) {
          bus.dispatch({ kind: 'spawnEntity', name: p.entity.name, components: p.entity.components });
        } else if (p.mode === 'full' && isSpawnDoc(p.doc)) {
          const doc = p.doc;
          const cmds = doc.order.map((id) => {
            const ent = doc.entities[id]!;
            return { kind: 'spawnEntity' as const, name: ent.name, parent: ent.parent ?? undefined, components: ent.components };
          });
          bus.dispatch({ kind: 'transaction', label: `Import: ${p.name ?? 'GLB'}`, commands: cmds });
        } else {
          console.warn('[edit] VAG_SPAWN_ENTITY: malformed entity/doc payload — ignored');
          return;
        }
        broadcastAssetsChanged();
      },

      // Relay from the interface shell to ep:* panel iframes so the Assets panel
      // Files tab refreshes its list after an import.
      VAG_ASSETS_CHANGED: () => broadcastAssetsChanged(),
    },
  });
}

function paintDiagnosticMessage(err: unknown): void {
  const overlay = document.createElement('div');
  // Sits in the CANVAS layer (#app), BEHIND the React panel layer (#ui), so the
  // dock/panels stay visible + usable without a GPU — it shows through only the
  // transparent Viewport leaf. (z-index:0 here, panels' .ed-overlay is z-index:5;
  // appending to #app keeps it under #ui in DOM/stacking order.)
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'display:flex', 'align-items:center', 'justify-content:center',
    'background:#1a1a1f', 'color:#ff8a8a', 'font:14px/1.5 ui-monospace,monospace',
    'padding:24px', 'box-sizing:border-box', 'z-index:0', 'white-space:pre-wrap', 'text-align:left',
  ].join(';');
  // EngineEnvironmentError carries a structured detail with webgpuError /
  // wgpuError — each is a RhiError shape with code/expected/hint/detail. The
  // outer "no usable backend" string is generic; the inner RhiError is the
  // real cause (often unrelated to GPU adapter — e.g. shader manifest 404
  // returning HTML, asset pipeline failure). Surface inner detail when present.
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
    lines.push(
      '',
      'Likely causes:',
      '  • No GPU adapter (headless VM without GPU)',
      '  • Insecure context (WebGPU needs HTTPS or localhost)',
      '  • iframe permissions policy blocking WebGPU',
    );
  }
  lines.push(
    '',
    'The editor panels (Hierarchy / Inspector / command bus) still work —',
    'edits persist to the document; rendering resumes once init succeeds.',
  );
  overlay.textContent = lines.join('\n');
  appRoot.appendChild(overlay);
}
} // end bootEditor
