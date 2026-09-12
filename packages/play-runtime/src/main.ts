import { runtimeFailure } from './runtime-failure';
import {
  createApp,
  renderFeaturePlugin,
  ensureFallbackCamera,
  type App,
  type ExecutionApp,
  type GameHost,
} from '@forgeax/engine-app';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { audioPlugin } from '@forgeax/engine-audio';
import { webAudioPlugin } from '@forgeax/engine-audio-webaudio';
import {
  addGamePluginSystems,
  describeGamePluginSystems,
  editorComponentVocabularyPlugin,
  installGamePluginProducers,
  loadGamePluginModules,
  type GamePluginLoad,
} from '@forgeax/editor-game-plugins';
// engine #610 (Tier-1 decomposition) moved procedural geometry out of
// engine-runtime into the @forgeax/engine-geometry leaf package.
import { createCylinderGeometry } from '@forgeax/engine-geometry';
import { physicsPlugin } from '@forgeax/engine-physics';
import { skinningPlugin } from '@forgeax/engine-skinning';
import { createDevImportTransport } from '@forgeax/engine-runtime';
import {
  sendVagMessage,
  onVagMessage,
  allowedParentOrigins,
  VagConsoleSchema,
  VagNetworkSchema,
  VagFpsStatsSchema,
  VagDeviceLostSchema,
  VagCarrierHandshakeSchema,
  VagCarrierHeartbeatSchema,
  VagCarrierFailureSchema,
  VagGameplayResponseSchema,
  VAG_CARRIER_PROTOCOL_VERSION,
  type VagCarrierFailureDetail,
} from '@forgeax/editor-core/protocol';
import { createUserTimingProfiler } from '@forgeax/engine-profiler/browser-user-timing';
import {
  loadGameProject,
} from '@forgeax/engine-project';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { type SceneAsset, type RuntimeAssetBinding } from '@forgeax/engine-types';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { BootstrapContext } from './types';
import { installShortcutForwarder } from './shortcut-forwarder';
import { createPlayProductRuntimeAdapter } from './product-runtime-adapter';
import { createPlayVfxRuntime } from './vfx-runtime';
import { startPlayExecution, type StartedPlayExecution } from './execution-host';
import {
  createPlayExecutionDiagnosticsStore,
  isPlayExecutionRealmMessage,
  createPlayRendererProvenance,
  PLAY_EXECUTION_PROTOCOL,
  type PlayRendererProvenance,
} from './execution-contract';
import { supportsVfxRenderFeature } from './vfx-render-capability';
import { installCompletedFrameHeartbeat } from './completed-frame-heartbeat';
import { toVagExecutionEnvelope } from './vag-execution-envelope';
import './vite-build-health';
import { createPlayGameplayProjection } from './gameplay-projection';
import { importFirstGameEntry } from './game-entry-loader';
import { refreshPlayCatalogUntilReady } from './play-catalog-ready';
import { activatePlayGame, resolvePlayGameActivation } from './play-game-activation';
import { resolvePlaySceneGuid } from './play-scene-selection';
import { loadRuntimeBinding as fetchRuntimeBinding } from './runtime-binding-loader';
import { bootstrap as staticGameBootstrap } from 'virtual:forgeax-static-game-entry';
import { modules as staticGamePluginModules, importModule as importStaticGamePlugin } from 'virtual:forgeax-static-game-plugins';

// TODO 004: When this Play/preview viewport is embedded as a studio iframe,
// forward global shortcuts to the studio shell. Standalone mode is a no-op.
installShortcutForwarder();

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
loadingOverlay.innerHTML = '<div style="width:34px;height:34px;border:3px solid rgba(58,74,90,.25);border-top-color:#3a4a5a;border-radius:50%;animation:fx-spin .8s linear infinite"></div><div>Loading...</div>';
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
// Game slug format (path c): lowercase alphanumeric + hyphens, 1-41 chars.
// Used for the physics gate below + the per-game pack-index URLs further down.
const GAME_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

declare const __FORGEAX_STATIC_BUILD__: boolean;
declare const __FORGEAX_STATIC_GAME_ID__: string;

const qp = new URLSearchParams(location.search);
const rawGameId = qp.get('game') ?? qp.get('slug');
const requestedSceneGuid = qp.get('sceneGuid');
const requestedGameId = rawGameId ?? (__FORGEAX_STATIC_BUILD__ ? __FORGEAX_STATIC_GAME_ID__ : null);
const requestedGameIdValidated = requestedGameId && GAME_ID_RE.test(requestedGameId)
  ? requestedGameId
  : null;
