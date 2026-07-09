import {
  createApp,
  loadGame,
  type BootstrapEntry,
} from '@forgeax/engine-app';
import { perspective, Camera, Transform } from '@forgeax/engine-runtime';
// engine #610 (Tier-1 decomposition) moved procedural geometry out of
// engine-runtime into the @forgeax/engine-geometry leaf package.
import { createCylinderGeometry } from '@forgeax/engine-geometry';
import { physicsPlugin } from '@forgeax/engine-physics';
import {
  sendVagMessage,
  onVagMessage,
  allowedParentOrigins,
  VagConsoleSchema,
  VagNetworkSchema,
  VagFpsStatsSchema,
  VagDeviceLostSchema,
} from '@forgeax/editor-core/protocol';
import {
  loadGameProject,
  resolveDefaultScene,
  FORGE_JSON,
} from '@forgeax/engine-project';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { SceneAsset, AssetError } from '@forgeax/engine-types';
import type { ImageError } from '@forgeax/engine-types';
import type { EntityHandle } from '@forgeax/engine-ecs';
import type { BootstrapContext } from './types';
import { createResolveGuidAdapter } from './resolve-guid-adapter';

const root = document.getElementById('app') ?? document.body;

// ── Canvas ──
const canvas = document.createElement('canvas');
canvas.style.width = '100%';
canvas.style.height = '100%';
canvas.width = window.innerWidth * Math.min(window.devicePixelRatio, 2);
canvas.height = window.innerHeight * Math.min(window.devicePixelRatio, 2);
root.appendChild(canvas);

// ── Loading overlay ──
// A cold load (worst on a freshly-created game) leaves the canvas BLACK for a
// second or two: WebGPU device init + shader compilation + the async scene fetch/
// instantiate all happen before the first frame, and the clear colour is black —
// so it reads as "broken / crashed". Show a sky-gradient overlay + spinner
// immediately, then fade it out the instant the first frame renders.
const loadingOverlay = document.createElement('div');
loadingOverlay.style.cssText = [
  'position:fixed', 'inset:0', 'display:flex', 'flex-direction:column', 'gap:14px',
  'align-items:center', 'justify-content:center', 'z-index:50', 'pointer-events:none',
  'background:linear-gradient(180deg,#8fb1d6 0%,#c9d8e8 55%,#dbe4d0 100%)',
  'font:14px/1.4 ui-sans-serif,system-ui,sans-serif', 'color:#3a4a5a', 'transition:opacity .3s',
].join(';');
loadingOverlay.innerHTML = '<div style="width:34px;height:34px;border:3px solid rgba(58,74,90,.25);border-top-color:#3a4a5a;border-radius:50%;animation:fx-spin .8s linear infinite"></div><div>加载中…</div>';
const spinStyle = document.createElement('style');
spinStyle.textContent = '@keyframes fx-spin{to{transform:rotate(360deg)}}';
document.head.appendChild(spinStyle);
root.appendChild(loadingOverlay);
let loadingHidden = false;
function hideLoadingOverlay(): void {
  if (loadingHidden) return;
  loadingHidden = true;
  loadingOverlay.style.opacity = '0';
  setTimeout(() => loadingOverlay.remove(), 350);
}

// ── Resolve gameId + validate (needed BEFORE createApp now) ──
// Game slug format (path c): lowercase alphanumeric + hyphens, 2-41 chars.
// Used for the physics gate below + the per-game pack-index URLs further down.
const GAME_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

const qp = new URLSearchParams(location.search);
const rawGameId = qp.get('game') ?? qp.get('slug');
const gameId = (rawGameId && GAME_ID_RE.test(rawGameId)) ? rawGameId : '_template';

// ── Physics gate (per-game opt-in via forge.json "physics") ──
// Physics is OFF by default so non-physics games pay zero rapier-WASM cost. A
// game opts in with forge.json `"physics": "3d"` (or `true` / `"2d"`). We must
// read it BEFORE createApp because the backend + 3-phase tick systems are wired
// at app-construction time. The editor host (editor-runtime) never enables
// physics, so ✎ Edit stays static (props don't fall while you arrange them);
// ▶ Play simulates. forge.json is fetched no-store so a freshly-toggled flag
// takes effect on the next reload.
let physics: 'rapier-3d' | 'rapier-2d' | undefined;
// Host-injected (vite define) URL-space games prefix. The host owns the layout;
// play-runtime bakes no `<games-dir>` literal. '' → game served directly under base.
declare const __FORGEAX_GAMES_URL_PREFIX__: string;

