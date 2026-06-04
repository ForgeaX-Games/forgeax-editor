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
} from '@forgeax/engine-runtime';
import { createApp } from '@forgeax/engine-app';
import { EditorApp } from './EditorApp';
import { createEngineSync } from './engine/sync';
import { createViewport } from './engine/viewport';
import { loadGameAssets, makeMaterialResolver } from './core/assets';
import { bus, loadDocFromStorage, loadDocFromDisk, setSceneId, getSceneId } from './store';
import './ui/theme.css';

// Bind persistence to the active game/scene (`?scene=<slug>` passed by the
// interface EditMode iframe). Each game gets its OWN editor scene — without this
// every game shared one global doc, so picking shoot-opt showed whatever was
// last edited (or the demo). Must run before loadDocFromStorage below.
setSceneId(new URLSearchParams(location.search).get('scene'));

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
  bus.dispatch({ kind: 'spawnEntity', name: 'Level', components: {} });
  const level = (bus.ledger.at(-1) as { _id: number })._id;
  bus.dispatch({
    kind: 'spawnEntity',
    name: 'Sun',
    parent: level,
    components: { Light: { type: 'directional', intensity: 1.2, color: '#fff8e0', directionX: -0.4, directionY: -1, directionZ: -0.3 } },
  });
  bus.dispatch({
    kind: 'spawnEntity',
    name: 'Crate',
    parent: level,
    components: { Transform: { x: 1, y: 0, z: 0 }, Mesh: { kind: 'cube' }, Material: { albedo: '#b87333', metallic: 0, roughness: 0.8 } },
    source: { plugin: 'lowpoly', docId: 'crate-01' },
  });
  bus.dispatch({
    kind: 'spawnEntity',
    name: 'Ball',
    parent: level,
    components: { Transform: { x: -1, y: 0, z: -1 }, Mesh: { kind: 'sphere' }, Material: { albedo: '#6cc6ff', emissive: '#6cc6ff', emissiveIntensity: 0.6 } },
  });
}
// Load order: the game's on-disk authored scene → localStorage mirror → demo
// seed. So opening a game shows ITS saved scene (if authored); a fresh game
// starts from the seed and persists per-game from there.
if (!(await loadDocFromDisk()) && !loadDocFromStorage()) seed();

// Mount the React chrome immediately so the editor is usable even if WebGPU is
// unavailable (the canvas behind it shows the diagnostic overlay in that case).
const uiRoot = document.getElementById('ui');
if (uiRoot) {
  createRoot(uiRoot).render(
    <StrictMode>
      <EditorApp />
    </StrictMode>,
  );
}

// ── Engine boot ───────────────────────────────────────────────────────────────
const app = await createApp(canvas, { shaderManifestUrl: `${BASE}/shaders/manifest.json` });
if (!app.ok) {
  paintDiagnosticMessage(app.error);
  throw new Error('[editor] createApp failed');
}

const { world, renderer } = app.value;
renderer.assets.configurePackIndex(`${BASE}/pack-index.json`);

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
  { component: Camera, data: perspective({ fov: Math.PI / 3, aspect }) },
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

// Viewport interaction: orbit/pan/zoom camera, click-to-select, drag-to-move.
const viewport = createViewport({ canvas, world: world as never, assets: renderer.assets as never, camera: cameraEntity, sync: engineSync });
window.addEventListener('resize', () => viewport.refresh());

app.value.start();
installFpsReport();
installPreviewControls();

// ── VAG postMessage bridge (parity with preview-runtime) ──────────────────────
function installFpsReport(): void {
  let frames = 0, accum = 0;
  app.value.registerUpdate((dt: number) => {
    frames++; accum += dt;
    if (accum >= 1) {
      const fps = Math.round(frames / accum);
      try { window.parent?.postMessage({ type: 'VAG_FPS_STATS', payload: { fps } }, '*'); } catch { /* cross-origin */ }
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
        window.parent?.postMessage({ type: 'VAG_CONSOLE', payload: { level, text, ts: Date.now() } }, '*');
      } catch { /* cross-origin */ }
    };
  });
  window.addEventListener('error', (ev) => {
    try { window.parent?.postMessage({ type: 'VAG_CONSOLE', payload: { level: 'error', text: `${ev.message}\n  at ${ev.filename}:${ev.lineno}`, ts: Date.now() } }, '*'); } catch { /* */ }
  });
  window.addEventListener('unhandledrejection', (ev) => {
    try { window.parent?.postMessage({ type: 'VAG_CONSOLE', payload: { level: 'error', text: `unhandled rejection: ${String(ev.reason)}`, ts: Date.now() } }, '*'); } catch { /* */ }
  });
}

function installPreviewControls(): void {
  window.addEventListener('message', (ev) => {
    const data = ev?.data as { type?: string } | undefined;
    if (!data || typeof data.type !== 'string') return;
    switch (data.type) {
      case 'VAG_PREVIEW_PAUSE': app.value.pause(); break;
      case 'VAG_PREVIEW_PLAY': app.value.resume(); break;
      case 'VAG_PREVIEW_RELOAD': location.reload(); break;
    }
  });
}

function paintDiagnosticMessage(err: unknown): void {
  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'display:flex', 'align-items:center', 'justify-content:center',
    'background:#1a1a1f', 'color:#ff8a8a', 'font:14px/1.5 ui-monospace,monospace',
    'padding:24px', 'box-sizing:border-box', 'z-index:1', 'white-space:pre-wrap', 'text-align:left',
  ].join(';');
  overlay.textContent = [
    '⚠ forgeax editor: WebGPU not available',
    '',
    `createApp error: ${err instanceof Error ? err.message : String(err)}`,
    '',
    'Likely causes:',
    '  • No GPU adapter (headless VM without GPU)',
    '  • Insecure context (WebGPU needs HTTPS or localhost)',
    '  • iframe permissions policy blocking WebGPU',
    '',
    'The editor panels (Hierarchy / Inspector / command bus) still work —',
    'edits persist to the document; rendering resumes on a GPU-capable host.',
  ].join('\n');
  document.body.appendChild(overlay);
}