const expectedScopeId = qp.get('runtimeScopeId');
const expectedGenerationText = qp.get('runtimeGeneration');
const expectedGeneration = expectedGenerationText === null ? null : Number(expectedGenerationText);
const carrierRuntimeId = qp.get('runtimeId')?.trim() || null;
const carrierOwnershipChallenge = qp.get('ownershipChallenge')?.trim() || null;
const carrierPageNonce = crypto.randomUUID();
const carrierCanvasId = `canvas-${carrierPageNonce}`;
const carrierPageIdentity = `${location.origin}${location.pathname}`;
let carrierScope: { projectId: string; gameId: string | null } | null = null;
let carrierRendererProvenance: PlayRendererProvenance | null = null;
let nextMainRendererGeneration = 0;
let carrierSentinel = 0;
let carrierFailure: VagCarrierFailureDetail | null = null;
let carrierExecutionReport: ReturnType<import('@forgeax/engine-app').ExecutionControl['report']> | null = null;

function bootErrorRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function carrierPayload(renderReadiness: 'pending' | 'ready' | 'unavailable', failure: VagCarrierFailureDetail | null = carrierFailure) {
  const rendererIdentity = carrierRendererProvenance?.identity ?? 'renderer-pending';
  const rendererGeneration = carrierRendererProvenance?.generation ?? null;
  const effectiveReadiness = rendererGeneration === null && renderReadiness === 'ready'
    ? 'unavailable' as const
    : renderReadiness;
  return {
    version: VAG_CARRIER_PROTOCOL_VERSION,
    runtimeId: carrierRuntimeId,
    runtimeGeneration: expectedGeneration !== null && Number.isSafeInteger(expectedGeneration) && expectedGeneration > 0
      ? expectedGeneration : undefined,
    carrierId: qp.get('carrierId')?.trim() || undefined,
    carrierKind: qp.get('carrierKind') === 'iframe' ? 'iframe' as const : undefined,
    challengeResponse: carrierOwnershipChallenge,
    scope: carrierScope,
    pageNonce: carrierPageNonce,
    pageIdentity: carrierPageIdentity,
    canvasIdentity: carrierCanvasId,
    rendererIdentity,
    rendererGeneration,
    sentinel: carrierSentinel,
    liveness: 'alive' as const,
    renderReadiness: effectiveReadiness,
    execution: toVagExecutionEnvelope(carrierExecutionReport),
    failure: failure ?? carrierFailure,
  };
}

function publishCarrierBootFailure(error: unknown): void {
  hideLoadingOverlay();
  const detail = bootErrorRecord(error);
  const message = error instanceof Error
    ? error.message
    : typeof detail?.message === 'string'
      ? detail.message
      : typeof detail?.hint === 'string'
        ? detail.hint
        : String(error);
  carrierFailure = {
    code: 'play-carrier-boot-failed',
    stage: 'handshake',
    retryable: true,
    hint: message,
    at: new Date().toISOString(),
    message,
  };
  try {
    const payload = carrierPayload('unavailable', carrierFailure);
    sendVagMessage(window.parent, VagCarrierFailureSchema, { ...payload, failure: carrierFailure });
  } catch (error) {
    console.warn('[play] VAG carrier message dropped', error);
  }
}

async function loadRuntimeBinding(): Promise<RuntimeAssetBinding | undefined> {
  if (__FORGEAX_STATIC_BUILD__) return undefined;
  const bindingUrl = `${(import.meta.env.BASE_URL ?? '/').replace(/\/$/, '')}/__pack/runtime-binding.json`;
  return fetchRuntimeBinding(bindingUrl, fetch);
}

let runtimeBinding: RuntimeAssetBinding | undefined;
try {
  runtimeBinding = await loadRuntimeBinding();
  if (runtimeBinding !== undefined && requestedGameIdValidated !== null && runtimeBinding.gameId !== requestedGameIdValidated) {
    throw new Error(
      `[engine] requested game ${requestedGameIdValidated} does not match active runtime scope ${runtimeBinding.gameId}`,
    );
  }
  if (
    expectedScopeId !== null
    || expectedGeneration !== null
  ) {
    if (
      expectedScopeId === null
      || expectedGeneration === null
      || !Number.isSafeInteger(expectedGeneration)
      || expectedGeneration < 1
      || runtimeBinding === undefined
      || runtimeBinding.scopeId !== expectedScopeId
      || runtimeBinding.generation !== expectedGeneration
    ) {
      throw new Error('[engine] requested runtime generation does not match the active binding');
    }
  }
} catch (error) {
  publishCarrierBootFailure(error);
  throw error;
}
const gameId = runtimeBinding?.gameId ?? requestedGameIdValidated ?? '_template';
canvas.id = carrierCanvasId;