// Build a game's served URL base from the host-injected prefix + game id.
function gameUrlBase(base: string, id: string): string {
  return __FORGEAX_GAMES_URL_PREFIX__
    ? `${base}/${__FORGEAX_GAMES_URL_PREFIX__}/${id}`
    : `${base}/${id}`;
}

// ── Load forge.json ONCE via the authoritative loader (AC-11) ─────────────────
// fetchRead wraps the browser fetch to match loadGameProject's injection signature.
// cache:'no-store' preserves the existing behaviour: fresh forge.json on every reload.
const forgeBase = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
const fetchRead = (path: string): Promise<string> =>
  fetch(`${gameUrlBase(forgeBase, gameId)}/${path}`, { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });
let gpResult: Awaited<ReturnType<typeof loadGameProject>> | null = null;
{
  try {
    gpResult = await loadGameProject(fetchRead);
  } catch { /* read injection threw → treat as missing */ }
}
if (gpResult?.ok) {
  const gp = gpResult.value;
  {
    const p = gp.physics;
    if (p === '3d' || p === true || p === 'rapier-3d') physics = 'rapier-3d';
    else if (p === '2d' || p === 'rapier-2d') physics = 'rapier-2d';
  }
}

// ── Pointer-capture bridge (M5 w22 / D-6) ──────────────────────────────────
// WKWebView denies the web Pointer Lock API for embedded content, so the engine
// input backend's W3C requestPointerLock() cannot grab the cursor inside the
// Tauri shell. Instead the host injects a lockProvider (below) that forwards a
// fx-pointer-capture postMessage to the parent window; the Tauri shell relays it
// to the set_pointer_capture Rust command (CGAssociateMouseAndMouseCursorPosition).
// requestLock is fire-and-forget (D-7 optimistic placement): the backend cannot
// await the Rust result across the postMessage boundary, so it treats a synchronous
// return as engaged. Harmless on web (no parent handler -> no native grab).
// OOS-4: this only wraps the EXISTING postMessage->invoke bridge -- the Rust
// set_pointer_capture command and the shell relay are untouched.
const post = (capture: boolean): void => {
  try {
    window.parent.postMessage({ type: 'fx-pointer-capture', capture }, '*');
  } catch {
    /* parent gone / cross-origin */
  }
};

