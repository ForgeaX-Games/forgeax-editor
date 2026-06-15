// forgeax editor-runtime — P1.
//
// Boots the forgeax engine on a canvas (same path as @forgeax-studio/preview-
// runtime: createApp + VAG postMessage bridge + diagnostic overlay) AND mounts
// the React editor chrome (Hierarchy + Inspector + command-bus toolbar, ported
// from the unveil-studio prototype). The authored SceneDocument is projected
// onto the forgeax world by src/engine/sync.ts so what you edit renders with the
// SAME engine the game plays on (WYSIWYG).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Transform,
  Camera,
  perspective,
  TONEMAP_REINHARD_EXTENDED,
  DirectionalLight,
} from '@forgeax/engine-runtime';
import { createApp } from '@forgeax/engine-app';
import { loadGltfRuntime } from '@forgeax/editor-core';
import {
  sendVagMessage,
  VagConsoleSchema,
  VagFpsStatsSchema,
} from '@forgeax/editor-core/protocol';
import { EditorApp } from './EditorApp';
import { ViewportBar } from './ViewportBar';
import { ViewportHints } from './ViewportHints';
import { DetachedPanel } from './DetachedPanel';
import { ContextMenuHost } from '@forgeax/editor-shared';
import { createEngineSync } from './engine/sync';
import { setupEditorSkylight } from './engine/skylight';
import { createViewport } from './engine/viewport';
import { loadGameAssets, makeMaterialResolver } from '@forgeax/editor-core';
import { bus, loadDocFromStorage, loadDocFromDisk, setSceneId, getSceneId, getSceneFile, initSync, initDiskWatch, initSceneList, broadcastAssetsChanged, flushPendingSaveBeacon } from '@forgeax/editor-shared';
import { getPopoutPanel } from '@forgeax/editor-core';
import './theme.css';

// Bind persistence to the active game/scene (`?scene=<slug>` passed by the
// interface EditMode iframe). Each game gets its OWN editor scene — without this
// every game shared one global doc, so picking shoot-opt showed whatever was
// last edited (or the demo). Must run before loadDocFromStorage below.
setSceneId(new URLSearchParams(location.search).get('scene'));
// Discover the game's multi-scene manifest (forge.json `scenes`) BEFORE any doc
// load so paths/storage keys resolve to the active scene file (UE level model).
await initSceneList();

// ── Viewport-only mode (design: outer DockShell flat architecture) ────────────
// Launched with `?viewportOnly=1`, this runs the engine + bus + BroadcastChannel
// sync (as the authoritative "main") but mounts NO React panels — only the engine
// canvas. All editor panels live in the outer DockShell as separate `ep:*` panel
// iframes (?panel=X), each connecting via BroadcastChannel. This gives the
// viewport maximum space while panels are arranged at the outer level.
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
if (!(await loadDocFromDisk()) && !loadDocFromStorage()) seed();

// Mount the React chrome immediately so the editor is usable even if WebGPU is
// unavailable (the canvas behind it shows the diagnostic overlay in that case).
// viewportOnly: skip the full DockManager but mount a minimal ViewportBar so
// Undo/Redo/Save/W-E-R are reachable directly from the viewport panel.
const uiRoot = document.getElementById('ui');
if (uiRoot) {
  createRoot(uiRoot).render(
    <StrictMode>
      {viewportOnly ? <ViewportBar /> : <EditorApp />}
      <ViewportHints />
    </StrictMode>,
  );
}