function markRendererProvenanceFailure(message: string): void {
  carrierFailure = {
    code: 'renderer-provenance-unavailable',
    stage: 'renderer',
    retryable: true,
    hint: 'The Play renderer realm did not publish complete producer provenance.',
    at: new Date().toISOString(),
    message,
  };
}

Object.defineProperty(window, '__forgeaxPlayRendererProvenance', {
  configurable: true,
  enumerable: false,
  get: () => () => carrierRendererProvenance,
});

async function resolveManagedCarrierScope(): Promise<void> {
  if (!carrierRuntimeId || !carrierOwnershipChallenge) return;
  try {
    const [healthResponse, activeGameResponse] = await Promise.all([
      fetch('/api/health', { cache: 'no-store' }),
      fetch('/api/projects/active', { cache: 'no-store' }),
    ]);
    if (!healthResponse.ok || !activeGameResponse.ok) return;
    const health = await healthResponse.json() as { instanceRootAbs?: unknown };
    const activeGame = await activeGameResponse.json() as { activeSlug?: unknown };
    if (typeof health.instanceRootAbs !== 'string' || health.instanceRootAbs.length === 0) return;
    carrierScope = {
      projectId: health.instanceRootAbs,
      gameId: typeof activeGame.activeSlug === 'string' && GAME_ID_RE.test(activeGame.activeSlug)
        ? activeGame.activeSlug
        : null,
    };
  } catch {
    // A managed page must fail its handshake when the producer facts cannot be
    // read. Ordinary user-opened preview pages do not use the carrier protocol.
  }
}

const carrierScopeReady = resolveManagedCarrierScope();

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
const playSceneGuid = resolvePlaySceneGuid(
  requestedSceneGuid,
  gpResult?.ok ? gpResult.value.defaultScene : undefined,
);