// ── createApp (replaces manual createRenderer + World + component registration) ──
// engine #311 reshaped createApp: shaderManifestUrl moved off the 2nd-arg
// CreateAppOptions onto the 3rd-arg BundlerOptions. Passing it on the 2nd arg
// is silently dropped (structural subtyping), causing the engine to fall back
// to the bare '/shaders/manifest.json' which 404s + SPA-falls-back to HTML.
// Physics is enabled by passing physicsPlugin(backend) in createApp's `plugins`
// (mirrors edit-runtime). CreateAppOptions.physics is a READBACK field (a
// PhysicsWorld handle), NOT the backend selector — passing the backend string
// there was silently dropped, so Play never actually got physics.
// lockProvider (M5 w22): host-supplied pointer-lock implementation wrapping the
// fx-pointer-capture bridge above. The engine backend routes onCanvasClick
// through requestLock()/exitLock() when a lockProvider is present (D-2), gated by
// the game-driven setPointerLockAllowed (D-3) wired onto ctx below.
const app = await createApp(canvas, {
  ...(physics ? { plugins: [physicsPlugin(physics)] } : {}),
  lockProvider: {
    requestLock: () => post(true),
    exitLock: () => post(false),
  },
}, {
  shaderManifestUrl: '/preview/shaders/manifest.json',
  // Dev-mode import transport with explicit URL that matches the engine
  // pluginPack middleware's literal route. The default
  // createDevImportTransport() also uses `/__import/<guid>` — but here we
  // spell it out to make the contract local + obvious. play-runtime runs
  // under base `/preview/`, BUT pluginPack registers its dev middleware
  // against the BARE `/__import/…` path (no base awareness), so the
  // transport must NOT prefix the URL. Interface (port 18920) proxies all
  // unknown paths to :15173, so this works in both direct + Studio modes.
  importTransport: {
    async fetchPack(guid: string) {
      try {
        const response = await fetch(`/__import/${guid}`, { method: 'POST' });
        if (!response.ok) return { ok: false };
        try {
          const body = await response.json();
          if (Array.isArray(body)) return { ok: true, entries: body };
        } catch { /* empty/non-JSON body — re-resolve from cache */ }
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  },
});

if (!app.ok) {
  hideLoadingOverlay();
  paintDiagnosticMessage(canvas, app.error);
  throw new Error('[engine] createApp failed');
}

const { world, renderer } = app.value;

// ── Studio cylinder mesh (host-side registration) ─────────────────────────
// The editor offers cube/sphere/cylinder primitives. cube + sphere are engine
// builtins that createApp auto-registers under their GUIDs, but the cylinder is
// a Studio addition with no builtin — a scene that uses one carries the fixed
// CYLINDER_GUID (scene-pack.ts) in its refs[]. The ENGINE TEMPLATE game
// registers it itself before instantiating, but a game that relies on the
// host's asset-first startup (ctx.defaultSceneRoot) never gets the chance: the
// host resolves + instantiates defaultScene BEFORE the game's entry() runs, so
// loadByGuid(scene) recurses into the cylinder ref, finds it absent (and
// /__import is sidecar-only → 404), and fails with `asset-not-imported` →
// resolveDefaultScene fails → the game falls back to a bare ground (cow-level's
// "只剩几个灯光"). Register the cylinder HERE, right after createApp and before
// any scene resolves, so every host-startup game with a cylinder resolves.
const CYLINDER_GUID = 'c1111111-0000-5000-8000-000000000001';
{
  const cylG = AssetGuid.parse(CYLINDER_GUID);
  const cylGeo = createCylinderGeometry(0.5, 0.5, 1, 18);
  if (cylG.ok && cylGeo.ok) {
    (renderer.assets as unknown as { catalog: (g: unknown, p: unknown) => unknown }).catalog(cylG.value, cylGeo.value);
  }
}

// ── Pack index (prod loadByGuid path) ──
// Per-game index URL: /preview/pack-index/<gameId>.json
// Falls back to global /pack-index.json when the per-game index 404s
// (old games or _template that have no per-game catalog).
const packBase = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
const perGameUrl = `${packBase}/pack-index/${gameId}.json`;
const globalUrl = `${packBase}/pack-index.json`;
renderer.assets.configurePackIndex(perGameUrl);
// Prefetch the per-game index to detect 404; fall back to global on failure.
(async () => {
  try {
    const res = await fetch(perGameUrl, { method: 'HEAD' });
    if (!res.ok && gameId !== '_template') {
      console.log(`[engine] per-game pack-index ${perGameUrl} returned ${res.status}, falling back to global index`);
      renderer.assets.configurePackIndex(globalUrl);
    }
  } catch {
    // Network error: keep the per-game URL and let the runtime retry.
  }
})();

// DEBUG: expose for console probing
(window as unknown as Record<string, unknown>).__forgeax = { app: app.value, world, renderer };
void renderer.ready.then((r) => {
  console.log('[debug] renderer.ready settled:', r);
  if (!r.ok) console.error('[debug] ready err:', r.error.code, r.error.expected, r.error.hint, r.error.detail);
});

// ── Resize handler ──
window.addEventListener('resize', () => {
  canvas.width = window.innerWidth * Math.min(window.devicePixelRatio, 2);
  canvas.height = window.innerHeight * Math.min(window.devicePixelRatio, 2);
});

// ── FPS pointer-lock: fully converged to the engine input backend (M5 w24) ──
// The former hand-rolled block here (per-game forge.json gate, canvas
// requestPointerLock prototype override + focus-gate, mousedown/click/keydown-ESC
// listeners, a locally-tracked `captured` flag double-writing a shell HUD, and
// blur/pagehide release) is deleted. All of that capability now lives in the
// engine: the input backend's onCanvasClick drives the lock through the injected
// lockProvider (post(true)/post(false) -> fx-pointer-capture bridge, wired at
// createApp above), the game gate is command-set via ctx.setPointerLockAllowed
// (the template's setMode owns mode as the SSOT), release is handled by the
// backend (ESC / blur / setPointerLockAllowed(false)), and the lock HUD text is
// driven by the template reading snap.mouse.pointerLocked. The play-runtime shell
// `#hud` element (index.html) is retained but no longer script-driven here.
// PlaySurface.tsx keeps its blur/hide/unmount fx-pointer-capture:false release as
// an out-of-band belt-and-suspenders for the keep-alive display:none case, which
// the backend cannot observe (D-6).

// ── Capture variables for ctx assembly (D-2 / R3) ──────────────────────────
// ctx assembly is deferred until after the defaultScene instantiate block so
// the readonly BootstrapContext can be populated with the instantiated root +
// SceneAsset in a single object literal — no write-back or temporal coupling.
let defaultSceneRoot: EntityHandle | undefined;
let defaultScene: SceneAsset | undefined;

// ── resolveGuid adapter (D-2 / C3) ─────────────────────────────────────────
// Defined in ./resolve-guid-adapter.ts and imported above so the unit test
// (w3/w4) can import it without pulling in DOM-heavy main.ts top-level code.

// ── Default Scene instantiate (asset-first startup — D-2 / AC-01) ──────────
// Read defaultScene from the single gpResult loaded at L82 (AC-01 single-load
// invariant — no second fetch of forge.json). When present, resolve the scene
// GUID via the adapter + resolveDefaultScene, then instantiate the scene into
// the live world BEFORE entry() runs, so the game module receives a world that
// already contains the default scene entities.
// When defaultScene is absent (spin-cube, shoot-opt): graceful skip, no error
// (AC-06). If resolveDefaultScene fails, log the structured error
// (charter P3) but DO NOT abort — entry() still fires after (AC-10).
//
// CAUTION (D-2 / OQ1): resolveDefaultScene (engine loader.ts:261-268)
// discards the adapter-passed error.kind on the GuidResult error branch,
// unifying all failures as forge-scene-unresolved. The host does NOT
// bypass resolveDefaultScene with a direct loadByGuid query (charter P4
// consistent abstraction — AI users see a single resolution path).
// End-to-end error.kind differentiation is deferred to a future engine feat.
if (gpResult?.ok && typeof gpResult.value.defaultScene === 'string' && gpResult.value.defaultScene.length > 0) {
  const defaultSceneGuidStr = gpResult.value.defaultScene;
  const parsed = AssetGuid.parse(defaultSceneGuidStr);
  if (parsed.ok) {
    const adapter = createResolveGuidAdapter(async (guid: string) => {
      const parsedG = AssetGuid.parse(guid);
      if (!parsedG.ok) return { ok: false as const, error: parsedG.error };
      // loadByGuid returns the asset payload directly (D-17); SceneAsset
      // carries .kind so the adapter can extract it and backfill guid.
      const assetRes = await renderer.assets.loadByGuid<SceneAsset>(parsedG.value);
      return assetRes;
    });
    const resolved = await resolveDefaultScene({ read: fetchRead, resolveGuid: adapter });
    if (resolved.ok) {
      // Success: loadByGuid returns the SceneAsset payload (D-17).
      // Mint a shared handle via world.allocSharedRef then instantiate.
      const assetRes = await renderer.assets.loadByGuid<SceneAsset>(parsed.value);
      if (assetRes.ok) {
        defaultScene = assetRes.value; // capture loaded SceneAsset (D-4)
        const handle = world.allocSharedRef('SceneAsset', assetRes.value);
        const instantiateRes = renderer.assets.instantiate(handle, world);
        if (instantiateRes.ok) {
          defaultSceneRoot = instantiateRes.value; // capture synthetic root (D-2)
        } else {
          console.error('[engine] defaultScene instantiate failed:', instantiateRes.error);
        }
      } else {
        console.error('[engine] defaultScene loadByGuid (re-fetch for instantiate) failed:', assetRes.error);
      }
    } else {
      console.error('[engine] resolveDefaultScene failed:', resolved.error);
    }
  } else {
    console.error('[engine] defaultScene GUID malformed:', defaultSceneGuidStr, parsed.error);
  }
}
// No else-branch needed — absent defaultScene = graceful skip (AC-06).

// ── BootstrapContext (D-2: assembled after instantiate, so defaultSceneRoot +
// defaultScene are captured in a single readonly literal — no write-back) ──
// B (controlled UI root): symmetric with the embedded editor host so games have
// ONE mount path (`ctx.uiRoot`), not a play-vs-edit fork. Here the container is
// a body-level overlay; teardown is trivial because ■ Stop is location.reload()
// (see VAG_PREVIEW_RELOAD) which discards the entire document.
const playUiRoot = document.createElement('div');
playUiRoot.id = 'game-ui-root';
playUiRoot.style.cssText = 'position:fixed;inset:0;pointer-events:none';
document.body.appendChild(playUiRoot);

const ctx: BootstrapContext = {
  // BootstrapContext no longer carries `renderer` here (engine moved the registry
  // to the top-level `assets` field); keep only what the interface declares.
  // `world` is the first parameter of the bootstrap(world, ctx) entry hook, not a
  // ctx field, so it is passed separately at the entry() call below.
  assets: renderer.assets,
  app: app.value,
  registerUpdate(fn) { app.value.registerUpdate(fn); },
  uiRoot: playUiRoot,
  // A (cleanup hook): no-op — this host reloads the whole document on ■ Stop,
  // so every side effect is discarded regardless. Present only to keep the
  // contract identical to the editor host (games register defensively).
  registerCleanup() { /* reload-on-stop discards everything */ },
  // M5 w22 / D-3: command-set pointer-lock gate. The game template calls this
  // when the view mode changes (setPointerLockAllowed(mode === 'fps')). Delegate
  // to the input backend, which owns the lock SSOT and immediately releases on
  // set(false). Optional-chained: engines predating the setter omit the method.
  setPointerLockAllowed: (allowed: boolean) => app.value.input?.setPointerLockAllowed?.(allowed),
  ...(defaultSceneRoot !== undefined ? { defaultSceneRoot } : {}),
  ...(defaultScene !== undefined ? { defaultScene } : {}),
};

// ── loadGame ──
async function resolveGame(id: string): Promise<BootstrapEntry | null> {
  // id is already validated by GAME_ID_RE before reaching here.
  // Non-template slugs that fail validation are replaced with '_template'
  // during URL construction.
  if (id === '_template') {
    console.log("[engine] no game id in URL — open /preview/?game=<slug> to load one; rendering fallback scene");
    return null;
  }
  const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
  const gameBase = gameUrlBase(base, id);

  // Entry resolution. The game entry filename is no longer hardcoded: the
  // authoritative source is forge.json's `entry` field (relative to the game
  // dir). The canonical convention is a root-level `main.ts` (sibling to
  // `src/`, which holds the rest of the game code). We still fall back to the
  // legacy `src/main.ts` so games created before the rename keep loading.
  const candidates: string[] = [];
  // Use the gpResult loaded at the top of play-runtime (AC-11: single loadGameProject).
  // Non-template games: resolve entry from the typed gp.value.entry; template games won't
  // have a forge.json at all so fall through to defaults.
  if (id !== '_template' && gpResult?.ok) {
    const entry = gpResult.value.entry;
    if (typeof entry === 'string' && entry) candidates.push(entry.replace(/^\.?\//, ''));
  }
  for (const fallback of ['main.ts', 'src/main.ts']) {
    if (!candidates.includes(fallback)) candidates.push(fallback);
  }

  const resolver = async () => {
    for (const rel of candidates) {
      const url = `${gameBase}/${rel}`;
      const head = await fetch(url, { method: 'HEAD' });
      const ct = head.headers.get('content-type') ?? '';
      if (head.ok && ct.includes('javascript')) {
        return await import(/* @vite-ignore */ `${url}?t=${Date.now()}`);
      }
    }
    throw new Error(`module not found: ${id}`);
  };
  const result = await loadGame(id, resolver);
  if (!result.ok) {
    // Graceful degradation stays (return null → fallback scene), but surface the
    // REAL reason: LoadGameError carries the underlying throw in .detail.cause
    // (e.g. a syntax/import error inside the game's src/*.ts). Passing the whole
    // error object lets the fmtArg console bridge unwrap .detail.cause + stack —
    // logging only .code hid the actual failure behind a bare `import-failed`.
    console.error('[engine] loadGame failed — using fallback scene:', result.error);
    return null;
  }
  return result.value;
}

// ── entry bootstrap hook (D-2: semantic downgrade — host instantiates
// defaultScene before this point, so the game module receives a world that
// already contains the default scene entities. The bootstrap hook wires HUD /
// inputs / custom systems onto the live world. Signature: export function
// bootstrap(world, ctx?) — world as first param.
const entry = await resolveGame(gameId);
if (entry) {
  await entry(world, ctx);
} else {
  console.log('[engine] using fallback scene; write games/<id>/main.ts to override');
  world.spawn(
    { component: Transform, data: { posY: 0.6, posZ: 5 } },
    { component: Camera, data: perspective({ fov: 60, aspect: window.innerWidth / window.innerHeight, far: 1000 }) },
  );
}

// ── Start the frame loop ──
app.value.start();

// ── Device-lost → ask the shell to self-heal (reload this iframe) ──
// The engine's onError fan-out carries the RhiError 'device-lost' arm (the
// engine error union has no 'context-lost' code). PlaySurface listens for
// VAG_DEVICE_LOST and reloads. Previously NOTHING emitted it, so a real GPU loss
// left a dead canvas with no recovery. Send once (device-lost is terminal — the
// engine runs its cleanup funnel).
let deviceLostSent = false;
app.value.onError((err) => {
  if (err.code === 'device-lost' && !deviceLostSent) {
    deviceLostSent = true;
    sendVagMessage(window.parent, VagDeviceLostSchema, {});
  }
});

// ── FPS reporting + throttled liveness heartbeat ──
// Studio's PreviewMode treats every VAG_FPS_STATS message as "still rendering"
// evidence: a longer-than-FPS_STALL_MS gap hides the iframe behind the loading
// overlay (vite mid-restart, engine threw, …). Emit the heartbeat at HEARTBEAT_MS
// cadence — a 1 Hz emit would oscillate the parent's 500 ms FPS_STALL_MS gate
// every second on a perfectly-rendering scene (overlay-on / overlay-off flicker).
// Per-frame 60 Hz postMessage across the iframe boundary pressures browser GC
// enough to crash the renderer over time when paired with chat output churn
// (Chrome OUT_OF_MEMORY / error code 5), so throttle to 100 ms — still 5× below
// the parent's 500 ms stall threshold. fps averaging itself stays at 1 Hz; only
// the emit rate is gated.
//
// History: this got lost in 5d4cc4f when engine-src moved out of packages/build
// into this package. Restored from packages/build@22ba730 + 471de60.
const HEARTBEAT_MS = 100;
let frames = 0;
let fpsAccum = 0;
let lastFps = 0;
let lastHeartbeat = 0;
app.value.registerUpdate((dt) => {
  // First frame rendered (scene was instantiated during the awaited entry() above,
  // so frame 1 already shows it) → fade out the loading overlay.
  hideLoadingOverlay();
  frames++;
  fpsAccum += dt;
  if (fpsAccum >= 1) {
    lastFps = Math.round(frames / fpsAccum);
    frames = 0;
    fpsAccum = 0;
  }
  const now = performance.now();
  if (now - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = now;
    try {
      sendVagMessage(window.parent, VagFpsStatsSchema, { fps: lastFps });
    } catch { /* parent might be cross-origin */ }
  }
});

// ── Console bridge (VAG_CONSOLE postMessage) ──
// Render errors / AppError / RhiError / EcsError verbosely so the bridged
// text in the parent surface (and DevTools console) carries .code /
// .expected / .hint / .detail (incl. .detail.cause for app-system-update-
// failed) rather than the bare message. Plain JSON.stringify drops Error
// instances + forwards `[object Object]` for nested non-Error structured
// errors, hiding the actual root cause.
// Replacer used by JSON.stringify on .detail / structured payloads so that
// engine errors nested inside (e.g. AppError.detail.cause = EcsError) print
// as "Name code: message | hint=..." rather than collapsing to {} (Error
// instances JSON.stringify to {} by default — non-enumerable name/message).
// Plain Errors fall back to "name: message". Two-level deep is enough for
// the error chains we surface (AppError -> RhiError.detail.webgpuError etc).
function shallowErrorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    const r = value as unknown as Record<string, unknown>;
    const head = typeof r.code === 'string' ? `${value.name} ${r.code}: ${value.message}` : `${value.name}: ${value.message}`;
    const extras: string[] = [];
    if (typeof r.expected === 'string') extras.push(`expected=${r.expected}`);
    if (typeof r.hint === 'string') extras.push(`hint=${r.hint}`);
    return extras.length > 0 ? `${head} | ${extras.join(' | ')}` : head;
  }
  return value;
}

function fmtArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) {
    const r = a as unknown as Record<string, unknown>;
    const parts = [`${a.name}: ${a.message}`];
    if (typeof r.code === 'string') parts.push(`code=${r.code}`);
    if (typeof r.expected === 'string') parts.push(`expected=${r.expected}`);
    if (typeof r.hint === 'string') parts.push(`hint=${r.hint}`);
    // Promote detail.cause to its own line — for AppError 'app-system-
    // update-failed' the cause is the actual root (EcsError, RhiError,
    // host-system Error). Make sure it's not buried inside a JSON blob.
    const detail = r.detail as Record<string, unknown> | undefined;
    if (detail && typeof detail === 'object' && 'cause' in detail) {
      const c = detail.cause;
      if (c instanceof Error) {
        const cr = c as unknown as Record<string, unknown>;
        const head = typeof cr.code === 'string' ? `${c.name} ${cr.code}: ${c.message}` : `${c.name}: ${c.message}`;
        parts.push(`cause=${head}`);
        if (typeof cr.expected === 'string') parts.push(`cause.expected=${cr.expected}`);
        if (typeof cr.hint === 'string') parts.push(`cause.hint=${cr.hint}`);
        if (cr.detail !== undefined) {
          try { parts.push(`cause.detail=${JSON.stringify(cr.detail, shallowErrorReplacer)}`); }
          catch { parts.push(`cause.detail=${String(cr.detail)}`); }
        }
        if (typeof c.stack === 'string') parts.push(`cause.stack=\n${c.stack.split('\n').slice(0, 4).join('\n')}`);
      } else if (c !== undefined) {
        parts.push(`cause=${typeof c === 'string' ? c : JSON.stringify(c, shallowErrorReplacer)}`);
      }
    }
    if (r.detail !== undefined) {
      try { parts.push(`detail=${JSON.stringify(r.detail, shallowErrorReplacer)}`); }
      catch { parts.push(`detail=${String(r.detail)}`); }
    }
    if (typeof a.stack === 'string') parts.push(a.stack.split('\n').slice(0, 4).join('\n'));
    return parts.join(' | ');
  }
  try { return JSON.stringify(a, shallowErrorReplacer); }
  catch { return String(a); }
}
(['log', 'warn', 'error', 'info', 'debug'] as const).forEach((level) => {
  const original = (console[level] as (...args: unknown[]) => void).bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    try {
      const text = args.map(fmtArg).join(' ');
      sendVagMessage(window.parent, VagConsoleSchema, { level, text, ts: Date.now() });
    } catch { /* parent might be cross-origin */ }
  };
});