// ── Engine boot ───────────────────────────────────────────────────────────────
// engine #311 reshaped createApp: shaderManifestUrl moved off the 2nd-arg
// options onto the 3rd-arg BundlerOptions. The editor supplies its own manifest
// path (not the virtual:forgeax/bundler adapter), so pass it as the bundler arg.
const app = await createApp(canvas, {}, {
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
if (!app.ok) {
  paintDiagnosticMessage(app.error);
  throw new Error('[editor] createApp failed');
}

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

(window as unknown as Record<string, unknown>).__forgeax_editor = { app: app.value, world, renderer, bus };
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
  { component: Camera, data: { ...perspective({ fov: Math.PI / 3, aspect }), tonemap: TONEMAP_REINHARD_EXTENDED } },
).unwrap();

// Load the open game's asset packs once, so a Material.materialAsset GUID
// renders as the referenced asset material (registered from the pack payload —
// the editor's pack-index is empty, so we can't loadByGuid). Sync lookup → the
// instantiator stays synchronous.
const packAssets = await loadGameAssets(getSceneId());
const resolveMaterialAsset = makeMaterialResolver(renderer.assets as never, packAssets);

// Wire the authored doc → forgeax world (rebuilds on every bus change). The
// doc→world mapping is @forgeax/scene's instantiateScene — the same path ▶ Play
// uses — so the editor renders geometry/PBR/emissive/lights at full fidelity.
const engineSync = createEngineSync(world as never, renderer as never, resolveMaterialAsset);

// Asset-edit mode: a standalone prefab-style pack (Assets 面板的怪物/角色资产,
// id `monster:<name>` / `character:<name>`) is a few units tall at the origin —
// the arena-scale default framing leaves it a speck on the horizon, and without
// a scene Sun its PBR reads near-black. Frame close-up and add a neutral key
// light (NOT part of the doc, so it never saves into the asset).
const sceneFile = getSceneFile() ?? '';
const isAssetEdit = sceneFile.startsWith('monster:') || sceneFile.startsWith('character:');
if (isAssetEdit) {
  world.spawn(
    { component: Transform, data: {} },
    { component: DirectionalLight, data: { directionX: -0.5, directionY: -1, directionZ: -0.6, colorR: 1, colorG: 0.97, colorB: 0.92, intensity: 2.6 } },
  );
  world.spawn(
    { component: Transform, data: {} },
    { component: DirectionalLight, data: { directionX: 0.6, directionY: -0.3, directionZ: 0.7, colorR: 0.5, colorG: 0.6, colorB: 0.9, intensity: 0.9 } },
  );
}

// Viewport interaction: orbit/pan/zoom camera, click-to-select, drag-to-move.
const viewport = createViewport({
  canvas, world: world as never, assets: renderer.assets as never, camera: cameraEntity, sync: engineSync,
  ...(isAssetEdit ? { initialOrbit: { target: [0, -0.9, 0] as [number, number, number], dist: 8.5, pitch: -0.18 } } : {}),
});
window.addEventListener('resize', () => viewport.refresh());

app.value.start();
installFpsReport();
installPreviewControls();
installErrorOverlay();

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
    const r = await fetch(`/api/files/raw?path=${encodeURIComponent(p)}`);
    if (!r.ok) throw new Error(`glb ${r.status}`);
    return r.arrayBuffer();
  };
  void (async () => {
    const paths = new Set<string>();
    for (const e of Object.values(bus.doc.entities)) {
      const p = (e?.components as { GltfRef?: { path?: string } } | undefined)?.GltfRef?.path;
      if (typeof p === 'string' && p) paths.add(p);
    }
    if (paths.size === 0) return;
    await Promise.all([...paths].map((p) =>
      loadGltfRuntime(p, fetchGlb, renderer.assets as never).catch((err) => console.warn('[editor] GLB preload failed:', p, (err as Error)?.message ?? err))));
    // The GLB landed in the gltf-runtime cache but the doc sig is unchanged, so a
    // plain resync() would no-op — force a rebuild so sceneEntities re-projects
    // the now-loaded GLB into its real per-node geometry.
    engineSync.forceResync();
  })();
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
    const fj = await fetch(`/api/files?path=.forgeax%2Fgames%2F${encodeURIComponent(slug)}%2Fforge.json`, { cache: 'no-store' })
      .catch(() => null);
    if (!fj || !fj.ok) return;
    const wrapper = (await fj.json()) as { content?: string };
    if (typeof wrapper?.content !== 'string') return;
    const cfg = JSON.parse(wrapper.content) as { preview?: { skin?: { sceneGuid: string; clipGuids?: string[]; clipDefault?: string; scale?: number; pos?: [number, number, number] } } };
    const skin = cfg?.preview?.skin;
    if (!skin?.sceneGuid) return;
    const { AnimationPlayer, Skin, SceneInstance, Transform, perspective: _p } = await import('@forgeax/engine-runtime');
    const { AssetGuid } = await import('@forgeax/engine-pack/guid');
    const assets = renderer.assets;
    const sceneGid = AssetGuid.parse(skin.sceneGuid);
    if (!sceneGid.ok) return;
    const sceneRes = await assets.loadByGuid(sceneGid.value);
    if (!sceneRes.ok) { console.warn('[editor] preview skin scene load failed:', (sceneRes.error as { code?: string })?.code); return; }
    const inst = assets.instantiate(sceneRes.value, world as never);
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
    (world as never as { addComponent: (e: unknown, p: unknown) => unknown }).addComponent(skinEnt, {
      component: AnimationPlayer,
      data: { clip: clipRes.value, time: 0, speed: 1, paused: false, looping: true },
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
window.addEventListener('message', (ev: MessageEvent) => {
  if ((ev?.data as { type?: string } | undefined)?.type === 'VAG_EDITOR_FLUSH') flushPendingSaveBeacon();
});

// ── VAG postMessage bridge (parity with preview-runtime) ──────────────────────
function installFpsReport(): void {
  let frames = 0, accum = 0;
  app.value.registerUpdate((dt: number) => {
    frames++; accum += dt;
    if (accum >= 1) {
      const fps = Math.round(frames / accum);
      sendVagMessage(window.parent, VagFpsStatsSchema, { fps });
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

function installPreviewControls(): void {
  window.addEventListener('message', (ev) => {
    const data = ev?.data as { type?: string; payload?: unknown } | undefined;
    if (!data || typeof data.type !== 'string') return;
    switch (data.type) {
      case 'VAG_PREVIEW_PAUSE': app.value.pause(); break;
      case 'VAG_PREVIEW_PLAY': app.value.resume(); break;
      case 'VAG_PREVIEW_RELOAD': location.reload(); break;

      case 'VAG_SPAWN_ENTITY': {
        // Emitted by the interface shell after a successful auto-import pipeline
        // (upload → process-gltf → import-scene). Dispatch to the authoritative
        // bus so the entity appears in Hierarchy and the BroadcastChannel snapshot
        // propagates to all ep:* panel iframes immediately.
        const p = data.payload as { mode?: string; entity?: unknown; doc?: unknown; name?: string } | undefined;
        if (!p) break;
        if (p.mode === 'reference' && p.entity) {
          const e = p.entity as { name: string; components: Record<string, unknown> };
          bus.dispatch({ kind: 'spawnEntity', name: e.name, components: e.components });
        } else if (p.mode === 'full' && p.doc) {
          const doc = p.doc as { order: number[]; entities: Record<number, { name: string; parent: number | null; components: Record<string, unknown> }> };
          const cmds = doc.order.map((id) => {
            const ent = doc.entities[id]!;
            return { kind: 'spawnEntity' as const, name: ent.name, parent: ent.parent ?? undefined, components: ent.components };
          });
          bus.dispatch({ kind: 'transaction', label: `Import: ${p.name ?? 'GLB'}`, commands: cmds });
        }
        broadcastAssetsChanged();
        break;
      }

      case 'VAG_ASSETS_CHANGED':
        // Relay from the interface shell to ep:* panel iframes so Assets panel
        // Files tab refreshes its list after an import.
        broadcastAssetsChanged();
        break;
    }
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