async function loadGamePluginManifestModules(
  id: string,
): Promise<Array<{ clientPath: string; url: string }>> {
  if (id === '_template' || __FORGEAX_STATIC_BUILD__) return [];
  try {
    const response = await fetch(`${forgeBase}/game-plugins/${id}.json`, { cache: 'no-store' });
    if (!response.ok) return [];
    const body = (await response.json()) as { modules?: unknown };
    if (!Array.isArray(body.modules)) return [];
    return body.modules.filter(
      (module): module is { clientPath: string; url: string } =>
        typeof module === 'object' &&
        module !== null &&
        typeof (module as { clientPath?: unknown }).clientPath === 'string' &&
        typeof (module as { url?: unknown }).url === 'string',
    );
  } catch {
    return [];
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

// Worker execution is an explicit game contract, not an optimistic claim made
// from browser capability alone. Existing games keep the complete legacy Host
// bootstrap below and therefore continue to report main-serial. A game that
// names executionEntry supplies realm-safe logic: the Engine owns its World,
// Renderer, AssetRegistry, plugins, and frame loop in one selected realm while
// this page remains only the DOM/UI carrier.
const executionEntry = !__FORGEAX_STATIC_BUILD__ && gpResult?.ok
  && typeof gpResult.value.executionEntry === 'string'
  && gpResult.value.executionEntry.trim().length > 0
  ? gpResult.value.executionEntry.replace(/^\.?\//, '')
  : null;
let playApp: App | ExecutionApp | undefined;
let playWorld: World | undefined;
let subscribePlayFrameEnd: ((listener: () => void) => () => void) | undefined;
let executionHost: StartedPlayExecution | undefined;
const playExecutionDiagnostics = createPlayExecutionDiagnosticsStore();

if (executionEntry !== null) {
  const executionUrl = `${gameUrlBase(forgeBase, gameId)}/${executionEntry}?t=${Date.now()}`;
  try {
    executionHost = await startPlayExecution({
      canvas,
      gameId,
      gameEntryUrl: executionUrl,
      ...(physics === undefined ? {} : { physics }),
      ...(runtimeBinding === undefined ? {} : { runtimeBinding }),
      gamePluginModules: await loadGamePluginManifestModules(gameId),
      lockProvider: {
        requestLock: () => post(true),
        exitLock: () => post(false),
      },
      uiParent: document.body,
    });
    playApp = executionHost.app;
    carrierExecutionReport = playApp.execution.report();
    executionHost.hostPort.addEventListener('message', (event: MessageEvent<unknown>): void => {
      if (!isPlayExecutionRealmMessage(event.data)) {
        const candidate = event.data as { protocol?: unknown; kind?: unknown } | null;
        if (candidate?.protocol === PLAY_EXECUTION_PROTOCOL && candidate.kind === 'realm-ready') {
          markRendererProvenanceFailure('execution realm-ready message failed provenance validation');
        }
        return;
      }
      carrierExecutionReport = playApp?.execution.report() ?? carrierExecutionReport;
      if (event.data.kind === 'realm-ready') {
        carrierRendererProvenance = event.data.renderer;
        hideLoadingOverlay();
        return;
      }
      if (playExecutionDiagnostics.accept(event.data)) return;
      if (event.data.kind !== 'heartbeat') return;
      carrierSentinel = event.data.sentinel;
      hideLoadingOverlay();
      try {
        sendVagMessage(window.parent, VagFpsStatsSchema, { fps: event.data.fps });
        sendVagMessage(window.parent, VagCarrierHeartbeatSchema, carrierPayload(
          carrierFailure ? 'unavailable' : 'ready',
        ));
      } catch (error) {
    console.warn('[play] VAG carrier message dropped', error);
  }
    });
    executionHost.hostPort.start();
    window.addEventListener('pagehide', () => executionHost?.disposeHost(), { once: true });
  } catch (error) {
    hideLoadingOverlay();
    paintDiagnosticMessage(canvas, error);
    publishCarrierBootFailure(error);
    throw error;
  }
} else {
let runtimeWorld: World | undefined;
const vfxRuntime = createPlayVfxRuntime({ world: () => runtimeWorld });

// Engine preview creates the controlled UI root before createApp so input and
// game plugins share one host-owned container. Stop reloads the document, so
// teardown is still a no-op.
const playUiRoot = document.createElement('div');
playUiRoot.id = 'game-ui-root';
playUiRoot.style.cssText = 'position:fixed;inset:0;pointer-events:none';
document.body.appendChild(playUiRoot);

// createApp third arg is BundlerOptions. Engine preview collapses that literal
// to forgeaxBundlerAdapter() so shaderManifestUrl stays base-aware
// (`/preview/shaders/manifest.json`). Physics is enabled by passing
// physicsPlugin(backend) in plugins (mirrors edit-runtime). CreateAppOptions.physics
// is a READBACK field, not the backend selector.
// lockProvider (M5 w22): host-supplied pointer-lock wrapping fx-pointer-capture.
const devImportTransport = runtimeBinding === undefined
  ? undefined
  : createDevImportTransport(runtimeBinding);
async function createCarrierApp() {
  try {
    return await createApp(canvas, {
      plugins: [
        editorComponentVocabularyPlugin(),
        skinningPlugin(),
        webAudioPlugin(),
        audioPlugin(),
        ...(physics === undefined ? [] : [physicsPlugin(physics)]),
      ],
      uiRoot: playUiRoot,
      lockProvider: {
        requestLock: () => post(true),
        exitLock: () => post(false),
      },
      profiler: createUserTimingProfiler({ captureId: 'play-user-timing' }),
    }, {
      ...forgeaxBundlerAdapter(),
      ...(devImportTransport === undefined ? {} : { importTransport: devImportTransport }),
    });
  } catch (error) {
    publishCarrierBootFailure(error);
    throw error;
  }
}
const app = await createCarrierApp();

if (!app.ok) {
  hideLoadingOverlay();
  paintDiagnosticMessage(canvas, app.error);
  publishCarrierBootFailure(app.error);
  throw new Error('[engine] createApp failed');
}

const { world, renderer } = app.value;
const assets = app.value.assets;
if (assets === undefined) {
  const error = new Error('[engine] createApp returned without its host-owned asset registry');
  hideLoadingOverlay();
  paintDiagnosticMessage(canvas, error);
  publishCarrierBootFailure(error);
  throw error;
}
playApp = app.value;
playWorld = world;
subscribePlayFrameEnd = (listener) => renderer.subscribe((event) => {
  if (event.kind === 'frame-submitted') listener();
});
if (supportsVfxRenderFeature(renderer.inspect().capabilities)) {
  try {
    await app.value.pluginContext.plugin(renderFeaturePlugin(vfxRuntime.host.feature));
  } catch (error) {
    console.warn('[play] VFX render feature installation failed:', error);
  }
} else {
  console.warn('[play] VFX render feature disabled: active RHI lacks compute or indirect-drawing capability');
}
carrierExecutionReport = app.value.execution.report();
if (runtimeBinding !== undefined) {
  assets.configureRuntimeBinding(runtimeBinding);
}
{
  const requiredScene = playSceneGuid;
  const catalogReady = await refreshPlayCatalogUntilReady(assets, {
    ...(requiredScene === undefined ? {} : { requiredGuid: requiredScene }),
  });
  if (requiredScene !== undefined && !catalogReady) {
    const error = new Error(`[engine] defaultScene ${requiredScene} is not in the runtime catalog`);
    paintDiagnosticMessage(canvas, error);
    publishCarrierBootFailure(error);
    throw error;
  }
}
runtimeWorld = world;
const vfxAttached = await vfxRuntime.attachWorld(world, assets);
if (!vfxAttached.ok) {
  hideLoadingOverlay();
  paintDiagnosticMessage(canvas, vfxAttached.error);
  publishCarrierBootFailure(vfxAttached.error);
  throw new Error(`[engine] particle runtime host attach failed: ${vfxAttached.error.code}`);
}
// Main-serial owns this Renderer directly, so it uses the same producer rule as
// the Worker execution realm. A missing fact remains unavailable; it is never
// replaced with a page/runtime/world identity or a numeric zero.
const mainRendererProvenance = createPlayRendererProvenance(
  renderer,
  nextMainRendererGeneration + 1,
);
if (mainRendererProvenance === null) {
  markRendererProvenanceFailure('main-serial Play renderer provenance could not be minted');
} else {
  nextMainRendererGeneration = mainRendererProvenance.generation;
  carrierRendererProvenance = mainRendererProvenance;
}

// ── Studio cylinder mesh (host-side registration) ─────────────────────────
// The editor offers cube/sphere/cylinder primitives. cube + sphere are engine
// builtins that createApp auto-registers under their GUIDs, but the cylinder is
// a Studio addition with no builtin — a scene that uses one carries the fixed
// CYLINDER_GUID (scene-pack.ts) in its refs[]. The ENGINE TEMPLATE game
// registers it itself before instantiating, but a game that relies on the
// host's asset-first startup (ctx.defaultSceneRoot) never gets the chance: the
// host resolves + instantiates defaultScene BEFORE the game's entry() runs, so
// loadByGuid(scene) recurses into the cylinder ref, finds it absent (and
// the unscoped asset route is sidecar-only → 404), and fails with `asset-not-imported` →
// resolveDefaultScene fails → the game falls back to a bare ground (cow-level's
// "only a few lights"). Register the cylinder HERE, right after createApp and before
// any scene resolves, so every host-startup game with a cylinder resolves.
const CYLINDER_GUID = 'c1111111-0000-5000-8000-000000000001';
{
  const cylG = AssetGuid.parse(CYLINDER_GUID);
  const cylGeo = createCylinderGeometry(0.5, 0.5, 1, 18);
  if (cylG.ok && cylGeo.ok) {
    (assets as unknown as { catalog: (g: unknown, p: unknown) => unknown }).catalog(cylG.value, cylGeo.value);
  }
}

// ── Pack catalog (prod or bound dev realm) ──
const packBase = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
const globalUrl = `${packBase}/pack-index.json`;
if (__FORGEAX_STATIC_BUILD__) assets.configurePackIndex(globalUrl);

// Asset-resident game plugins must register their component tokens before the
// host instantiates defaultScene. The editor Play path discovers the same files
// through its `/api` tree; pure preview receives a Vite URL manifest because it
// owns a separate browser module realm. The registry-delta/import operation is
// shared in @forgeax/engine-app; only discovery stays host-specific.
let gamePluginLoad: GamePluginLoad = { plugins: [], systems: [], components: [], errors: [] };
if (gameId !== '_template') {
  try {
    if (__FORGEAX_STATIC_BUILD__ && gameId === __FORGEAX_STATIC_GAME_ID__) {
      gamePluginLoad = await loadGamePluginModules({
        modules: staticGamePluginModules,
        importModule: importStaticGamePlugin,
      });
      for (const error of gamePluginLoad.errors) {
        console.error(`[engine] static game plugin failed: ${error.clientPath}: ${error.message}`);
      }
    } else {
      const response = await fetch(`${packBase}/game-plugins/${gameId}.json`, { cache: 'no-store' });
      if (response.ok) {
        const body = await response.json() as { modules?: unknown };
        const modules = Array.isArray(body.modules)
          ? body.modules.filter((module): module is { clientPath: string; url: string } => (
            typeof module === 'object'
            && module !== null
            && typeof (module as { clientPath?: unknown }).clientPath === 'string'
            && typeof (module as { url?: unknown }).url === 'string'
          ))
          : [];
        gamePluginLoad = await loadGamePluginModules({
          modules,
          importModule: (url) => import(/* @vite-ignore */ url),
        });
        for (const error of gamePluginLoad.errors) {
          console.error(`[engine] game plugin failed: ${error.clientPath}: ${error.message}`);
        }
      }
    }
  } catch (error) {
    console.warn('[engine] game plugin manifest unavailable:', error);
  }
}

// Plugin modules are loaded after the host App exists so discovery stays
// host-owned, but activation must still go through that App's Cordis realm.
// This keeps component leases and systems World-local without a process-wide owner
// and ensures defaultScene loading below sees the plugin vocabulary.
if (gamePluginLoad.plugins.length > 0) {
  const beforeComponents = new Set(world.components.entries().keys());
  const beforeSystems = new Set(world.inspect().systems.map((system) => system.name));
  try {
    for (const loaded of gamePluginLoad.plugins) {
      if (loaded.plugin !== undefined) await app.value.pluginContext.plugin(loaded.plugin);
    }
    gamePluginLoad = {
      ...gamePluginLoad,
      components: [...world.components.entries().keys()].filter((name) => !beforeComponents.has(name)),
      systems: world.inspect().systems.map((system) => system.name).filter((name) => !beforeSystems.has(name)),
    };
  } catch (error) {
    console.warn('[engine] game plugin activation failed:', error);
  }
}

// DEBUG: expose for console probing without replacing Engine-owned capture hooks.
const forgeaxDebug = (window as unknown as { __forgeax?: Record<string, unknown> }).__forgeax;
(window as unknown as { __forgeax?: Record<string, unknown> }).__forgeax = {
  ...(forgeaxDebug ?? {}),
  app: app.value,
  world,
  renderer,
};

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

// Default Scene instantiate — same contract as engine apps/preview:
// loadByGuid + instantiate, then provide GameHost. Absent defaultScene is a
// graceful skip. A declared defaultScene that fails to load is a boot failure;
// Cordis games (game-3d) require defaultSceneRoot and would otherwise hang on
// the Loading overlay after throwing past hideLoadingOverlay.
if (playSceneGuid !== undefined) {
  const defaultSceneGuidStr = playSceneGuid;
  const parsed = AssetGuid.parse(defaultSceneGuidStr);
  if (!parsed.ok) {
    const error = new Error(`[engine] defaultScene GUID malformed: ${defaultSceneGuidStr}`);
    paintDiagnosticMessage(canvas, error);
    publishCarrierBootFailure(error);
    throw error;
  }
  const assetRes = await assets.loadByGuid<SceneAsset>(parsed.value);
  if (!assetRes.ok) {
    paintDiagnosticMessage(canvas, assetRes.error);
    publishCarrierBootFailure(assetRes.error);
    throw new Error(`[engine] defaultScene loadByGuid failed: ${assetRes.error.code}`);
  }
  defaultScene = assetRes.value;
  const handle = world.allocSharedRef('SceneAsset', assetRes.value);
  const instantiateRes = assets.instantiate(handle, world);
  if (!instantiateRes.ok) {
    paintDiagnosticMessage(canvas, instantiateRes.error);
    publishCarrierBootFailure(instantiateRes.error);
    throw new Error(`[engine] defaultScene instantiate failed: ${instantiateRes.error.code}`);
  }
  defaultSceneRoot = instantiateRes.value;
}

const gameplayProjection = createPlayGameplayProjection();
const disposeGameplayBridge = onVagMessage(window, {
  // Keep the origin gate as the trust boundary, but do not add an exact
  // WindowProxy source gate here. The embedded Play page can cross a reverse
  // proxy / COOP boundary where the browser exposes the parent WindowProxy
  // differently on the inbound event. The request is still accepted only
  // from an origin derived from this page/referrer, and the response returns
  // to the current parent that owns this carrier.
  allowedOrigins: allowedParentOrigins(),
  handlers: {
    VAG_GAMEPLAY_REQUEST: (message) => {
      void (async () => {
        const request = message.payload;
        let result:
          | { readonly ok: true; readonly data?: unknown }
          | { readonly ok: false; readonly error: { readonly code: string; readonly hint: string } };
        try {
          result = request.operation === 'describe'
            ? { ok: true as const, data: gameplayProjection.describe() }
            : request.operation === 'run'
              ? await gameplayProjection.run(request.id, request.args as Parameters<typeof gameplayProjection.run>[1])
              : await gameplayProjection.read(request.id);
        } catch (error) {
          result = {
            ok: false,
            error: {
              code: 'gameplay-projection-failed',
              hint: error instanceof Error ? error.message : String(error),
            },
          };
        }
        try {
          sendVagMessage(window.parent, VagGameplayResponseSchema, {
            version: 1,
            requestId: request.requestId,
            ok: result.ok,
            ...(result.ok
              ? (result.data === undefined ? {} : { data: result.data })
              : { error: result.error }),
          });
        } catch (error) {
          console.error('[engine] gameplay response failed:', error);
        }
      })();
    },
  },
});
window.addEventListener('pagehide', disposeGameplayBridge, { once: true });

const ctx: BootstrapContext = {
  // `world` is the first parameter of the bootstrap(world, ctx) entry hook, not a
  // ctx field, so it is passed separately at the entry() call below. Expose the
  // live renderer as well: optional template post-processes use this seam to
  // register their pipelines, while assets remain available through the
  // dedicated registry field.
  renderer,
  assets,
  app: app.value,
  uiRoot: playUiRoot,
  // A (cleanup hook): no-op — this host reloads the whole document on ■ Stop,
  // so every side effect is discarded regardless. Present only to keep the
  // contract identical to the editor host (games register defensively).
  registerCleanup() { /* reload-on-stop discards everything */ },
  gameProjection: gameplayProjection.registrar,
  // M5 w22 / D-3: command-set pointer-lock gate. The game template calls this
  // when the view mode changes (setPointerLockAllowed(mode === 'fps')). Delegate
  // to the input backend, which owns the lock SSOT and immediately releases on
  // set(false). Optional-chained: engines predating the setter omit the method.
  setPointerLockAllowed: (allowed: boolean) => app.value.input?.setPointerLockAllowed?.(allowed),
  ...(defaultSceneRoot !== undefined ? { defaultSceneRoot } : {}),
  ...(defaultScene !== undefined ? { defaultScene } : {}),
};

// The native template plugin is mounted into the same Cordis realm created by
// createApp. This is the only place that can satisfy its `gameHost` injection
// while preserving the one App/World/Renderer authority. Legacy bootstrap
// functions below continue to receive the plain BootstrapContext.
const gameHost: GameHost = {
  canvas,
  renderer,
  assets,
  app: app.value,
  uiRoot: playUiRoot,
  setPointerLockAllowed: (allowed: boolean) => app.value.input?.setPointerLockAllowed?.(allowed),
  gameProjection: gameplayProjection.registrar,
  ...(defaultSceneRoot !== undefined ? { defaultSceneRoot } : {}),
  ...(defaultScene !== undefined ? { defaultScene } : {}),
};

async function resolveGameModule(id: string): Promise<unknown | null> {
  if (id === '_template') {
    console.log("[engine] no game id in URL — open /preview/?game=<slug> to load one; rendering fallback scene");
    return null;
  }
  const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
  const gameBase = gameUrlBase(base, id);

  if (__FORGEAX_STATIC_BUILD__ && id === __FORGEAX_STATIC_GAME_ID__ && typeof staticGameBootstrap === 'function') {
    return { bootstrap: staticGameBootstrap };
  }

  const candidates: string[] = [];
  if (id !== '_template' && gpResult?.ok) {
    const entry = gpResult.value.entry;
    if (typeof entry === 'string' && entry) candidates.push(entry.replace(/^\.?\//, ''));
  }
  for (const fallback of ['main.ts', 'src/main.ts']) {
    if (!candidates.includes(fallback)) candidates.push(fallback);
  }

  try {
    return await importFirstGameEntry(
      candidates.map((relative) => `${gameBase}/${relative}`),
      (url) => import(/* @vite-ignore */ `${url}?t=${Date.now()}`),
    );
  } catch (error) {
    console.error('[engine] game entry failed — using fallback scene:', error);
    return null;
  }
}

const gameModule = await resolveGameModule(gameId);
const activation = await resolvePlayGameActivation(gameId, gameModule);
if (activation.kind === 'none') {
  console.log('[engine] using fallback scene; write games/<id>/main.ts to override');
  ensureFallbackCamera(world, window.innerWidth / window.innerHeight);
} else {
  try {
    await activatePlayGame({
      app: app.value,
      world,
      gameHost,
      ctx,
      activation,
    });
  } catch (error) {
    publishCarrierBootFailure(error);
    throw error;
  }
}
// Match editor ▶ Play: plugin systems are attached only to the live runtime
// world, after bootstrap has had a chance to register its own systems. Edit and
// preview still share the same component/system registration facts, while the
// editor retains ownership of its draw/input lifecycle.
if (gamePluginLoad.systems.length > 0) {
  const added = addGamePluginSystems(world, gamePluginLoad);
  if (added.length > 0) console.log(`[engine] game systems added: ${added.join(', ')}`);
  const diagnostics = describeGamePluginSystems(gamePluginLoad, added);
  const missing = diagnostics.filter((entry) => entry.status === 'missing');
  if (missing.length > 0) console.warn(`[engine] missing game systems: ${missing.map((entry) => entry.system).join(', ')}`);
}

// Pure preview has no Editor Gateway, but it still consumes the same producer
// contract. This validates descriptor registration and producer-owned lifecycle
// recovery without inventing a second action/read carrier for the no-editor host.
if (gamePluginLoad.plugins.some((plugin) => plugin.producer !== undefined)) {
  const producerResult = await installGamePluginProducers(gamePluginLoad, { world });
  if (!producerResult.ok) {
    console.error(`[engine] gameplay producer failed: ${producerResult.error.pluginId}: ${producerResult.error.hint}`);
  } else {
    console.log(`[engine] gameplay producers admitted: ${producerResult.value.descriptors.map((descriptor) => `${descriptor.id}@${descriptor.version}`).join(', ')}`);
  }
}
}

if (playApp === undefined) {
  throw new Error('[engine] Play app bootstrap did not produce an app');
}
(window as unknown as {
  __forgeaxExecutionReport?: () => ReturnType<import('@forgeax/engine-app').ExecutionControl['report']>;
}).__forgeaxExecutionReport = () => playApp.execution.report();
(window as unknown as {
  __forgeaxExecutionDiagnostics?: () => ReturnType<typeof playExecutionDiagnostics.snapshot>;
}).__forgeaxExecutionDiagnostics = () => playExecutionDiagnostics.snapshot();

// ── Completed-frame FPS + liveness ──
// VAG_FPS_STATS is rendering evidence, so it must be produced only after
// renderer.draw reaches queue submission. An Update system can keep ticking
// after draw fails and would make both the UI and CI smoke report a false FPS.
if (subscribePlayFrameEnd !== undefined) {
  const unsubscribe = installCompletedFrameHeartbeat({
    subscribe: (listener) => subscribePlayFrameEnd(() => {
      hideLoadingOverlay();
      listener();
    }),
    now: () => performance.now(),
    publish: (heartbeat) => {
      carrierSentinel = heartbeat.sentinel;
      try {
        sendVagMessage(window.parent, VagFpsStatsSchema, { fps: heartbeat.fps });
        sendVagMessage(window.parent, VagCarrierHeartbeatSchema, carrierPayload(
          carrierFailure ? 'unavailable' : 'ready',
        ));
      } catch (error) {
    console.warn('[play] VAG carrier message dropped', error);
  }
    },
  });
  window.addEventListener('pagehide', unsubscribe, { once: true });
}

// ── Start the frame loop ──
playApp.start();
carrierExecutionReport = playApp.execution.report();

try {
  await carrierScopeReady;
  sendVagMessage(window.parent, VagCarrierHandshakeSchema, carrierPayload('pending', null));
} catch (error) {
  console.warn('[play] VAG carrier message dropped', error);
}

// ── Device-lost → ask the shell to self-heal (reload this iframe) ──
// The engine's onError fan-out carries the RhiError 'device-lost' arm (the
// engine error union has no 'context-lost' code). PlaySurface listens for
// VAG_DEVICE_LOST and reloads. Previously NOTHING emitted it, so a real GPU loss
// left a dead canvas with no recovery. Send once (device-lost is terminal — the
// engine runs its cleanup funnel).
let deviceLostSent = false;
playApp.onError((err) => {
  // App.onError is the engine's structured runtime/render failure channel.
  // Keep it visible to browser smoke and to users inspecting the console;
  // transporting it to the host alone would make a failed renderer look like
  // a healthy Preview page.
  console.error('[engine] runtime error:', err);
  carrierFailure = runtimeFailure(err);
  const failure = carrierFailure;
  if (!failure) return;
  try {
    const payload = carrierPayload('unavailable', failure);
    sendVagMessage(window.parent, VagCarrierFailureSchema, { ...payload, failure });
  } catch (error) {
    console.warn('[play] VAG carrier message dropped', error);
  }
  if (failure.code === 'device-lost' && !deviceLostSent) {
    deviceLostSent = true;
    sendVagMessage(window.parent, VagDeviceLostSchema, {});
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
    } catch (error) {
    console.warn('[play] VAG carrier message dropped', error);
  }
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

// ── Network bridge (VAG_NETWORK postMessage) ──
// Mirror the console bridge for fetch / XHR / WebSocket so the Studio Network
// panel can show the game's HTTP/WS activity (asset loads, scoped import 4xx/5xx,
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
createPlayProductRuntimeAdapter({
  target: window,
  allowedOrigins: allowedParentOrigins(),
  controls: {
    pause: () => { void playApp.pause(); },
    play: () => { void playApp.resume(); },
    reload: () => location.reload(),
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