window.addEventListener('error', (ev) => {
  try {
    sendVagMessage(window.parent, VagConsoleSchema, { level: 'error', text: `${ev.message}\n  at ${ev.filename}:${ev.lineno}`, ts: Date.now() });
  } catch { /* ignore */ }
});
window.addEventListener('unhandledrejection', (ev) => {
  try {
    sendVagMessage(window.parent, VagConsoleSchema, { level: 'error', text: `unhandled rejection: ${String(ev.reason)}`, ts: Date.now() });
  } catch { /* ignore */ }
});

// Forward vite BUILD errors (import-analysis / transform) to VAG_CONSOLE. These
// fire at module-transform time — BEFORE any game code runs — so the console
// wrappers above never see them, and the agent (which can't see the red HMR
// overlay) was blind to "Failed to resolve import './src/foo'" class failures.
// Surfacing them as VAG_CONSOLE errors makes the Studio Console (hence the
// agent) aware the Preview is broken even when nothing executed.
if (import.meta.hot) {
  // Narrow via ...args because the generic inference on ViteHotContext.on is
  // fragile — the cb parameter resolves to () => void under strict mode even
  // though 'vite:error' maps to ErrorPayload in CustomEventMap. Runtime
  // behaviour is unchanged.
  import.meta.hot.on('vite:error', (...args: unknown[]) => {
    try {
      const payload = args[0] as { err?: { message?: string; id?: string; loc?: { file?: string; line?: number } } } | undefined;
      const err = payload?.err;
      const where = err?.loc?.file ? ` (${err.loc.file}${err.loc.line ? `:${err.loc.line}` : ''})` : err?.id ? ` (${err.id})` : '';
      sendVagMessage(window.parent, VagConsoleSchema, { level: 'error', text: `[vite build] ${err?.message ?? 'build error'}${where}`, ts: Date.now() });
    } catch { /* ignore */ }
  });
}

