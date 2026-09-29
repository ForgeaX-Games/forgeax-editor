import { runtimeFailure } from './runtime-failure';
import { resolvePlayGameActivation, activatePlayGame } from './play-game-activation';
import { resolvePlaySceneGuid } from './play-scene-selection';
import { importFirstGameEntry } from './game-entry-loader';
import { refreshPlayCatalogUntilReady } from './play-catalog-ready';
import { projectRuntimeDiagnostics } from './execution-bootstrap';
import { PlayBindingFailure, bootDiagnostics } from './boot-diagnostic';
import { resolveCarrierScope } from './carrier-scope';
import {
  createApp,
  gameHostPlugin,
  renderFeaturePlugin,
  ensureFallbackCamera,
  type App,
  type ExecutionApp,
  type GameHost,
  type Plugin,
} from '@forgeax/engine-app';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { audioPlugin } from '@forgeax/engine-audio';
import { webAudioPlugin } from '@forgeax/engine-audio-webaudio';
import {
  addGamePluginSystems,
  describeGamePluginSystems,
  editorComponentVocabularyPlugin,
  installGamePluginProducers,
  listForgeEnginePluginModulePaths,
  resolvePhysicsBackendFromForgePlugins,
  loadGamePluginModules,
  activatesBeforeScene,
  resolveGamePluginModuleDescriptors,
  type GamePluginLoad,
} from '@forgeax/editor-game-plugins';
// engine #610 (Tier-1 decomposition) moved procedural geometry out of
// engine-runtime into the @forgeax/engine-geometry leaf package.
import { createCylinderGeometry } from '@forgeax/engine-geometry';
import { physicsPlugin } from '@forgeax/engine-physics';
import { skinningPlugin } from '@forgeax/engine-skinning';
import { createDevImportTransport } from '@forgeax/engine-runtime';
import {
  createGameplayInputSurface,
  sendVagMessage,
  VagMessageError,
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
import { normalizeAnimationPlayerSceneAssetInPlace } from './normalize-animation-player-scene-asset';
import { createUserTimingProfiler } from '@forgeax/engine-profiler/browser-user-timing';
import {
  loadGameProject } from '@forgeax/engine-project';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { type SceneAsset, type RuntimeAssetBinding } from '@forgeax/engine-types';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { BootstrapContext, BootstrapEntry } from './types';
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
import {
  loadRuntimeBinding as fetchRuntimeBinding,
  RUNTIME_BINDING_MAX_WAIT_MS,
  RUNTIME_BINDING_RETRY_DELAY_MS,
} from './runtime-binding-loader';
import { bootstrap as staticGameBootstrap } from 'virtual:forgeax-static-game-entry';
import { modules as staticGamePluginModules, importModule as importStaticGamePlugin,
} from 'virtual:forgeax-static-game-plugins';
import { installPlayBootDiagProbe, playBootDiag, playBootDiagMark } from './play-boot-diag';

// TODO 004: When this Play/preview viewport is embedded as a studio iframe,
// forward global shortcuts to the studio shell. Standalone mode is a no-op.
installShortcutForwarder();
installPlayBootDiagProbe();
playBootDiagMark('document.init', {
  href: location.href,
  gameParam: new URLSearchParams(location.search).get('game'),
  runtimeScopeId: new URLSearchParams(location.search).get('runtimeScopeId'),
  runtimeGeneration: new URLSearchParams(location.search).get('runtimeGeneration'),
});

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
let deviceLostSent = false;
let reportedCarrierSchemaError = false;

function reportCarrierSchemaError(error: unknown): void {
  if (!(error instanceof VagMessageError) || reportedCarrierSchemaError) return;
  reportedCarrierSchemaError = true;
  console.error('[engine] carrier protocol message rejected:', error);
}

function bootErrorRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

let readCarrierExecutionReport: (() => unknown) | undefined;

function carrierPayload(
  renderReadiness: 'pending' | 'ready' | 'unavailable',
  failure: VagCarrierFailureDetail | null = carrierFailure,
) {
  const rendererIdentity = carrierRendererProvenance?.identity ?? 'renderer-pending';
  const rendererGeneration = carrierRendererProvenance?.generation ?? null;
  const effectiveReadiness =
    rendererGeneration === null && renderReadiness === 'ready'
      ? ('unavailable' as const)
      : renderReadiness;
  return {
    version: VAG_CARRIER_PROTOCOL_VERSION,
    runtimeId: carrierRuntimeId,
    runtimeGeneration:
      expectedGeneration !== null &&
      Number.isSafeInteger(expectedGeneration) &&
      expectedGeneration > 0
        ? expectedGeneration
        : undefined,
    carrierId: qp.get('carrierId')?.trim() || undefined,
    carrierKind: qp.get('carrierKind') === 'iframe' ? ('iframe' as const) : undefined,
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
    execution: toVagExecutionEnvelope(readCarrierExecutionReport?.()),
    failure: failure ?? carrierFailure,
  };
}

function publishCarrierBootFailure(error: unknown): void {
  hideLoadingOverlay();
  const detail = bootErrorRecord(error);
  const message =
    error instanceof Error
      ? error.message
      : typeof detail?.message === 'string'
        ? detail.message
        : typeof detail?.hint === 'string'
          ? detail.hint
          : String(error);
  carrierFailure = {
    code: error instanceof PlayBindingFailure ? error.code : 'play-carrier-boot-failed',
    stage: 'handshake',
    retryable: error instanceof PlayBindingFailure ? error.retryable : true,
    diagnostics: bootDiagnostics(error),
    hint: message,
    at: new Date().toISOString(),
    message,
  };
  try {
    const payload = carrierPayload('unavailable', carrierFailure);
    sendVagMessage(window.parent, VagCarrierFailureSchema, {
      ...payload,
      failure: carrierFailure,
    });
  } catch (error) {
    console.warn('[play] VAG carrier message dropped', error);
  }
}

async function loadRuntimeBinding(): Promise<RuntimeAssetBinding | undefined> {
  if (__FORGEAX_STATIC_BUILD__) return undefined;
  const bindingUrl = `${(import.meta.env.BASE_URL ?? '/').replace(/\/$/, '')}/__pack/runtime-binding.json`;
  playBootDiagMark('binding.wait.begin', { bindingUrl });
  const requireExactScope = expectedScopeId !== null
    && expectedGeneration !== null
    && Number.isSafeInteger(expectedGeneration)
    && expectedGeneration > 0;
  const expected = requireExactScope && requestedGameIdValidated
    ? { gameId: requestedGameIdValidated, scopeId: expectedScopeId, generation: expectedGeneration }
    : undefined;
  const pollUntilScopeMatches = requireExactScope && qp.get('runtimeBindingPoll') === '1';
  if (!pollUntilScopeMatches) {
    const binding = await fetchRuntimeBinding(bindingUrl, fetch, { expected });
    if (
      requireExactScope &&
      (expectedScopeId === null ||
        expectedGeneration === null ||
        !Number.isSafeInteger(expectedGeneration) ||
        expectedGeneration < 1 ||
        binding === undefined ||
        binding.scopeId !== expectedScopeId ||
        binding.generation !== expectedGeneration)
    ) {
      throw new Error('[engine] requested runtime generation does not match the active binding');
    }
    return binding;
  }

  const deadline = Date.now() + RUNTIME_BINDING_MAX_WAIT_MS;
  let lastFailure = 'no binding';
  let bindingPolls = 0;
  while (Date.now() < deadline) {
    bindingPolls += 1;
    try {
      const remaining = deadline - Date.now();
      const binding = await fetchRuntimeBinding(bindingUrl, fetch, {
        expected,
        maxWaitMs: Math.min(5_000, Math.max(remaining, RUNTIME_BINDING_RETRY_DELAY_MS)),
      });
      if (
        binding !== undefined &&
        binding.scopeId === expectedScopeId &&
        binding.generation === expectedGeneration
      ) {
        playBootDiagMark('binding.wait.matched', {
          polls: bindingPolls,
          scopeId: binding.scopeId,
          generation: binding.generation,
        });
        return binding;
      }
      if (binding !== undefined) {
        lastFailure = `active scope=${binding.scopeId} gen=${binding.generation}; expected scope=${expectedScopeId} gen=${expectedGeneration}`;
      } else {
        lastFailure = 'runtime scope unbound';
      }
      if (bindingPolls === 1 || bindingPolls % 10 === 0) {
        playBootDiagMark('binding.wait.poll', {
          polls: bindingPolls,
          lastFailure,
          expectedScopeId,
          expectedGeneration,
        });
      }
    } catch (error) {
      if (error instanceof PlayBindingFailure && error.code !== 'play-runtime-scope-stale') throw error;
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    const waitMs = deadline - Date.now();
    if (waitMs <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(RUNTIME_BINDING_RETRY_DELAY_MS, waitMs)),
    );
  }
  throw new Error(
    `[engine] requested runtime generation does not match the active binding (${lastFailure})`,
  );
}

const carrierScopeReady = resolveCarrierScope(
  carrierRuntimeId,
  requestedGameIdValidated,
  fetch,
).then((scope) => {
  carrierScope = scope;
});
await carrierScopeReady;
let runtimeBinding: RuntimeAssetBinding | undefined;
try {
  runtimeBinding = await loadRuntimeBinding();
  if (
    runtimeBinding !== undefined &&
    requestedGameIdValidated !== null &&
    runtimeBinding.gameId !== requestedGameIdValidated
  ) {
    throw new Error(
      `[engine] requested game ${requestedGameIdValidated} does not match active runtime scope ${runtimeBinding.gameId}`,
    );
  }
} catch (error) {
  publishCarrierBootFailure(error);
  throw error;
}
const gameId = runtimeBinding?.gameId ?? requestedGameIdValidated ?? '_template';
canvas.id = carrierCanvasId;
playBootDiagMark('runtime.scope', {
  gameId,
  requestedGameId: requestedGameIdValidated,
  binding:
    runtimeBinding === undefined
      ? null
      : {
          gameId: runtimeBinding.gameId,
          scopeId: runtimeBinding.scopeId,
          generation: runtimeBinding.generation,
          status: runtimeBinding.status,
        },
  expectedScopeId,
  expectedGeneration,
});

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

// ── Physics gate (forge.json 2.0: @forgeax/engine/physics/rapier* in plugins) ──
// Physics is OFF by default so non-physics games pay zero rapier-WASM cost.
// Schema 2.0 declares Rapier via the plugins tree (same signal as edit-runtime
// resolveEditPhysics). We must read it BEFORE createApp because the backend +
// 3-phase tick systems are wired at app-construction time.
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
  fetch(`${gameUrlBase(forgeBase, gameId)}/${path}`, {
    cache: 'no-store',
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  });
let gpResult: Awaited<ReturnType<typeof loadGameProject>> | null = null;
{
  try {
    gpResult = await loadGameProject(fetchRead);
  } catch {
    /* read injection threw → treat as missing */
  }
}
playBootDiagMark('forge.project', {
  gameId,
  ok: gpResult?.ok ?? false,
  entry: gpResult?.ok ? gpResult.value.entry : undefined,
  defaultScene: gpResult?.ok ? gpResult.value.defaultScene : undefined,
  physics: gpResult?.ok ? resolvePhysicsBackendFromForgePlugins(gpResult.value.plugins) : undefined,
});
if (gpResult?.ok) {
  physics = resolvePhysicsBackendFromForgePlugins(gpResult.value.plugins);
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
    const response = await fetch(`${forgeBase}/game-plugins/${id}.json`, {
      cache: 'no-store',
    });
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
const executionEntry =
  !__FORGEAX_STATIC_BUILD__ &&
  gpResult?.ok &&
  typeof gpResult.value.executionEntry === 'string' &&
  gpResult.value.executionEntry.trim().length > 0
    ? gpResult.value.executionEntry.replace(/^\.?\//, '')
    : null;
let playApp: App | ExecutionApp | undefined;
let playWorld: World | undefined;
let subscribePlayFrameEnd: ((listener: () => void) => () => void) | undefined;
let executionHost: StartedPlayExecution | undefined;
const playExecutionDiagnostics = createPlayExecutionDiagnosticsStore();
let readPlayDiagnostics = () => playExecutionDiagnostics.snapshot();

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
    readCarrierExecutionReport = playApp.execution.report.bind(playApp.execution);
    executionHost.hostPort.addEventListener('message', (event: MessageEvent<unknown>): void => {
      if (!isPlayExecutionRealmMessage(event.data)) {
        const candidate = event.data as {
          protocol?: unknown;
          kind?: unknown;
        } | null;
        if (candidate?.protocol === PLAY_EXECUTION_PROTOCOL && candidate.kind === 'realm-ready') {
          markRendererProvenanceFailure(
            'execution realm-ready message failed provenance validation',
          );
        }
        return;
      }
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
        sendVagMessage(window.parent, VagFpsStatsSchema, {
          fps: event.data.fps,
        });
        sendVagMessage(
          window.parent,
          VagCarrierHeartbeatSchema,
          carrierPayload(carrierFailure ? 'unavailable' : 'ready'),
        );
      } catch (error) {
        reportCarrierSchemaError(error);
      }
    });
    executionHost.hostPort.start();
    window.addEventListener('pagehide', () => executionHost?.disposeHost(), {
      once: true,
    });
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
  const devImportTransport =
    runtimeBinding === undefined ? undefined : createDevImportTransport(runtimeBinding);
  async function createCarrierApp() {
    try {
      return await createApp(
        canvas,
        {
          assetRuntimeBinding: runtimeBinding,
          // RenderFeature registration belongs to Renderer construction. The App
          // owns this list and the renderer host validates capabilities and
          // prewarms the declared shader set; there is no post-boot install shim.
          features: [vfxRuntime.host.feature],
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
        },
        {
          ...forgeaxBundlerAdapter(),
          ...(devImportTransport === undefined ? {} : { importTransport: devImportTransport }),
        },
      );
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

  const carrierApp = app.value;
  const { world, renderer, assets } = carrierApp;
  if (assets === undefined) {
    const error = new Error('[engine] createApp did not provide its runtime AssetRegistry');
    hideLoadingOverlay();
    paintDiagnosticMessage(canvas, error);
    publishCarrierBootFailure(error);
    throw error;
  }
  playApp = carrierApp;
  readCarrierExecutionReport = playApp.execution.report.bind(playApp.execution);
  playWorld = world;
  readPlayDiagnostics = () => projectRuntimeDiagnostics({ world, renderer });
  subscribePlayFrameEnd = (listener) =>
    renderer.subscribe((event) => {
      if (event.kind === 'frame-submitted') listener();
    });
  playBootDiagMark('frame-end.subscribe', {
    available: typeof renderer.subscribe === 'function',
  });
  if (!supportsVfxRenderFeature(renderer.inspect().capabilities)) {
    console.warn(
      '[play] VFX render feature disabled: active RHI lacks compute or indirect-drawing capability',
    );
  }
  // Renderer lifecycle transitions are separate from RenderError. In particular,
  // a3 reports device loss through the Renderer event stream, so do not infer it
  // by comparing an error-code union that intentionally has no `device-lost`
  // member.
  const unsubscribeRendererEvents = renderer.subscribe((event) => {
    if (event.kind !== 'state-changed' || event.current !== 'device-lost' || deviceLostSent) return;
    deviceLostSent = true;
    carrierFailure = {
      code: 'device-lost',
      stage: 'device-lost',
      retryable: false,
      hint: 'The Play renderer device was lost; reload the carrier to recover.',
      at: new Date().toISOString(),
    };
    try {
      const failure = carrierFailure;
      sendVagMessage(window.parent, VagCarrierFailureSchema, {
        ...carrierPayload('unavailable', failure),
        failure,
      });
      sendVagMessage(window.parent, VagDeviceLostSchema, {});
    } catch {
      /* parent might be cross-origin */
    }
  });
  window.addEventListener('pagehide', unsubscribeRendererEvents, {
    once: true,
  });
  if (runtimeBinding !== undefined) {
    assets.configureRuntimeBinding(runtimeBinding);
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
      assets.catalog(cylG.value, cylGeo.value);
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
  let gamePluginLoad: GamePluginLoad = {
    plugins: [],
    systems: [],
    components: [],
    errors: [],
  };
  if (gameId !== '_template') {
    try {
      if (__FORGEAX_STATIC_BUILD__ && gameId === __FORGEAX_STATIC_GAME_ID__) {
        gamePluginLoad = await loadGamePluginModules({
          modules: staticGamePluginModules,
          importModule: importStaticGamePlugin,
        });
        for (const error of gamePluginLoad.errors) {
          console.error(
            `[engine] static game plugin failed: ${error.clientPath}: ${error.message}`,
          );
        }
      } else {
        let modules: Array<{ clientPath: string; url: string }> = [];
        const response = await fetch(`${packBase}/game-plugins/${gameId}.json`, {
          cache: 'no-store',
        });
        if (response.ok) {
          const body = (await response.json()) as { modules?: unknown };
          if (Array.isArray(body.modules)) {
            modules = body.modules.filter(
              (module): module is { clientPath: string; url: string } =>
                typeof module === 'object' &&
                module !== null &&
                typeof (module as { clientPath?: unknown }).clientPath === 'string' &&
                typeof (module as { url?: unknown }).url === 'string',
            );
          }
        }
        if (
          modules.length === 0 &&
          gpResult?.ok &&
          gpResult.value.schemaVersion === '2.0.0' &&
          Array.isArray(gpResult.value.plugins)
        ) {
          const gameBase = gameUrlBase(packBase, gameId);
          const forgePaths = listForgeEnginePluginModulePaths(gpResult.value.plugins);
          modules = resolveGamePluginModuleDescriptors(forgePaths, [], '', gameBase);
        }
        if (modules.length > 0) {
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

  // Plugins that declare beforeScene own authored component schemas. Admit them
  // before defaultScene instantiation; other plugins observe the scene later.
  const beforeGamePluginComponents = new Set(world.components.entries().keys());
  const beforeGamePluginSystems = new Set(world.inspect().systems.map((system) => system.name));
  for (const loaded of gamePluginLoad.plugins) {
    if (loaded.plugin === undefined || !activatesBeforeScene(loaded.plugin)) continue;
    await carrierApp.pluginContext.plugin(loaded.plugin);
  }

  // DEBUG: expose for console probing without replacing Engine-owned capture hooks.
  const forgeaxDebug = (window as unknown as { __forgeax?: Record<string, unknown> }).__forgeax;
  (window as unknown as { __forgeax?: Record<string, unknown> }).__forgeax = {
    ...(forgeaxDebug ?? {}),
    app: carrierApp,
    world,
    renderer,
  };
  playBootDiagMark('renderer.ready', { state: renderer.state() });

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
  const requiredScene = playSceneGuid;
  if (playSceneGuid !== undefined) {
    try {
      if (!(await refreshPlayCatalogUntilReady(assets, { requiredGuid: requiredScene }))) {
        throw new Error(`Play scene ${playSceneGuid} was not published before startup timed out`);
      }
      const parsed = AssetGuid.parse(playSceneGuid);
      if (!parsed.ok) throw new Error(`Invalid Play scene GUID: ${playSceneGuid}`);
      const assetRes = await assets.loadByGuid<SceneAsset>(parsed.value);
      if (assetRes.ok) {
        normalizeAnimationPlayerSceneAssetInPlace(assetRes.value);
        defaultScene = assetRes.value; // capture loaded SceneAsset (D-4)
        const handle = world.allocSharedRef('SceneAsset', assetRes.value);
        const instantiateRes = assets.instantiate(handle, world);
        if (!instantiateRes.ok) throw instantiateRes.error;
        defaultSceneRoot = instantiateRes.value;
        playBootDiagMark('defaultScene.instantiated', { guid: playSceneGuid, worldEntityCount: world.inspect().entityCount });
      } else {
        throw assetRes.error;
      }
    } catch (error) {
      hideLoadingOverlay();
      publishCarrierBootFailure(error);
      throw error;
    }
  } else {
    await refreshPlayCatalogUntilReady(assets);
    playBootDiagMark('defaultScene.skipped', { reason: 'absent-in-forge.json' });
  }

  const gameplayProjection = createPlayGameplayProjection();
  const gameplayInput = createGameplayInputSurface(canvas, document.body);
  window.addEventListener('pagehide', () => gameplayInput.dispose(), {
    once: true,
  });
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
            | {
                readonly ok: false;
                readonly error: {
                  readonly code: string;
                  readonly hint: string;
                };
              };
          try {
            result =
              request.operation === 'describe'
                ? { ok: true as const, data: gameplayProjection.describe() }
                : request.operation === 'input'
                  ? await gameplayInput.send(request.action)
                  : request.operation === 'run'
                    ? await gameplayProjection.run(
                        request.id,
                        request.args as Parameters<typeof gameplayProjection.run>[1],
                      )
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
                ? result.data === undefined
                  ? {}
                  : { data: result.data }
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
    app: carrierApp,
    uiRoot: playUiRoot,
    // A (cleanup hook): no-op — this host reloads the whole document on ■ Stop,
    // so every side effect is discarded regardless. Present only to keep the
    // contract identical to the editor host (games register defensively).
    registerCleanup() {
      /* reload-on-stop discards everything */
    },
    gameProjection: gameplayProjection.registrar,
    // M5 w22 / D-3: command-set pointer-lock gate. The game template calls this
    // when the view mode changes (setPointerLockAllowed(mode === 'fps')). Delegate
    // to the input backend, which owns the lock SSOT and immediately releases on
    // set(false). Optional-chained: engines predating the setter omit the method.
    setPointerLockAllowed: (allowed: boolean) => carrierApp.input?.setPointerLockAllowed?.(allowed),
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
    app: carrierApp,
    uiRoot: playUiRoot,
    setPointerLockAllowed: (allowed: boolean) => carrierApp.input?.setPointerLockAllowed?.(allowed),
    gameProjection: gameplayProjection.registrar,
    ...(defaultSceneRoot !== undefined ? { defaultSceneRoot } : {}),
    ...(defaultScene !== undefined ? { defaultScene } : {}),
  };

  /** Mount forge.json game plugins after defaultScene + GameHost exist. Failures degrade to warn-only so the frame loop still starts. */
  async function activateProjectGamePlugins(): Promise<boolean> {
    if (gamePluginLoad.plugins.length === 0) return true;
    try {
      await carrierApp.pluginContext.plugin(gameHostPlugin(gameHost));
      for (const loaded of gamePluginLoad.plugins) {
        if (loaded.plugin !== undefined && !activatesBeforeScene(loaded.plugin)) {
          await carrierApp.pluginContext.plugin(loaded.plugin as Plugin);
        }
      }
      gamePluginLoad = {
        ...gamePluginLoad,
        components: [...world.components.entries().keys()].filter(
          (name) => !beforeGamePluginComponents.has(name),
        ),
        systems: world
          .inspect()
          .systems.map((system) => system.name)
          .filter((name) => !beforeGamePluginSystems.has(name)),
      };
      playBootDiagMark('forge.plugins.activate.ok', {
        gameId,
        pluginCount: gamePluginLoad.plugins.length,
        systems: gamePluginLoad.systems.length,
        components: gamePluginLoad.components.length,
      });
      return true;
    } catch (error) {
      console.warn('[engine] game plugin activation failed:', error);
      playBootDiagMark('bootstrap.forge-plugins-degraded', {
        gameId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  // ── loadGame ──
  async function resolveGameModule(id: string): Promise<unknown | null> {
    if (id === '_template') {
      console.log(
        '[engine] no game id in URL — open /preview/?game=<slug> to load one; rendering fallback scene',
      );
      return null;
    }
    const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
    const gameBase = gameUrlBase(base, id);

    if (
      __FORGEAX_STATIC_BUILD__ &&
      id === __FORGEAX_STATIC_GAME_ID__ &&
      typeof staticGameBootstrap === 'function'
    ) {
      return { bootstrap: staticGameBootstrap };
    }

    // Plugin-only projects are assembled above; they declare no legacy bootstrap.
    if (gpResult?.ok && !gpResult.value.entry) return null;

    // Entry resolution. The game entry filename is no longer hardcoded: the
    // authoritative source is forge.json's `entry` field (relative to the game
    // dir). The canonical convention is a root-level `main.ts` (sibling to
    // `src/`, which holds the rest of the game code). We still fall back to the
    // legacy `src/main.ts` so games created before the rename keep loading.
    const candidates: string[] = [];
    if (id !== '_template' && gpResult?.ok) {
      const entry = gpResult.value.entry;
      if (typeof entry === 'string' && entry) candidates.push(entry.replace(/^\.?\//, ''));
    }
    for (const fallback of ['main.ts', 'src/main.ts']) {
      if (!candidates.includes(fallback)) candidates.push(fallback);
    }
    playBootDiagMark('entry.candidates', { gameId: id, gameBase, candidates });

    // Probe with dynamic import, not HEAD: Vite's SPA fallback can make a missing
    // src/main.ts answer HEAD with 200 text/html, then the import 404s and we skip
    // the real root-level main.ts that forge.json declares.
    let module: unknown;
    try {
      module = await importFirstGameEntry(
        candidates.map((relative) => `${gameBase}/${relative}`),
        (url) => import(/* @vite-ignore */ `${url}?t=${Date.now()}`),
      );
    } catch (error) {
      playBootDiagMark('entry.failed', {
        gameId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      publishCarrierBootFailure(error);
      hideLoadingOverlay();
      throw error;
    }
    return module;
  }

  // ── entry bootstrap hook (D-2: semantic downgrade — host instantiates
  // defaultScene before this point, so the game module receives a world that
  // already contains the default scene entities. The bootstrap hook wires HUD /
  // inputs / custom systems onto the live world. Signature: export function
  // bootstrap(world, ctx?) — world as first param.
  const activation = await resolvePlayGameActivation(gameId, await resolveGameModule(gameId));
  await activateProjectGamePlugins();
  if (activation.kind !== 'none') {
    // 三种 entry 形态整体包一层:任何一种引导失败都要发 carrier boot 失败信号,
    // 否则 §4「Play 无法启动」的卡片拿不到原因。rethrow 保持原有失败语义不变。
    try {
      playBootDiagMark('bootstrap.begin', {
        gameId,
        appHostTag: root.tagName,
        canvasTag: canvas.tagName,
        queryAppTag: document.querySelector('#app')?.tagName ?? null,
        queryCanvasTag: document.querySelector('canvas')?.tagName ?? null,
      });
      await activatePlayGame({ app: carrierApp, world, gameHost, ctx, activation });
      playBootDiagMark('bootstrap.done', {
        gameId,
        worldEntityCount: world.inspect().entityCount,
      });
    } catch (error) {
      playBootDiagMark('bootstrap.failed', {
        gameId,
        error: error instanceof Error ? error.message : String(error),
      });
      publishCarrierBootFailure(error);
      throw error;
    }
  } else {
    playBootDiagMark('bootstrap.skipped', { gameId, reason: 'no-entry' });
    if (gamePluginLoad.plugins.length === 0) {
      console.log('[engine] using fallback scene; write games/<id>/main.ts to override');
    }
    ensureFallbackCamera(world, window.innerWidth / window.innerHeight);
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
    if (missing.length > 0)
      console.warn(
        `[engine] missing game systems: ${missing.map((entry) => entry.system).join(', ')}`,
      );
  }

  // Pure preview has no Editor Gateway, but it still consumes the same producer
  // contract. This validates descriptor registration and producer-owned lifecycle
  // recovery without inventing a second action/read carrier for the no-editor host.
  if (gamePluginLoad.plugins.some((plugin) => plugin.producer !== undefined)) {
    const producerResult = await installGamePluginProducers(gamePluginLoad, {
      world,
    });
    if (!producerResult.ok) {
      console.error(
        `[engine] gameplay producer failed: ${producerResult.error.pluginId}: ${producerResult.error.hint}`,
      );
    } else {
      console.log(
        `[engine] gameplay producers admitted: ${producerResult.value.descriptors.map((descriptor) => `${descriptor.id}@${descriptor.version}`).join(', ')}`,
      );
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
}).__forgeaxExecutionDiagnostics = () => readPlayDiagnostics();

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
      if (heartbeat.sentinel === 1) {
        playBootDiagMark('carrier.first-frame', { fps: heartbeat.fps, gameId });
      }
      try {
        sendVagMessage(window.parent, VagFpsStatsSchema, { fps: heartbeat.fps,
        });
        sendVagMessage(window.parent, VagCarrierHeartbeatSchema, carrierPayload(
          carrierFailure ? 'unavailable' : 'ready'),
        );
      } catch (error) { reportCarrierSchemaError(error); }
    },
  });
  window.addEventListener('pagehide', unsubscribe, { once: true });
}

// ── Start the frame loop ──
playApp.start();
playBootDiagMark('frame-loop.started', { gameId });

try {
  await carrierScopeReady;
  const handshake = carrierPayload('pending', null);
  playBootDiagMark('carrier.handshake', {
    renderReadiness: handshake.renderReadiness,
    rendererGeneration: handshake.rendererGeneration,
    rendererIdentity: handshake.rendererIdentity,
  });
  sendVagMessage(window.parent, VagCarrierHandshakeSchema, handshake);
} catch (error) { reportCarrierSchemaError(error); }

// ── Renderer/App errors ──
// Device loss is handled by the Renderer state event above. App.onError remains
// the structured channel for ordinary render/runtime failures.
playApp.onError((err) => {
  // App.onError is the engine's structured runtime/render failure channel.
  // Keep it visible to browser smoke and to users inspecting the console;
  // transporting it to the host alone would make a failed renderer look like
  // a healthy Preview page.
  console.error('[engine] runtime error:', JSON.stringify({
    code: err.code,
    detail: 'detail' in err ? err.detail : undefined,
  }), err,
  );
  carrierFailure = runtimeFailure(err);
  const failure = carrierFailure;
  if (!failure) return;
  try {
    const payload = carrierPayload('unavailable', failure);
    sendVagMessage(window.parent, VagCarrierFailureSchema, { ...payload, failure,
    });
  } catch (error) {
    console.warn('[play] VAG carrier message dropped', error);
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
    const head = typeof r.code === 'string' ? `${value.name} ${r.code}: ${value.message}`
        : `${value.name}: ${value.message}`;
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
        const head =
          typeof cr.code === 'string'
            ? `${c.name} ${cr.code}: ${c.message}`
            : `${c.name}: ${c.message}`;
        parts.push(`cause=${head}`);
        if (typeof cr.expected === 'string') parts.push(`cause.expected=${cr.expected}`);
        if (typeof cr.hint === 'string') parts.push(`cause.hint=${cr.hint}`);
        if (cr.detail !== undefined) {
          try {
            parts.push(`cause.detail=${JSON.stringify(cr.detail, shallowErrorReplacer)}`);
          } catch {
            parts.push(`cause.detail=${String(cr.detail)}`);
          }
        }
        if (typeof c.stack === 'string')
          parts.push(`cause.stack=\n${c.stack.split('\n').slice(0, 4).join('\n')}`);
      } else if (c !== undefined) {
        parts.push(`cause=${typeof c === 'string' ? c : JSON.stringify(c, shallowErrorReplacer)}`);
      }
    }
    if (r.detail !== undefined) {
      try {
        parts.push(`detail=${JSON.stringify(r.detail, shallowErrorReplacer)}`);
      } catch {
        parts.push(`detail=${String(r.detail)}`);
      }
    }
    if (typeof a.stack === 'string') parts.push(a.stack.split('\n').slice(0, 4).join('\n'));
    return parts.join(' | ');
  }
  try {
    return JSON.stringify(a, shallowErrorReplacer);
  } catch {
    return String(a);
  }
}
(['log', 'warn', 'error', 'info', 'debug'] as const).forEach((level) => {
  const original = (console[level] as (...args: unknown[]) => void).bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    try {
      const text = args.map(fmtArg).join(' ');
      sendVagMessage(window.parent, VagConsoleSchema, {
        level,
        text,
        ts: Date.now(),
      });
    } catch (error) {
      console.warn('[play] VAG carrier message dropped', error);
    }
  };
});

window.addEventListener('error', (ev) => {
  try {
    sendVagMessage(window.parent, VagConsoleSchema, {
      level: 'error',
      text: `${ev.message}\n  at ${ev.filename}:${ev.lineno}`,
      ts: Date.now(),
    });
  } catch {
    /* ignore */
  }
});
window.addEventListener('unhandledrejection', (ev) => {
  try {
    sendVagMessage(window.parent, VagConsoleSchema, {
      level: 'error',
      text: `unhandled rejection: ${String(ev.reason)}`,
      ts: Date.now(),
    });
  } catch {
    /* ignore */
  }
});

// ── Network bridge (VAG_NETWORK postMessage) ──
// Mirror the console bridge for fetch / XHR / WebSocket so the Studio Network
// panel can show the game's HTTP/WS activity (asset loads, scoped import 4xx/5xx,
// plugin backend 503s, …). Best-effort + swallow all errors so it never breaks
// the game. Each request → one VAG_NETWORK summary forwarded up to the shell.
(() => {
  const send = (
    kind: 'fetch' | 'xhr' | 'ws',
    method: string,
    url: string,
    status: number,
    ms: number,
    ok: boolean,
  ): void => {
    try {
      sendVagMessage(window.parent, VagNetworkSchema, {
        kind,
        method,
        url: String(url).slice(0, 2048),
        status,
        ms: Math.round(ms),
        ok,
        ts: Date.now(),
      });
    } catch {
      /* cross-origin / detached */
    }
  };
  // fetch
  const origFetch = window.fetch?.bind(window);
  if (origFetch) {
    const wrappedFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const t0 = performance.now();
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      const method = (
        init?.method ??
        (input instanceof Request ? input.method : 'GET') ??
        'GET'
      ).toUpperCase();
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
    if (origFetch.preconnect)
      (wrappedFetch as unknown as Record<string, unknown>)['preconnect'] =
        origFetch.preconnect.bind(window);
    window.fetch = wrappedFetch as unknown as typeof fetch;
  }
  // XHR
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (
      this: XMLHttpRequest & { __fxN?: { m: string; u: string; t0: number } },
      method: string,
      url: string,
      ...rest: unknown[]
    ) {
      this.__fxN = { m: String(method).toUpperCase(), u: String(url), t0: 0 };
      // @ts-expect-error variadic passthrough
      return origOpen.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (
      this: XMLHttpRequest & { __fxN?: { m: string; u: string; t0: number } },
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      const n = this.__fxN;
      if (n) {
        n.t0 = performance.now();
        this.addEventListener('loadend', () => {
          send(
            'xhr',
            n.m,
            n.u,
            this.status,
            performance.now() - n.t0,
            this.status >= 200 && this.status < 400,
          );
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
    pause: () => {
      void playApp.pause();
    },
    play: () => {
      void playApp.resume();
    },
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
  const isInsecureRemote =
    location.protocol === 'http:' &&
    location.hostname !== 'localhost' &&
    location.hostname !== '127.0.0.1' &&
    !location.hostname.startsWith('localhost');

  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'background:#1a1a1f',
    'font:14px/1.5 ui-monospace,monospace',
    'padding:24px',
    'box-sizing:border-box',
    'pointer-events:auto',
    'z-index:99999',
    'white-space:pre-wrap',
    'text-align:left',
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
    lines.push('⚠ Engine init failed', '', reason);

    // EngineEnvironmentError carries a structured detail with webgpuError /
    // wgpuError — each is a RhiError-shape with code/expected/hint/detail. The
    // outer "no usable backend" message is generic; the inner RhiError is the
    // real cause (often unrelated to GPU adapter — e.g. shader manifest 404
    // returning HTML, asset pipeline failure, etc). Surface it ALL.
    const e = err as Record<string, unknown> | null;
    const detail =
      e && typeof e === 'object' ? (e.detail as Record<string, unknown> | undefined) : undefined;
    function dumpInner(label: string, re: unknown): void {
      if (!re || typeof re !== 'object') return;
      const r = re as Record<string, unknown>;
      lines.push('', `── ${label} ──`);
      if (r.message) lines.push(`message:  ${String(r.message)}`);
      if (r.code) lines.push(`code:     ${String(r.code)}`);
      if (r.expected) lines.push(`expected: ${String(r.expected)}`);
      if (r.hint) lines.push(`hint:     ${String(r.hint)}`);
      if (r.detail !== undefined) {
        try {
          lines.push(`detail:   ${JSON.stringify(r.detail)}`);
        } catch {
          lines.push(`detail:   ${String(r.detail)}`);
        }
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