// ── Network bridge (VAG_NETWORK postMessage) ──
// Mirror the console bridge for fetch / XHR / WebSocket so the Studio Network
// panel can show the game's HTTP/WS activity (asset loads, /__import 404s,
// plugin backend 503s, …). Best-effort + swallow all errors so it never breaks
// the game. Each request → one VAG_NETWORK summary forwarded up to the shell.
(() => {
  const send = (kind: 'fetch' | 'xhr' | 'ws', method: string, url: string, status: number, ms: number, ok: boolean): void => {
    try {
      sendVagMessage(window.parent, VagNetworkSchema, {
        kind, method, url: String(url).slice(0, 2048), status, ms: Math.round(ms), ok, ts: Date.now(),
      });
    } catch { /* cross-origin / detached */ }
  };
  // fetch
  const origFetch = window.fetch?.bind(window);
  if (origFetch) {
    const wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
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
    // Preserve preconnect (if present) to satisfy typeof fetch at the cost of a
    // local cast — tsconfig strict prevents a direct assignment without it.
    if (origFetch.preconnect) (wrappedFetch as unknown as Record<string, unknown>)['preconnect'] = origFetch.preconnect.bind(window);
    window.fetch = wrappedFetch as unknown as typeof fetch;
  }
  // XHR
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
        this.addEventListener('loadend', () => {
          send('xhr', n.m, n.u, this.status, performance.now() - n.t0, this.status >= 200 && this.status < 400);
        });
      }
      return origSend.call(this, body as Document);
    };
  }
  // WebSocket
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
})();

// ── Pause / Play / Reload (VAG_PREVIEW_* postMessage protocol) ──
// Origin-gated via onVagMessage: ONLY the embedding shell may drive the engine.
// Previously this accepted these commands from ANY window with no origin/source
// check — any embedder could pause/reload the running game.
onVagMessage(window, {
  allowedOrigins: allowedParentOrigins(),
  handlers: {
    VAG_PREVIEW_PAUSE: () => app.value.pause(),
    VAG_PREVIEW_PLAY: () => app.value.resume(),
    VAG_PREVIEW_RELOAD: () => location.reload(),
  },
});

// ── Vite HMR ──
if (import.meta.hot) {
  import.meta.hot.on('vite:beforeFullReload', () => {
    console.log('[engine] HMR full reload');
  });
}

// ── Diagnostic overlay (WebGPU unavailable) ──
function paintDiagnosticMessage(_c: HTMLCanvasElement, err: unknown): void {
  const isInsecureRemote = location.protocol === 'http:'
    && location.hostname !== 'localhost'
    && location.hostname !== '127.0.0.1'
    && !location.hostname.startsWith('localhost');

  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'display:flex', 'align-items:center', 'justify-content:center',
    'background:#1a1a1f', 'font:14px/1.5 ui-monospace,monospace',
    'padding:24px', 'box-sizing:border-box', 'pointer-events:auto', 'z-index:99999',
    'white-space:pre-wrap', 'text-align:left',
  ].join(';');

  const lines: string[] = [];

  if (isInsecureRemote) {
    overlay.style.color = '#7dff7d';
    lines.push(
      '⚠ WebGPU requires a Secure Context',
      '',
      `Current origin: ${location.origin} (insecure)`,
      '',
      'WebGPU is only available over HTTPS or localhost.',
      'You are accessing via HTTP + non-localhost IP, so the browser blocks WebGPU.',
      '',
      'Fix (pick one):',
      '  1. SSH port-forward: ssh -L 15173:localhost:15173 <server>',
      '     then open http://localhost:15173/preview/',
      '',
      '  2. Chrome flag: chrome://flags/#unsafely-treat-insecure-origin-as-secure',
      `     add "${location.origin}" to the list, relaunch Chrome`,
      '',
      '  3. Set up HTTPS (nginx reverse proxy with self-signed cert)',
    );
  } else {
    overlay.style.color = '#ff8a8a';
    const reason = err
      ? `createApp error: ${err instanceof Error ? err.message : String(err)}`
      : 'WebGPU adapter request returned null';
    lines.push(
      '⚠ Engine init failed',
      '',
      reason,
    );

    // EngineEnvironmentError carries a structured detail with webgpuError /
    // wgpuError — each is a RhiError-shape with code/expected/hint/detail. The
    // outer "no usable backend" message is generic; the inner RhiError is the
    // real cause (often unrelated to GPU adapter — e.g. shader manifest 404
    // returning HTML, asset pipeline failure, etc). Surface it ALL.
    const e = err as Record<string, unknown> | null;
    const detail = (e && typeof e === 'object' ? (e.detail as Record<string, unknown> | undefined) : undefined);
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

    // Only fall back to the generic "likely causes" hint when we have NO
    // structured inner error — otherwise the inner code/hint already pinpoints
    // the actual cause and the generic list misleads.
    const hasInner = detail && (detail.webgpuError || detail.wgpuError);
    if (!hasInner) {
      lines.push(
        '',
        'Likely causes:',
        '  • No GPU adapter available (VM without GPU hardware)',
        '  • Chrome flag chrome://flags/#enable-unsafe-webgpu disabled',
        '  • iframe permissions policy blocking WebGPU',
      );
    }
  }

  overlay.textContent = lines.join('\n');
  document.body.appendChild(overlay);
}
