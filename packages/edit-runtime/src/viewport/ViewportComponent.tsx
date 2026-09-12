import { getLocale } from '@forgeax/editor-core/i18n';
import { installPlayFailureNotice } from './play-failure-notice';
import type { PlayDispatchResult } from './play-operation';
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
// WHY IT OWNS ONLY THE RENDER SURFACE
//   In-process there is no index.html #app scaffold, so the component provides
//   the full-size canvas container itself. Product controls are intentionally
//   excluded: PanelShell owns the toolbar in every host and detached window.
//
// Anchors: plan-strategy S2 D8 (ViewportComponent = canvas+world+renderer+camera+
// interaction, createApp moved), S4 R3 (net-zero world ctor), requirements C-1
// (single world), AC-04 (engine boots once in host), AC-12 (active-camera cut).

import { useEffect, useRef } from 'react';
import { Name, Transform } from '@forgeax/engine-scene';
import {
  Camera,
  CAMERA_PROJECTION_PERSPECTIVE,
  MeshFilter,
  MeshRenderer,
  perspective,
  TONEMAP_REINHARD_EXTENDED,
  type RenderFeature,
  type Renderer,
} from '@forgeax/engine-render';
import { setActiveCamera } from '@forgeax/engine-render/authoring';
import { Update, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { createApp, renderFeaturePlugin } from '@forgeax/engine-app';
import { createDevImportTransport } from '@forgeax/engine-runtime';
import { skinningPlugin } from '@forgeax/engine-skinning';
import {
  clearPreviewRuntimeBinding,
  setPreviewRuntimeBinding,
} from '../preview-world/preview-runtime-binding';
import {
  attachBrowserInputBackend,
  createCanvasInputBoundary,
  INPUT_BACKEND_KEY,
  INPUT_SNAPSHOT_RESOURCE_KEY,
} from '@forgeax/engine-input';
import {
  assetIO,
  gateway,
  panelBridge,
  getSceneId,
  getSceneFile,
  getViewportPreferences,
  getGizmoMode,
  getGizmoSpace,
  getGizmoPivot,
  getSelection,
  getGatewayWriteBarrier,
  entComponent,
  entComponents,
  entName,
  registerEditorWorldProjectionProvider,
  notifyDocChanged,
  switchSceneFile,
  createEvalChannel,
  createGameplayCaptureGateway,
  createGameplayCarrierBridge,
  createGameplayOperations,
  registerLiveGameplayBridge,
  installSourceAuthoringOps,
  type CommandOrigin,
  type DispatchResult,
  type GameplayGateway,
  type GameplayIdentity,
  type PlayDirtyPolicy,
  registerPostAssetWriteCatalogSync,
  createAuthoredAssetCatalogBarrier,
  registerMaterialInstanceLoader,
  registerInputMapLoader,
  getActiveRuntimeUiGraph,
  bindViewportRuntimeClient,
  forwardViewportRuntimeTransportRequest,
  configureEditorPageNavigation,
} from '@forgeax/editor-core';
import type {
  MessagePortTransportClient,
  RendererOwnerAdmissionIdentity,
  RendererOwnerAdmissionRequest,
  TransportService,
} from '@forgeax/editor-product';
import { createSourceAuthoringRuntime, installCatalogReconcileProvider } from '../runtime/source-authoring-runtime';
import { createSourceAuthoringTransport } from '../runtime/source-authoring-transport';
import { createCatalogSource } from '@forgeax/engine-assets-runtime';
import { createCatalogClient } from '@forgeax/engine-vite-plugin-pack/catalog-client';
import type { RuntimeAssetBinding } from '@forgeax/engine-types';
import { isViewportCarrierKind } from '@forgeax/editor-product';
import {
  sendVagMessage,
  VagCarrierHandshakeSchema,
  VagCarrierHeartbeatSchema,
  VagCarrierFailureSchema,
  VAG_CARRIER_PROTOCOL_VERSION,
} from '@forgeax/editor-core/protocol';
import { WorldManager } from '../world-manager';
import { createViewport, type Viewport } from './viewport';
import {
  createEditorAppTeardown,
  createPagehideTeardown,
  teardownIfStale,
} from './editor-app-teardown';
import {
  createViewportRuntimeTransportService,
  createInProcessViewportRuntimeClient,
  shouldBindInProcessViewportRuntimeClient,
  installViewportRuntimeConnectionHost,
  VIEWPORT_RUNTIME_PROJECTION_INVALIDATED,
  VIEWPORT_RUNTIME_OPEN_ASSET,
  readViewportRuntimeHostOrigin,
  readViewportRuntimeIdentity,
  type ViewportRuntimeMessageSource,
  type ViewportRuntimeMessageTarget,
} from '../runtime/viewport-runtime-transport';
import { installBroadcastViewportRuntimeHost } from '../runtime/viewport-runtime-broadcast';
import { installInProcessPreviewExecutorLeaseHost } from '../runtime/preview-executor-lease';
import { bindVfxPreviewExecutorLease } from './vfx-preview-operations';
import { installColliderDebugOverlay } from './collider-debug-overlay';
import { createFramePhaseProfiler } from './frame-phase-profiler';
import { captureGameplayViewport } from './gameplay-capture';
import {
  EDIT_VIEWPORT_MAX_PIXEL_RATIO,
  resolveEditViewportPixelRatio,
} from './edit-viewport-resolution';
// M6 extraction (plan-strategy §2 D-5, AC-08): console / network / diagnostics
// bridges moved to viewport-runtime-bridges.ts (decoupled from the createApp
// hotspot, AC-10). bootViewport keeps only the call sites.
import {
  installFpsReport,
  installConsoleBridge,
  installNetworkBridge,
  installAssetCatalogRefresh,
  installSourcePublicationObserver,
  installVisibilityPause,
  installErrorOverlay,
  paintDiagnosticMessage,
} from './viewport-runtime-bridges';
import { getFps, setFps } from '../fps-store';
import {
  getInputTarget,
  getViewportQuadrant,
  setViewportQuadrant,
  onViewportQuadrantChange,
  setEditorCameraEntity,
  getEditorCameraEntity,
  setGameCameraEntity,
  deriveActiveCameraEntity,
} from './viewport-quadrant';
import { registerEditorVisualHost } from './visual-source';
import { _syncDisplayMode, isAuxVisible } from './display-bus';
import { installAssetSpawnBridge, installViewportDropZone } from '../asset-spawn-bridge';
import {
  createInfiniteGridDiagnosticsProvider,
  createMaterialPublicationBinding,
  validatePerspectiveFov,
} from './render-diagnostics';
import { configureHostSession, resolveEditPhysics, initHostSession, type HostSession, type HostGameSession } from '../host-boot';
import { registerViewportSessionAppliers, type CaptureProducerProvenance } from './viewport-session-appliers';
import {
  createEditVfxRuntimeBridge,
  createParticleCameraSource,
} from './vfx-runtime-bridge';
import { editorComponentVocabularyPlugin } from '@forgeax/editor-game-plugins';
import { supportsVfxRenderFeature } from './vfx-render-capability';
import { createBootLease } from './boot-lease';
import { prepareViewportShaderManifestUrl } from './shader-manifest-url';
import {
  errorMessage,
  forwardFeedbackHealth,
  isReportablePlayFailure,
  normalizePlayFailureCode,
  normalizeRendererFailureCode,
  normalizeSaveFailureCode,
} from '../feedback-health';
import { createAnimationDiagnosticsProvider } from './animation-diagnostics-provider';
import { createEngineExecutionDiagnostics } from './execution-diagnostics-provider';
import { createInfiniteGridFeature } from './infinite-grid-feature';
import { createGizmoRenderFeature } from './gizmo-render-feature';
import {
  createVersionControlHostPort,
  createVersionControlRuntimeBinding,
  type VersionControlRuntimeBinding,
  type VersionControlRuntimeTransition,
} from '../version-control/provider';
import { createSwitchHandoff } from '../version-control/switch-applier';
import {
  createRendererOwnerAdmissionLease,
  installRendererOwnerAdmissionLease,
} from './renderer-owner-admission';
import '../theme.css';

// ── single-boot latch (AC-04) — the engine boots exactly once per document ─────
let bootStarted = false;

// Renderer provenance belongs to the Edit renderer realm, not to the public
// Engine Renderer shape. The module survives resetEditRealm(), so a replacement
// realm receives a new monotonic generation while one realm keeps one identity.
let nextRendererRealmGeneration = 0;

type RendererRealmProvenance = {
  readonly identity: string;
  readonly generation: number;
};

function mintRendererRealmProvenance(): RendererRealmProvenance | null {
  try {
    const identity = crypto.randomUUID();
    const generation = nextRendererRealmGeneration + 1;
    if (identity.length === 0 || !Number.isSafeInteger(generation) || generation <= 0) return null;
    nextRendererRealmGeneration = generation;
    return { identity: `renderer-${identity}`, generation };
  } catch {
    return null;
  }
}

// ── per-boot teardown registry (single active-game realm) ──────────────────────
// The standalone editor boots once and tears down only by page navigation, so it
// never needs these. Studio may rebind the active game at runtime; because the
// physics backend + pack roots are bound once at createApp, a switch must
// DESTROY this realm (GPU device + world + session + window listeners) and
// re-boot fresh. bootViewport pushes each per-boot teardown
// handle here; resetEditRealm() runs them LIFO, disposes the engine, and clears
// the latch so the next mount re-boots. Everything a boot installs GLOBALLY and
// engine-scoped must register here or it leaks/duplicates across a switch.
const teardownFns: Array<() => void> = [];
const bootLease = createBootLease();
let currentResetOptions: ResetEditRealmOptions = {};
let activeRealmTeardown: (() => void) | undefined;
let runtimeGenerationOverride: number | null = null;
function registerRealmTeardown(fn: () => void): void {
  teardownFns.push(fn);
}

export type InfiniteGridPlayPhase = 'edit' | 'starting' | 'play' | 'failed';

export function deriveInfiniteGridVisibility(input: {
  readonly gridVisible: boolean;
  readonly display: 'scene' | 'game';
  readonly playPhase: InfiniteGridPlayPhase;
  /**
   * The current render graph only materializes the shared view bind group when
   * at least one scene renderable has validated. Keep the grid fail-closed
   * while an empty authoring world cannot provide that view group.
   */
  readonly sceneHasRenderableContent?: boolean;
}): boolean {
  return (
    input.gridVisible
    && input.display === 'scene'
    && input.playPhase === 'edit'
    && input.sceneHasRenderableContent !== false
  );
}

function hasRenderableSceneContent(world: World): boolean {
  const query = world.query({ with: [Transform, MeshFilter, MeshRenderer] });
  return query.ok && [...query.value].length > 0;
}

async function loadRuntimeAssetPayload(
  assets: import('@forgeax/engine-assets-runtime').AssetRegistry,
  guid: string,
): Promise<unknown> {
  const live = gateway.lookupAsset(guid);
  if (live !== undefined) return live;
  try {
    const { AssetGuid } = await import('@forgeax/engine-pack/guid');
    const parsed = AssetGuid.parse(guid);
    if (!parsed.ok || parsed.value === undefined) return undefined;
    const result = await assets.loadByGuid(parsed.value);
    return result.ok ? result.value : undefined;
  } catch {
    return undefined;
  }
}

function requirePlayRuntimeBinding(binding: RuntimeAssetBinding | undefined): RuntimeAssetBinding {
  if (
    binding === undefined
    || binding.schemaVersion !== 'runtime-asset-binding-v1'
    || typeof binding.gameId !== 'string'
    || binding.gameId.trim().length === 0
    || typeof binding.scopeId !== 'string'
    || binding.scopeId.trim().length === 0
    || !Number.isSafeInteger(binding.generation)
    || binding.generation < 1
    || (binding.status !== 'ready' && binding.status !== 'degraded')
    || typeof binding.catalogUrl !== 'string'
    || binding.catalogUrl.trim().length === 0
    || typeof binding.importUrlBase !== 'string'
    || binding.importUrlBase.trim().length === 0
    || typeof binding.packageUrlBase !== 'string'
  ) {
    throw new Error('[editor] Play child URL requires a complete runtime asset binding');
  }
  return binding;
}

type ManagedCarrierHealth = {
  readonly getIdentity: () => GameplayIdentity | null;
  readonly dispose: () => void;
};

async function installManagedCarrierHealth(
  canvas: HTMLCanvasElement,
  renderer: Renderer,
  gameId: string | null,
  rendererProvenance: RendererRealmProvenance | null,
): Promise<ManagedCarrierHealth> {
  if (rendererProvenance === null) {
    throw new Error('renderer provenance unavailable: the Edit renderer realm could not mint identity');
  }
  const params = new URLSearchParams(window.location.search);
  const managedRuntimeId = params.get('runtimeId')?.trim() || null;
  const challengeResponse = params.get('ownershipChallenge')?.trim() || null;
  const requestedCarrierKind = params.get('carrierKind');
  const carrierKind = isViewportCarrierKind(requestedCarrierKind) ? requestedCarrierKind : 'local';
  const requestedRuntimeGeneration = Number(params.get('runtimeGeneration') ?? 1);
  const runtimeGeneration = Number.isSafeInteger(requestedRuntimeGeneration) && requestedRuntimeGeneration > 0
    ? requestedRuntimeGeneration : 1;
  const managed = managedRuntimeId !== null && challengeResponse !== null;

  const healthResponse = await fetch('/api/health', { cache: 'no-store' });
  if (!healthResponse.ok) throw new Error(`carrier health unavailable: HTTP ${healthResponse.status}`);
  const health = await healthResponse.json() as { instanceRootAbs?: unknown };
  if (typeof health.instanceRootAbs !== 'string' || health.instanceRootAbs.length === 0) {
    throw new Error('carrier health response did not identify the instance root');
  }
  const instanceRootAbs = health.instanceRootAbs;

  const pageNonce = crypto.randomUUID();
  const runtimeId = managedRuntimeId ?? `visible-${pageNonce}`;
  const carrierId = params.get('carrierId')?.trim() || `${carrierKind}-${pageNonce}`;
  const pageIdentity = `${window.location.origin}${window.location.pathname}`;
  const canvasIdentity = canvas.dataset.forgeaxCarrierCanvas ?? `canvas-${pageNonce}`;
  const rendererIdentity = rendererProvenance.identity;
  const rendererGeneration = rendererProvenance.generation;
  const scope = { projectId: instanceRootAbs, gameId };
  canvas.dataset.forgeaxCarrierCanvas = canvasIdentity;
  let sentinel = 0;
  let renderReadiness: 'pending' | 'ready' | 'unavailable' = renderer.state() === 'alive' ? 'ready' : 'unavailable';
  let failure: { code: string; stage: 'renderer'; retryable: boolean; hint: string; at: string; message?: string } | null = null;
  const getIdentity = (): GameplayIdentity | null => {
    if (renderReadiness !== 'ready') return null;
    return { runtimeId, scope, pageIdentity, canvasIdentity, rendererGeneration };
  };
  const payload = () => ({
    version: VAG_CARRIER_PROTOCOL_VERSION,
    runtimeId,
    runtimeGeneration,
    carrierId,
    carrierKind,
    challengeResponse: challengeResponse ?? '',
    scope,
    pageNonce,
    pageIdentity,
    canvasIdentity,
    rendererGeneration,
    rendererIdentity,
    sentinel,
    liveness: 'alive' as const,
    renderReadiness,
    failure,
  });
  const publish = () => {
    const next = payload();
    (window as unknown as Record<string, unknown>).__forgeax_carrier_health = next;
    lastPublished = next;
    return next;
  };
  let lastPublished: unknown;
  const sendHandshake = () => sendVagMessage(window.parent, VagCarrierHandshakeSchema, publish());
  const sendHeartbeat = () => {
    sentinel += 1;
    sendVagMessage(window.parent, VagCarrierHeartbeatSchema, publish());
  };
  // Local and managed carriers publish the identical producer-owned envelope;
  // managed carriers additionally mirror it over the VAG handshake/heartbeat.
  publish();
  if (managed) {
    sendHandshake();
    if (failure) sendVagMessage(window.parent, VagCarrierFailureSchema, publish() as never);
  }
  const heartbeat = managed ? window.setInterval(sendHeartbeat, 100) : undefined;
  const unsubscribeRenderer = renderer.subscribe((event) => {
    if (event.kind === 'state-changed' && event.current === 'alive') {
      failure = null;
      renderReadiness = 'ready';
      publish();
      if (managed) sendHeartbeat();
      return;
    }
    if (event.kind === 'state-changed') {
      renderReadiness = 'unavailable';
      failure = {
        code: `renderer-${event.current}`,
        stage: 'renderer',
        retryable: event.current !== 'disposed',
        hint: 'Inspect the renderer event, then recover or recreate the carrier.',
        at: new Date().toISOString(),
      };
      publish();
      if (managed) sendVagMessage(window.parent, VagCarrierFailureSchema, publish() as never);
      return;
    }
    if (event.kind !== 'error') return;
    renderReadiness = 'unavailable';
    failure = {
      code: event.error.code,
      stage: 'renderer',
      retryable: true,
      hint: event.error.hint,
      at: new Date().toISOString(),
      message: event.error.message,
    };
    publish();
    if (managed) sendVagMessage(window.parent, VagCarrierFailureSchema, publish() as never);
  });
  return {
    getIdentity,
    dispose: () => {
      unsubscribeRenderer();
      if (heartbeat !== undefined) window.clearInterval(heartbeat);
      if (canvas.dataset.forgeaxCarrierCanvas === canvasIdentity) delete canvas.dataset.forgeaxCarrierCanvas;
      const host = window as unknown as Record<string, unknown>;
      if (host.__forgeax_carrier_health === lastPublished) delete host.__forgeax_carrier_health;
    },
  };
}

export interface ResetEditRealmOptions {
  readonly flushPendingSave?: boolean;
  readonly nextRuntimeGeneration?: number;
}

export interface GenerationFenceToken {
  readonly generation: number;
}

export function createStaleGenerationError(actual: number, expected: number): {
  readonly code: 'version-control-stale-generation';
  readonly hint: string;
  readonly expected: number;
  readonly actual: number;
} {
  return {
    code: 'version-control-stale-generation',
    hint: 'The Runtime reference belongs to an older generation.',
    expected,
    actual,
  };
}

export function createGenerationFence(initialGeneration: number) {
  if (!Number.isSafeInteger(initialGeneration) || initialGeneration < 1) throw new Error('generation must be positive');
  let generation = initialGeneration;
  return {
    capture: (): GenerationFenceToken => ({ generation }),
    current: (): number => generation,
    advance: (): number => {
      generation += 1;
      return generation;
    },
    assert: (token: GenerationFenceToken):
      | { readonly ok: true; readonly generation: number }
      | { readonly ok: false; readonly error: ReturnType<typeof createStaleGenerationError> } => {
      if (token.generation === generation) return { ok: true, generation };
      return { ok: false, error: createStaleGenerationError(token.generation, generation) };
    },
  };
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
  bootLease.invalidate();
  const previousResetOptions = currentResetOptions;
  currentResetOptions = options;
  if (options.nextRuntimeGeneration !== undefined
    && Number.isSafeInteger(options.nextRuntimeGeneration)
    && options.nextRuntimeGeneration > 0) {
    runtimeGenerationOverride = options.nextRuntimeGeneration;
  }
  const leadTeardown = activeRealmTeardown;
  activeRealmTeardown = undefined;
  // Run per-boot teardown LIFO (reverse install order) so late-installed handles
  // that depend on earlier ones unwind first. Swallow individual failures so one
  // bad teardown can't strand the rest (a half-torn realm wedges the next boot).
  try {
    try { leadTeardown?.(); } catch (e) { console.warn('[editor] active realm teardown failed:', e); }
    for (let i = teardownFns.length - 1; i >= 0; i--) {
      try { teardownFns[i]!(); } catch (e) { console.warn('[editor] resetEditRealm teardown step failed:', e); }
    }
  } finally {
    currentResetOptions = previousResetOptions;
  }
  teardownFns.length = 0;
  // Drop the global handle so nothing keeps the dead app/world/renderer alive.
  try { delete (window as unknown as Record<string, unknown>).__forgeax_editor; } catch { /* non-config */ }
  try { delete (window as unknown as Record<string, unknown>).__forgeax_carrier_health; } catch { /* non-config */ }
  if (window.parent !== window) {
    try { delete (window.parent as unknown as Record<string, unknown>).__forgeax_editor; } catch { /* cross-origin */ }
    try { delete (window.parent as unknown as Record<string, unknown>).__forgeax_carrier_health; } catch { /* cross-origin */ }
  }
  bootStarted = false;
}

// The document can be reloaded while the asynchronous viewport boot is still
// in flight (Vite dependency optimization is the common trigger). Install the
// page lifecycle boundary at module load, not at the end of the boot tail, so a
// browser-destroyed GPU device cannot report into a half-torn editor App.
const onRuntimePageHide = createPagehideTeardown(() => resetEditRealm());
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', onRuntimePageHide);
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      resetEditRealm();
      window.removeEventListener('pagehide', onRuntimePageHide);
    });
  }
}

// ── boot breadcrumb + dead-boot watchdog (was main.tsx :56-108) ───────────────
function emitBoot(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  panelBridge.emit('editorHealth', { level, code: 'boot', message, ts: Date.now() });
}

interface BootFns {
  playSimulation: (policy?: PlayDirtyPolicy, origin?: CommandOrigin) => PlayDispatchResult;
  stopSimulation: () => void;
}

/**
 * The active game the host wants this viewport to boot. The host is the single
 * source of truth for "which game" (editor standalone: CLI `--game`; studio: the
 * server active-game resource) and passes it as props — NOT via `?scene=`/`?gameRoot=` URL
 * params. The single-realm collapse removed the editor iframe that URL params used
 * to address, so hosts inject the game directly. Omitted / { slug: null } = no
 * game (opens on an empty scene).
 */
export interface ViewportComponentProps {
  /** Scene/game pointer. null or 'default' = no on-disk game (empty scene). */
  readonly gameSlug?: string | null;
  /** Host game->disk layout root. Required when gameSlug names a real game. */
  readonly gameRoot?: string;
  /** Host-authoritative scoped asset binding for this game. */
  readonly runtimeBinding?: RuntimeAssetBinding;
  /** Host-selected initial SceneAsset GUID. Omitted = forge.json defaultScene. */
  readonly selectedSceneGuid?: string;
  /** Host carrier transition seam; Runtime owns the barrier/handoff protocol. */
  readonly versionControlTransition?: VersionControlRuntimeTransition;
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
  runtimeBinding,
  selectedSceneGuid,
  versionControlTransition,
}: ViewportComponentProps = {}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Deferred ▶/■ actions are reached through the hosting PanelShell toolbar and
  // the Runtime transport. This renderer surface deliberately owns no product
  // controls, whether docked or detached.
  const actionsRef = useRef<BootFns>({ playSimulation: () => ({ ok: true }), stopSimulation: () => {} });
  useEffect(() => {
    setPreviewRuntimeBinding(runtimeBinding);
    return () => clearPreviewRuntimeBinding(runtimeBinding);
  }, [runtimeBinding]);
  useEffect(() => {
    if (bootStarted) return;
    bootStarted = true;
    const bootId = bootLease.begin();
    const isCurrentBoot = () => bootLease.isCurrent(bootId);
    const container = containerRef.current;
    if (!container) return;

    void bootViewport(container, actionsRef, {
      slug: gameSlug,
      gameRoot,
      runtimeBinding,
      selectedSceneGuid,
      versionControlTransition,
    }, isCurrentBoot).catch((error: unknown) => {
      if (!isCurrentBoot()) return;
      // A rejected boot must converge to a visible terminal state. Without a
      // catch here, the overlay remains on "Starting engine…" forever while
      // the browser only reports an unhandled rejection.
      console.error('[editor] viewport boot failed:', error);
      resetEditRealm();
      emitBoot(
        `boot ✗ failed: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
      paintDiagnosticMessage(container, error);
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
    />
  );
}

// ── boot sequence (was main.tsx bootEditor viewport half) ─────────────────────
async function bootViewport(
  container: HTMLDivElement,
  actionsRef: React.MutableRefObject<BootFns>,
  gameSession: HostGameSession,
  isCurrentBoot: () => boolean,
): Promise<Viewport | null> {
  if (!isCurrentBoot()) return null;
  const registerTeardown = (fn: () => void): void => {
    if (isCurrentBoot()) {
      registerRealmTeardown(fn);
      return;
    }
    try { fn(); } catch (error) {
      console.warn('[editor] stale viewport boot cleanup failed:', error);
    }
  };
  const BASE = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
  const requestedRuntimeIdentity = readViewportRuntimeIdentity(window.location.search);
  const runtimeIdentity = runtimeGenerationOverride === null
    ? requestedRuntimeIdentity
    : { ...requestedRuntimeIdentity, runtimeGeneration: runtimeGenerationOverride };
  runtimeGenerationOverride = null;
  let referenceCreationTransport: TransportService | null = null;

  const versionControlHost = createVersionControlHostPort({
    gameRoot: gameSession.gameRoot ?? '',
    generation: runtimeIdentity.runtimeGeneration,
  });
  let versionControlBinding!: VersionControlRuntimeBinding;
  const versionControlTransition = gameSession.versionControlTransition ?? ((): VersionControlRuntimeTransition | undefined => {
    const barrier = getGatewayWriteBarrier(gateway);
    if (barrier === undefined || gameSession.gameRoot === undefined) return undefined;
    const handoff = createSwitchHandoff({
      generation: runtimeIdentity.runtimeGeneration,
      projectionLease: `projection:${runtimeIdentity.runtimeId}:${runtimeIdentity.runtimeGeneration}`,
      actionLease: `action:${runtimeIdentity.runtimeId}:${runtimeIdentity.runtimeGeneration}`,
    });
    let transitionRepositoryIdentity: string | undefined;
    return {
      barrier,
      handoff,
      readPreflight: () => {
        const state = barrier.snapshot();
        const snapshot = versionControlBinding.provider.snapshot();
        const recovery = versionControlBinding.recovery.snapshot();
        transitionRepositoryIdentity = snapshot.status === 'ready' ? snapshot.repositoryIdentity : undefined;
        const dirtyRecords = snapshot.status === 'ready' ? snapshot.dirtyRecords : [];
        return {
          playActive: gateway.playPhase === 'starting' || gateway.playPhase === 'play',
          stagingActive: state.phase === 'staging',
          dirty: dirtyRecords.length > 0,
          untracked: dirtyRecords.some((record) => record.kind === 'untracked'),
          targetDrifted: false,
          // The applier owns one session lease while this callback runs; only
          // additional writers indicate a competing Gateway operation.
          writeOperationActive: state.activeWriters > 1,
          rootMatches: versionControlHost.gameRoot === gameSession.gameRoot,
          repositoryRecoveryRequired: snapshot.status === 'recovery-required' || recovery.state !== 'ready',
          generation: runtimeIdentity.runtimeGeneration,
        };
      },
      teardown: () => resetEditRealm({ nextRuntimeGeneration: runtimeIdentity.runtimeGeneration + 1 }),
      bootSuccessor: async (generation: number) => {
        bootStarted = true;
        const bootId = bootLease.begin();
        const successor = await bootViewport(
          container,
          actionsRef,
          { ...gameSession, versionControlTransition: undefined },
          () => bootLease.isCurrent(bootId),
        );
        if (successor === null) throw new Error('successor Runtime did not boot');
        return {
          generation,
          projectionLease: `projection:${runtimeIdentity.runtimeId}:${generation}`,
          actionLease: `action:${runtimeIdentity.runtimeId}:${generation}`,
          repositoryIdentity: transitionRepositoryIdentity ?? gameSession.gameRoot ?? '',
          targetCommit: handoff.snapshot().targetCommit ?? '',
        };
      },
      terminal: () => {},
      committed: (result) => {
        if (result === null || typeof result !== 'object' || (result as { readonly status?: unknown }).status !== 'succeeded' || window.parent === window) return;
        const generation = result !== null && typeof result === 'object'
          && typeof (result as { readonly generation?: unknown }).generation === 'number'
          ? (result as { readonly generation: number }).generation
          : runtimeIdentity.runtimeGeneration + 1;
        // Publish after the terminal callback yields so the shell can bind the
        // successor without racing the current Runtime's completion bookkeeping.
        window.setTimeout(() => {
          try {
            window.parent.dispatchEvent(new CustomEvent('forgeax-generation-ready', {
              detail: { runtimeGeneration: generation },
            }));
          } catch {
            // A detached carrier can finish its successor boot without a live
            // parent; the handoff result remains authoritative.
          }
        }, 0);
      },
      disposeOld: () => {},
      freeze: (reason: string) => barrier.freeze(reason),
    } satisfies VersionControlRuntimeTransition;
  })();
  versionControlBinding = createVersionControlRuntimeBinding({
    gateway,
    generation: runtimeIdentity.runtimeGeneration,
    host: versionControlHost,
    transition: versionControlTransition,
  });
  registerTeardown(versionControlBinding.dispose);

  // AssetIOFacade is shared by editor-core's gateway/import operations. Bind it
  // to this exact generation before session configuration can run an integrity
  // repair/cook, and clear it before the realm is torn down so the next game
  // cannot reuse the previous game's import endpoint.
  assetIO.setRuntimeBinding(gameSession.runtimeBinding);
  registerTeardown(() => assetIO.setRuntimeBinding(undefined));

  // Configure the session (scene id + game->disk path resolver + scene manifest)
  // from the host-supplied game BEFORE anything reads a game file. In the single-
  // realm host this is the ONLY place it runs; shared with edit-runtime's thin
  // main.tsx so the two hosts can't drift. Without this the Assets panel's
  // ContentBrowser throws PATH_RESOLVER_NOT_SET.
  await configureHostSession(gameSession);
  const referenceCreationScope = Object.freeze({
    gameRoot: gameSession.gameRoot ?? gameSession.slug ?? 'default',
    sceneId: getSceneFile() ?? getSceneId(),
  });
  if (!isCurrentBoot()) return null;

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
  const dpr = resolveEditViewportPixelRatio(window.devicePixelRatio);
  canvas.width = (container.clientWidth || window.innerWidth) * dpr;
  canvas.height = (container.clientHeight || window.innerHeight) * dpr;
  container.insertBefore(canvas, container.firstChild);

  installConsoleBridge();
  installNetworkBridge();

  // physics gate (host-boot.resolveEditPhysics — must precede createApp).
  const editPhysics = await resolveEditPhysics();
  if (!isCurrentBoot()) return null;

  // ── M4 (w18/w19/w21): world-manager — the super coordination layer ──────────
  // Created BEFORE createApp so its composite drawSource can be handed to the
  // engine frame-loop at boot. It owns the editorWorld (editor camera + residual
  // editor-world chrome) as a separate engine World from the sceneWorld
  // (= createApp's `world`, doc.world).
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

  let cameraEntity!: EntityHandle;
  // The feature is registered before createViewport/createApp finishes. The
  // late-bound reference keeps the first frame valid while allowing the
  // renderer's normal feature extraction to pick up Gizmo chrome afterward.
  let viewport: Viewport | undefined;
  let vfxRenderer: Renderer | undefined;
  const vfxBridge = createEditVfxRuntimeBridge({
    camera: createParticleCameraSource({
      world: () => worldManager.editorWorld,
      cameraEntity: () => cameraEntity,
    }),
    renderFeatureDiagnostics: () => vfxRenderer?.inspect().featureDiagnostics ?? [],
  });
  const infiniteGridFeature = createInfiniteGridFeature({
    isVisible: () => {
      const sceneWorld = gateway.doc.world as unknown as World | undefined;
      return deriveInfiniteGridVisibility({
        gridVisible: getViewportPreferences().gridVisible,
        display: getViewportQuadrant().display,
        playPhase: gateway.playPhase,
        sceneHasRenderableContent: sceneWorld === undefined
          ? true
          : hasRenderableSceneContent(sceneWorld),
      });
    },
  });
  const gizmoRenderFeature = createGizmoRenderFeature({
    getVertexData: () => viewport?.getOverlayVertexData() ?? new Float32Array(0),
    isVisible: () => getViewportQuadrant().run === 'edit' && isAuxVisible(),
  });
  const renderFeatures = [
    infiniteGridFeature,
    gizmoRenderFeature,
  ] as readonly RenderFeature<unknown>[];
  // Diagnostics are producer-driven through the public Renderer event stream.
  // The optional profiler therefore disappears entirely unless a CPU
  // capture/User Timing session was explicitly enabled before boot.
  const profiler = createFramePhaseProfiler({ enableCpuCapture: true });
  // Keep the AI/panel diagnostics surface on the same engine-owned feature
  // facts used by the renderer; the Gateway owns only the bounded projection.
  registerTeardown(gateway.registerRuntimeDiagnosticsProvider(vfxBridge.diagnosticsProvider));
  const animationDiagnostics = createAnimationDiagnosticsProvider({
    getActiveWorld: () => gateway.activeWorld,
  });
  registerTeardown(gateway.registerRuntimeDiagnosticsProvider(animationDiagnostics.provider));
  registerTeardown(animationDiagnostics.dispose);

  // ── createApp with GPU-failure auto-fallback ────────────────────────────
  // When no WebGPU adapter is available (headless browser, GPU-less CI), the
  // first createApp(canvas) call fails with a GPU-related error. Before giving
  // up, retry with @forgeax/engine-rhi-null — a no-op renderer that satisfies
  // the adapter/device/shader contract without a real GPU. Gateway ops
  // (dispatch/query/listOps/describeComponent) only need the ECS world; the
  // viewport won't render but the eval channel still mounts. Dynamic import
  // so the null RHI is never bundled into production builds.
  if (gameSession.slug && gameSession.slug !== 'default' && gameSession.runtimeBinding === undefined) {
    const error = new Error('[editor] active game has no runtime asset binding');
    console.error(error);
    paintDiagnosticMessage(container, error);
    return null;
  }
  const devImportTransport = gameSession.runtimeBinding === undefined
    ? undefined
    : createDevImportTransport(gameSession.runtimeBinding);
  // A late-bound Studio game owns its shader packages in the Play runtime. The
  // local edit manifest is intentionally builtin-only, so use the scoped Play
  // manifest for the same runtime binding that supplies its asset catalog.
  const gameDirAbs = typeof __FORGEAX_GAME_DIR_ABS__ === 'string' ? __FORGEAX_GAME_DIR_ABS__ : null;
  const shaderManifestUrl = await prepareViewportShaderManifestUrl(
    BASE,
    gameSession.runtimeBinding !== undefined,
    gameDirAbs,
  );
  if (shaderManifestUrl.startsWith('blob:')) {
    registerTeardown(() => {
      URL.revokeObjectURL(shaderManifestUrl);
    });
  }
  const createAppResult = await createApp(canvas, {
    input: canvasInput.editor,
    features: renderFeatures,
    // Engine keeps optional capabilities behind plugins. The editor must
    // admit Skin because authored scene mounts can contain imported rigs;
    // otherwise loading a perfectly valid scene fails closed at instantiate.
    plugins: [editorComponentVocabularyPlugin(), skinningPlugin()],
    pointerLockAllowed: () => false,
    drawSource: worldManager.createDrawSource(),
    profiler,
    maxCanvasPixelRatio: EDIT_VIEWPORT_MAX_PIXEL_RATIO,
  }, {
    shaderManifestUrl,
    ...(devImportTransport === undefined ? {} : { importTransport: devImportTransport }),
  });
  if (!isCurrentBoot()) {
    if (createAppResult.ok) {
      try { createAppResult.value.stop(); } catch { /* stale app is already unwinding */ }
    }
    return null;
  }

  let app = createAppResult;
  if (!app.ok) {
    const errCode = (app.error as unknown as Record<string, unknown>)?.code;
    const isGpuError = errCode === 'rhi-not-available'
      || errCode === 'engine-environment-error'
      || errCode === 'webgpu-runtime-error';
    if (isGpuError) {
      console.warn('[editor] createApp failed (no GPU), retrying with null RHI:', app.error);
      const rhiNull = await import('@forgeax/engine-rhi-null');
      app = await createApp(canvas, {
        input: canvasInput.editor,
        features: renderFeatures,
        plugins: [editorComponentVocabularyPlugin(), skinningPlugin()],
        pointerLockAllowed: () => false,
        drawSource: worldManager.createDrawSource(),
        profiler,
        maxCanvasPixelRatio: EDIT_VIEWPORT_MAX_PIXEL_RATIO,
        rhi: rhiNull.rhi as import('@forgeax/engine-rhi').RhiInstance,
      }, {
        shaderManifestUrl,
        ...(devImportTransport === undefined ? {} : { importTransport: devImportTransport }),
      });
    }
  }
  if (!isCurrentBoot()) {
    if (app.ok) {
      try { app.value.stop(); } catch { /* stale app is already unwinding */ }
    }
    return null;
  }

  if (!app.ok) {
    const errorDetail = (app.error as unknown as { readonly detail?: unknown }).detail;
    console.error('[editor] createApp failed:', app.error, errorDetail);
    forwardFeedbackHealth({
      source: 'edit',
      code: normalizeRendererFailureCode(app.error),
      message: errorMessage(app.error, 'The editor renderer could not start.'),
    });
    paintDiagnosticMessage(container, app.error);
    return null;
  }
  const editorApp = app.value;
  const { world, renderer } = editorApp;
  const assets = editorApp.assets;
  if (assets === undefined) {
    const error = new Error('[editor] createApp did not provide its runtime AssetRegistry');
    console.error(error);
    paintDiagnosticMessage(container, error);
    return null;
  }
  // Mint once, immediately after createApp successfully creates this Edit
  // renderer realm. The value is passed through the health publisher rather
  // than inferred from the public Engine Renderer object.
  const rendererProvenance = mintRendererRealmProvenance();
  if (rendererProvenance !== null) {
    const canvasIdentity = canvas.dataset.forgeaxCarrierCanvas ?? `canvas-${rendererProvenance.identity}`;
    canvas.dataset.forgeaxCarrierCanvas = canvasIdentity;
    const ownerIdentity: RendererOwnerAdmissionIdentity = {
      carrierId: runtimeIdentity.carrierId,
      pageIdentity: `${window.location.origin}${window.location.pathname}`,
      browserRealmId: rendererProvenance.identity,
      runtimeId: runtimeIdentity.runtimeId,
      canvasIdentity,
      rendererGeneration: String(rendererProvenance.generation),
    };
    const rendererOwnerAdapter = renderer as unknown as {
      applyShadowSubmitMode?: (mode: RendererOwnerAdmissionRequest['shadowSubmitMode'], rendererGeneration: string) => unknown;
      restoreShadowSubmitMode?: (rendererGeneration: string) => unknown;
    };
    const ownerLease = createRendererOwnerAdmissionLease({
      identity: ownerIdentity,
      readRendererGeneration: () => ownerIdentity.rendererGeneration,
      apply(input) {
        const applyShadowSubmitMode = rendererOwnerAdapter.applyShadowSubmitMode;
        if (typeof applyShadowSubmitMode !== 'function') {
          throw new Error('renderer-owner-admission-adapter-unavailable');
        }
        const result = applyShadowSubmitMode(input.shadowSubmitMode, input.identity.rendererGeneration);
        if (result !== undefined && typeof result === 'object' && result !== null && 'ok' in result && result.ok === false) {
          throw (result as { readonly error?: unknown }).error ?? new Error('renderer-owner-admission-apply-failed');
        }
      },
      restore() {
        const restoreShadowSubmitMode = rendererOwnerAdapter.restoreShadowSubmitMode;
        if (typeof restoreShadowSubmitMode !== 'function') return;
        const result = restoreShadowSubmitMode(ownerIdentity.rendererGeneration);
        if (result !== undefined && typeof result === 'object' && result !== null && 'ok' in result && result.ok === false) {
          throw (result as { readonly error?: unknown }).error ?? new Error('renderer-owner-admission-restore-failed');
        }
      },
    });
    registerTeardown(installRendererOwnerAdmissionLease(ownerLease));
  }
  let session: HostSession | undefined;
  const unregisterEditorErrorListener = editorApp.onError((error) => {
    // App.onError is the engine's structured runtime/render failure channel.
    // Surface it as console.error so the browser smoke cannot pass over a
    // renderer failure that only reached the in-process error overlay.
    console.error('[editor] runtime error:', error);
    forwardFeedbackHealth({
      source: 'edit',
      code: normalizeRendererFailureCode(error),
      message: errorMessage(error, 'The editor renderer terminated unexpectedly.'),
    });
  });
  const closeEditorRealm = createEditorAppTeardown({
    unregisterErrorListener: unregisterEditorErrorListener,
    disposeSession: () => session?.dispose({ flushPendingSave: currentResetOptions.flushPendingSave }),
    stopApp: () => {
      try { editorApp.stop(); } catch (e) { console.warn('[editor] editorApp.stop() failed:', e); }
    },
    removeCanvas: () => {
      try { canvas.remove(); } catch { /* already detached */ }
    },
  });
  activeRealmTeardown = closeEditorRealm;
  registerTeardown(closeEditorRealm);
  const infiniteGridDiagnostics = createInfiniteGridDiagnosticsProvider({
    readFeatureDiagnostics: () => renderer.inspect().featureDiagnostics,
  });
  registerTeardown(gateway.registerRuntimeDiagnosticsProvider(infiniteGridDiagnostics));
  registerTeardown(renderer.subscribe((event) => {
    if (event.kind === 'state-changed' || event.kind === 'error') infiniteGridDiagnostics.notify();
  }));
  let vfxRenderFeatureEnabled = false;
  if (supportsVfxRenderFeature(renderer.inspect().capabilities)) {
    try {
      await editorApp.pluginContext.plugin(renderFeaturePlugin(vfxBridge.host.feature));
      vfxRenderFeatureEnabled = true;
    } catch (error) {
      console.warn('[editor] VFX render feature installation failed:', error);
    }
  } else {
    console.warn('[editor] VFX render feature disabled: active RHI lacks compute or indirect-drawing capability');
  }
  if (!isCurrentBoot()) {
    teardownIfStale(isCurrentBoot, closeEditorRealm);
    return null;
  }
  const executionDiagnostics = createEngineExecutionDiagnostics(editorApp.execution);
  registerTeardown(gateway.registerRuntimeDiagnosticsProvider(executionDiagnostics.provider));
  vfxRenderer = renderer;
  registerTeardown(renderer.subscribe((event) => {
    if (event.kind === 'state-changed' || event.kind === 'error' || event.kind === 'frame-submitted') {
      vfxBridge.notifyDiagnosticsChanged();
    }
  }));
  if (gameSession.runtimeBinding !== undefined) {
    assets.configureRuntimeBinding(gameSession.runtimeBinding);
  }
  // Editor-owned host kinds must be registered before the first Catalog
  // enumeration. Otherwise existing Input Map / Material Instance rows are
  // projected as ordinary source files and can only be reopened as JSON.
  registerMaterialInstanceLoader(assets);
  registerInputMapLoader(assets);
  const materialPublicationBinding = createMaterialPublicationBinding(
    {
      getMaterialReadiness: (guid) => assets.getMaterialReadiness(guid),
      materialReadiness: assets.materialReadiness,
    },
    { url: window.location.href, host: 'editor' },
  );
  registerTeardown(
    gateway.registerRuntimeDiagnosticsProvider(materialPublicationBinding.diagnosticsProvider),
  );

  // solo P7 round-31: selected collider chrome reuses the engine's existing
  // immediate-mode DebugDraw overlay. It reads the active scene-world SSOT each
  // frame and emits no authored state; debug-draw's graph pass owns its flush.
  installColliderDebugOverlay({
    world,
    debugDraw: editorApp.debugDraw,
    getSelection,
    getEntityComponents: (entity) => entComponents(gateway.doc.world, entity),
    isAuxVisible,
    isEditMode: () => getViewportQuadrant().run === 'edit',
  });

  // A real game gets exactly one host-authoritative binding. Empty scenes keep
  // the registry unconfigured; they must not invent a global catalog URL.
  if (gameSession.runtimeBinding !== undefined) {
    const binding = gameSession.runtimeBinding;
    const catalogClient = createCatalogClient(
      async () => {
        const response = await fetch(binding.catalogUrl, { cache: 'no-store' });
        if (!response.ok) throw new Error(`scoped catalog request failed: ${response.status}`);
        const body = await response.json() as unknown;
        return Array.isArray(body)
          ? body as readonly import('@forgeax/engine-types').CatalogEntry[]
          : (body as { entries?: readonly import('@forgeax/engine-types').CatalogEntry[] }).entries ?? [];
      },
      import.meta.hot as unknown as import('@forgeax/engine-vite-plugin-pack/catalog-client').CatalogHotChannel,
    );
    assets.setCatalogSource(createCatalogSource({
      url: binding.catalogUrl,
      expectedScope: binding,
      subscribe: catalogClient.subscribe,
    }));
    const catalogResult = await assets.enumerateCatalog();
    if (!catalogResult.ok) {
      console.warn('[editor] scoped catalog unavailable:', catalogResult.error);
    }
    if (!isCurrentBoot()) {
      teardownIfStale(isCurrentBoot, closeEditorRealm);
      return null;
    }
  }

  // VFX preparation can resolve authored program and mesh assets on the first
  // frame after attachment. Bind only after the scoped catalog has completed
  // its initial enumeration, so the isolated viewport runtime never observes a
  // partially populated AssetRegistry while resolving the first effect frame.
  const vfxAttached = await vfxBridge.attachWorld(world, assets);
  if (!isCurrentBoot()) {
    if (vfxAttached.ok) void vfxBridge.detachWorld(world);
    teardownIfStale(isCurrentBoot, closeEditorRealm);
    return null;
  }
  if (!vfxAttached.ok) {
    console.error('[editor] Edit VFX host attach failed:', vfxAttached.error);
    paintDiagnosticMessage(container, vfxAttached.error);
    return null;
  }
  registerTeardown(() => {
    void vfxBridge.detachWorld(world).then((detached) => {
      if (!detached.ok) console.warn('[editor] Edit VFX host detach failed:', detached.error);
    });
  });

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
  gateway.doc.registry = assets;
  registerTeardown(installCatalogReconcileProvider(assets));
  registerTeardown(installSourcePublicationObserver());
  const sourceTransport = createSourceAuthoringTransport();
  registerTeardown(installSourceAuthoringOps(createSourceAuthoringRuntime({
    preflightSource: sourceTransport.preflightSource,
    structuredOperations: sourceTransport.operations,
    executeStructured: sourceTransport.execute,
  })));
  // Post-write catalog-sync seam (editor-core pack-ops): createMaterial's pack
  // write resolves BEFORE the vite-plugin-pack watcher rebuilds the served
  // pack-index (~150 ms debounce), so an immediate broadcastAssetsChanged()
  // would race the rebuild and leave the fresh GUID invisible — and
  // updateMaterialParams' synchronous _preFillMaterialOp reads
  // registry.assetCatalog, which only loadByGuid populates. Await the row,
  // then catalog the envelope, THEN let the applier broadcast.
  registerPostAssetWriteCatalogSync(async (guid: string) => {
    const reg = gateway.doc.registry;
    if (!reg) return;
    // Canonical three-phase barrier (row → body → load) — editor-core owns the
    // implementation so the integration test drives the identical code path.
    await createAuthoredAssetCatalogBarrier(reg)(guid);
  });
  registerTeardown(() => registerPostAssetWriteCatalogSync(null));
  // Registry binding is a document-state change, even though no authored world
  // entity changed. Notify panel subscribers so a Content Browser mounted before
  // engine boot can acquire the live registry instead of retaining an empty model.
  notifyDocChanged();

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
    const d = resolveEditViewportPixelRatio(window.devicePixelRatio);
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
  cameraEntity = worldManager.editorFacade.spawn(
    { component: Name, data: { value: 'Editor Camera' } },
    { component: Transform, data: { pos: [0, 1.5, 9] } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 3, aspect }), tonemap: TONEMAP_REINHARD_EXTENDED, clearColor: [0.42, 0.55, 0.78, 1] } },
  ).unwrap();
  setEditorCameraEntity(cameraEntity as unknown as number);
  // Hierarchy/Inspector chrome: Camera-only projection of editorWorld. Panels
  // read this seam instead of minting a scene HandlePair for the orbit camera
  // (pack-play litmus — editor camera must not enter the scene pack).
  registerTeardown(registerEditorWorldProjectionProvider(() => {
    const world = worldManager.editorWorld;
    const cameraId = getEditorCameraEntity();
    if (cameraId === undefined) return { cameraId: null, rows: [] };
    const handle = cameraId as EntityHandle;
    const directCam = world.get(handle, Camera);
    const cam = directCam.ok ? directCam : entComponent(world, handle, 'Camera');
    const directTr = world.get(handle, Transform);
    const tr = directTr.ok ? directTr : entComponent(world, handle, 'Transform');
    const name = entName(world, handle);
    return {
      cameraId: handle,
      rows: [{
        id: handle,
        name: name.startsWith('#') ? 'Editor Camera' : name,
        typeId: 'Camera',
        camera: cam.ok ? (cam.value as Record<string, unknown>) : {},
        transform: tr.ok ? (tr.value as Record<string, unknown>) : null,
      }],
    };
  }));

  // viewport interaction: orbit/pan/zoom, click-to-select, drag-to-move (was :591).
  // M4 (w19/w20): the viewport receives TWO facades — `editorEngine`
  // (worldManager.editorFacade, for camera writes onto editorWorld) and
  // `engine` (gateway facade, for sceneWorld reads via the drag/pick path). The
  // camera entity handle belongs to the editorWorld.
  const createdViewport = createViewport({
    canvas,
    engine: gateway.engineFacade(),
    editorEngine: worldManager.editorFacade,
    assets: assets as never,
    camera: cameraEntity,
    getInputTarget,
    debugDraw: editorApp.debugDraw,
  });
  viewport = createdViewport;
  // Wire viewport.refresh() into the container ResizeObserver created above so
  // the editor camera projection + gizmo track the new aspect ratio on every
  // container resize (dock-panel drags + window resizes).
  onContainerResize = () => createdViewport.refresh();
  registerTeardown(() => { try { createdViewport.dispose(); } catch { /* already disposed */ } });

  // M5 t32 (requirements AC-11): mount the operation-scope eval channel in every
  // Editor runtime. Its normal scope is {gateway, query, _import}; this semantic
  // capability is not a dev-only feature. Raw world/renderer/assets access is a
  // separate privileged scope and is injected only by a development host.
  //
  // The bridge's eval-queue drain is bound to the editor world's Update schedule, which
  // stops ticking when ▶ Play pauses the edit App — so a CLI eval submitted during
  // play would queue forever. We hoist the drain here and hand it to the host
  // session so the run-lifecycle re-registers it on the PLAY App while playing
  // (follow-the-live-app). Undefined unless the bridge block below assigns it.
  let bridgeDrainForPlay: (() => void) | undefined;
  // Standalone @fs loading does not reliably inject import.meta.env.DEV, but it
  // explicitly enables VITE_FORGEAX_BRIDGE. Either signal may grant raw scope;
  // production hosts provide neither and still retain normal Gateway scripts.
  {
    const rawScopeEnabled = Boolean(import.meta.env.DEV)
      || import.meta.env.VITE_FORGEAX_BRIDGE === '1';
    const channel = createEvalChannel(gateway, rawScopeEnabled
      ? { rawScope: { world, renderer, assets } }
      : undefined);
    (globalThis as Record<string, unknown>).__forgeaxEval = channel;
    // Propagate to parent frame when running inside a same-origin carrier iframe
    // so that Playwright page.evaluate() in the main frame can access it directly.
    if (window.parent !== window) {
      try { (window.parent as unknown as Record<string, unknown>).__forgeaxEval = channel; } catch { /* cross-origin */ }
    }

    // ── live gateway bridge (DEV-only) ────────────────────────────────────
    // Development-only companion to __forgeaxEval: instead of a headless playwright instance
    // page.evaluate-ing the channel (a SEPARATE browser sharing only the disk
    // backend), this dials OUT to the loopback relay (scripts/gateway-bridge-
    // server.mjs) so a CLI can drive THIS already-open window in real time —
    // same in-memory world, changes visible instantly, no CDP debug port, no
    // save-to-disk+refresh round-trip. The page can only dial out, so the relay
    // is the shared meeting point. This legacy driver is DEV-only + loopback;
    // the operation-scope channel above is not.
    // Opt-in: CI and ordinary `bun run dev` do not start the loopback relay, so
    // they must never emit browser-level ECONNREFUSED noise. dev-standalone turns
    // this on explicitly alongside launching the relay.
    const bridgeEnabled = import.meta.env.VITE_FORGEAX_BRIDGE === '1';
    if (bridgeEnabled) {
      const bridgePort = import.meta.env.VITE_FORGEAX_BRIDGE_PORT ?? '15296';
      let bridgeWs: WebSocket | null = null;
      let bridgeBackoff = 1000;
      let bridgeStopped = false;

      // Frame-start eval queue (Part 5 — phase stability). A WebSocket `message`
      // fires at an arbitrary point relative to the engine's rAF tick, so running
      // channel.eval → gateway.dispatch inline would land the world write at an
      // unpredictable phase (before/after world.update() this frame). Instead we
      // ENQUEUE each eval and drain the queue from the editor world's Update system, which
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
      world.addSystem(Update, {
        name: 'editor-bridge-eval-drain',
        queries: [],
        fn: drainEvalQueue,
      }).unwrap();
      // Follow-the-live-app: expose the drain so the host session registers it on
      // the PLAY world too (the edit App is paused during play → its Update system
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
          // Enqueue — the drain (the editor-world Update system) runs it at frame start
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
  // authored/play world through the public query surface for its first enabled
  // Camera entity.
  const discoverGameCameraFromWorld = (sourceWorld?: unknown): void => {
    const cameraWorld = (sourceWorld as World | undefined) ?? world;
    const cameras = cameraWorld.query({ read: [Camera] }).unwrap();
    for (const row of cameras) {
      const camera = row.get(Camera);
      // The handle belongs to cameraWorld. Never compare it with the editor
      // camera's numeric handle: identical numbers in different Worlds are
      // unrelated entities (especially across the fresh Play World boundary).
      if (camera.projection === CAMERA_PROJECTION_PERSPECTIVE) {
        const diagnostic = validatePerspectiveFov(camera.fov);
        if (diagnostic !== undefined) {
          console.error('[editor] render camera contract violation:', {
            ...diagnostic,
            entity: row.entity,
          });
        }
      }
      setGameCameraEntity(row.entity as unknown as number);
      return;
    }
  };
  // The render draw-source makes editorWorld the cameraOwner in Edit and
  // play·scene, while play·game renders the transient playWorld as a
  // single-world app. ActiveCamera is a resource on that cameraOwner world;
  // putting the editor handle on the authored scene world leaves the actual
  // camera owner unselected and turns a second authored Camera into a real
  // render-system-multi-camera failure after reload.
  let livePlayWorld: World | undefined;
  let remotePlayFpsActive = false;
  let refreshVisibilityTarget = () => {};
  const applyActiveCamera = (): void => {
    const camEnt = deriveActiveCameraEntity();
    if (camEnt === undefined) return;
    const q = getViewportQuadrant();
    const cameraOwner = q.run === 'play' && q.display === 'game'
      ? livePlayWorld
      : worldManager.editorWorld;
    if (cameraOwner !== undefined) setActiveCamera(cameraOwner, camEnt as unknown as number);
  };
  applyActiveCamera();
  registerTeardown(onViewportQuadrantChange(() => applyActiveCamera()));

  // display bus <-> quadrant bridge (was :892).
  _syncDisplayMode(getViewportQuadrant().display);
  registerTeardown(onViewportQuadrantChange((q) => _syncDisplayMode(q.display)));

  const playFailureNotice = installPlayFailureNotice(container, getLocale);
  registerTeardown(() => playFailureNotice.dispose());

  // ── run the application session tail on this world (host-boot, D8) ──────────
  try {
    session = await initHostSession({
      app: editorApp as never,
      world: world as never,
      // drag-spawn-resolve reads renderer.assets.loadByGuid; createApp keeps assets on editorApp.
      renderer: { ...renderer, assets } as never,
      cameraEntity: cameraEntity as unknown as number,
      viewport,
      viewportContainer: container,
      canvas,
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
      vfxRuntimeHost: vfxBridge.host,
      vfxRenderFeatureEnabled,
      onVfxDiagnosticsChanged: vfxBridge.notifyDiagnosticsChanged,
      ...(gameSession.selectedSceneGuid ? { selectedSceneGuid: gameSession.selectedSceneGuid } : {}),
      ...(gameSession.slug ? {
        playChildUrl: (generation: number) => {
          const binding = requirePlayRuntimeBinding(gameSession.runtimeBinding);
          const params = new URLSearchParams({
            game: gameSession.slug!,
            playGeneration: String(generation),
            runtimeId: runtimeIdentity.runtimeId,
            runtimeScopeId: binding.scopeId,
            runtimeGeneration: String(binding.generation),
            carrierId: `${runtimeIdentity.carrierId}:play`,
            carrierKind: 'iframe',
          });
          if (gameSession.selectedSceneGuid) params.set('sceneGuid', gameSession.selectedSceneGuid);
          return `/preview/?${params.toString()}`;
        },
      } : {}),
      // DEV bridge follow-the-live-app: keep the eval-queue drain ticking on the
      // play App while the edit App is paused during play (undefined in prod).
      ...(bridgeDrainForPlay ? { onPlayFrame: bridgeDrainForPlay } : {}),
      onPlayStarted: (playWorld) => {
        playFailureNotice.clear();
        remotePlayFpsActive = false;
        // The lifecycle has already atomically moved gateway.activeWorld to the
        // play world. Publish the matching UI state only now, never during async
        // assembly, so Hierarchy cannot claim Play while showing the edit tree.
        // Reset the display while the play world is being handed over; the
        // browser-frame reporter remains the single FPS source for both modes.
        setFps(0);
        vfxBridge.notifyDiagnosticsChanged();
        livePlayWorld = playWorld as World;
        canvas.focus({ preventScroll: true });
        canvasInput.grantGame();
        setViewportQuadrant({ run: 'play', display: 'game', control: 'game' });
        refreshVisibilityTarget();
      },
      onRemotePlayStarted: () => {
        playFailureNotice.clear();
        remotePlayFpsActive = true;
        setFps(0);
        vfxBridge.notifyDiagnosticsChanged();
        livePlayWorld = undefined;
        canvasInput.revokeGame();
        setViewportQuadrant({ run: 'play', display: 'game', control: 'game' });
        refreshVisibilityTarget();
      },
      onRemotePlayFps: (fps) => {
        if (!remotePlayFpsActive) return;
        setFps(fps);
      },
      onPlayFailed: (error) => {
        if (error !== undefined) playFailureNotice.show(error);
        remotePlayFpsActive = false;
        // Degrade back to a coherent edit viewport if fresh-world assembly fails.
        vfxBridge.notifyDiagnosticsChanged();
        livePlayWorld = undefined;
        canvasInput.revokeGame();
        setViewportQuadrant({ run: 'edit', display: 'scene', control: 'editor' });
        refreshVisibilityTarget();
        if (error !== undefined && isReportablePlayFailure(error)) {
          forwardFeedbackHealth({
            source: 'play',
            code: normalizePlayFailureCode(error),
            message: errorMessage(error, 'Play could not start.'),
          });
        }
      },
    });
  } catch (err) {
    if (!isCurrentBoot()) {
      teardownIfStale(isCurrentBoot, closeEditorRealm);
      return null;
    }
    console.error('[editor] host session init failed:', err);
    session = {
      playSimulation: () => ({ ok: true }),
      stopSimulation: () => {},
      captureFrame: () => Promise.reject(new Error('RHI debug capture is unavailable; host session failed to initialize')),
      dispose: () => {},
      currentPlayWorld: () => null,
      currentPlayRunId: () => null,
      getPlayPauseHandle: () => null,
      getGameplayGateway: () => gateway as unknown as GameplayGateway,
    };
  }
  if (!isCurrentBoot()) {
    teardownIfStale(isCurrentBoot, closeEditorRealm);
    return null;
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
    playSimulation: (policy = 'last-saved', origin = 'human') => {
      canvasInput.revokeGame();
      // `session.playSimulation()` assembles asynchronously. Its lifecycle
      // callback publishes play·game only after gateway.activeWorld is live.
      return session!.playSimulation(policy, origin);
    },
    stopSimulation: () => {
      revokeGameControl();
      remotePlayFpsActive = false;
      session!.stopSimulation();
      setViewportQuadrant({ run: 'edit', display: 'scene', control: 'editor' });
      refreshVisibilityTarget();
    },
  };

  // ── D-11 (plan-strategy §2): register the REAL play/stop session appliers ────
  // play·stop are session-domain ops whose state machine lives here in edit-runtime
  // (DAG downstream — core must not import it). Registering them into core's
  // unified applier registry (injection direction edit-runtime→core, same shape as the
  // ApiClient seam) is exactly what makes them SESSION-domain ops (D-1: domain =
  // registration site). They route through actionsRef.current so an op-driven
  // play/stop is byte-for-byte the same action the ▶/■ button fires (AC-02 human=AI
  // parity, including the implicit active-op cancel the gateway performs before any
  // session op runs — D-2 interrupt). Registered here, AFTER actionsRef is wired, so
  // a dispatch that arrives at the gateway always finds a live applier (before this
  // point the gateway would legitimately return UNKNOWN_OP — headless form). The
  // returned unregister fns run on teardown to avoid leaking a stale applier across
  // a cross-game realm reset.
  registerTeardown(registerViewportSessionAppliers({
    play: (policy, origin) => actionsRef.current.playSimulation(policy, origin),
    stop: () => actionsRef.current.stopSimulation(),
    setDisplay: (display) => {
      if (display !== 'game') revokeGameControl();
      setViewportQuadrant({ display });
    },
    grantGameControl,
    releaseGameControl: revokeGameControl,
    replayParticleEffect: (entity) => {
      const control = vfxBridge.host.acquireControl(gateway.activeWorld);
      if (!control.ok) return { ok: false, error: control.error };
      const replayed = control.value.replay({ player: entity as EntityHandle });
      return replayed.ok ? { ok: true } : { ok: false, error: replayed.error };
    },
    captureFrame: async (frames) => {
      const capture = await session.captureFrame(frames);
      const candidate = capture !== null && typeof capture === 'object' && !Array.isArray(capture)
        ? capture as Record<string, unknown>
        : undefined;
      if (candidate?.provenance !== undefined) return capture;
      if (getViewportQuadrant().run === 'play') {
        throw { code: 'play-carrier-provenance-unavailable', hint: 'Play capture did not come from the current live carrier' };
      }
      const rendererBackend = renderer.inspect().capabilities.backendKind;
      if (rendererProvenance === null || rendererBackend.trim() === '') {
        throw { code: 'capture-provenance-unavailable', hint: 'the active Edit renderer did not publish complete provenance' };
      }
      const provenance: CaptureProducerProvenance = {
        backend: rendererBackend,
        rendererIdentity: rendererProvenance.identity,
        rendererGeneration: rendererProvenance.generation,
        carrierGeneration: runtimeIdentity.runtimeGeneration,
        carrierId: runtimeIdentity.carrierId,
        carrierKind: runtimeIdentity.carrierKind,
        runtimeId: runtimeIdentity.runtimeId,
        runtimeGeneration: runtimeIdentity.runtimeGeneration,
      };
      return { ...(candidate ?? {}), provenance };
    },
    profiler,
    world,
    activeWorld: () => gateway.activeWorld,
    removeSystem: (targetWorld, name) => {
      const schedule = targetWorld.inspect().schedules.find((entry) =>
        entry.systems.some((system) => system.name === name),
      );
      if (schedule === undefined) {
        return { ok: false, error: `system '${name}' is not installed by a World Plugin` };
      }
      const removed = targetWorld.removeSystem(schedule.schedule, name);
      return removed.ok
        ? { ok: true }
        : { ok: false, error: removed.error };
    },
    gateway,
  }));

  // M4 T4-6 (G-6): setDisplay is a SESSION-domain op — display toggle (scene⇄game)
  // is ledger-visible + AI-equivalent, symmetric to play/stop. The router (and the
  // PanelShell toolbar and keyboard router dispatch it; the real quadrant mutation
  // lives here in edit-runtime (DAG downstream — core stays headless, RK-11).
  // The implementation above owns display and game-control registration too;
  // this comment keeps the historical M4 traceability anchor near the seam.

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
  // addSystem/removeSystem are registered by the same registrar so they share
  // validation, duplicate protection, and realm teardown.

  // game camera discovery now that the scene is loaded (was :695).
  discoverGameCameraFromWorld();
  applyActiveCamera();

  // Expose the viewport quadrant SSOT for out-of-frame scripting (was :503).
  const editorGlobal = {
    app: editorApp, world, renderer, gateway, switchScene: switchSceneFile,
    runtime: {
      runtimeGeneration: runtimeIdentity.runtimeGeneration,
      repositoryIdentity: gameSession.gameRoot ?? null,
      snapshot: { generation: runtimeIdentity.runtimeGeneration },
    },
    referenceCreation: {
      request: (params: unknown) => {
        const id = `reference-creation-${crypto.randomUUID()}`;
        const request = {
          jsonrpc: '2.0',
          version: 'editor-transport/v1',
          id,
          correlationId: id,
          scope: `viewport:${runtimeIdentity.runtimeId}:${runtimeIdentity.runtimeGeneration}`,
          method: 'reference-creation',
          params,
        } as const;
        return referenceCreationTransport === null
          ? forwardViewportRuntimeTransportRequest(request)
          : referenceCreationTransport.handle(request);
      },
    },
    playSimulation: (policy: PlayDirtyPolicy = 'last-saved', origin: CommandOrigin = 'human') => actionsRef.current.playSimulation(policy, origin),
    stopSimulation: () => actionsRef.current.stopSimulation(),
    dispose: () => session!.dispose(),
    currentPlayWorld: () => session!.currentPlayWorld(),
    currentPlayRunId: () => session!.currentPlayRunId(),
    getPlayPauseHandle: () => session!.getPlayPauseHandle(),
    readActiveWorld: () => gateway.activeWorld.inspect(),
    // Read-only diagnostic seam for runtime acceptance tests. Writes still use
    // gateway.dispatch; this helper exposes the same structured stale-handle
    // result used by the Inspector without adding a second mutation path.
    readActiveEntityComponent: (entity: EntityHandle, component: string) => (
      entComponent(gateway.activeWorld, entity, component)
    ),
    getViewportQuadrant, setViewportQuadrant, onViewportQuadrantChange,
    // M5 (w29): expose the super coordination layer so out-of-frame scripts (AC-02
    // e2e) can witness the separate editorWorld (camera + editor chrome) + query bindings.
    worldManager,
  };
  (window as unknown as Record<string, unknown>).__forgeax_editor = editorGlobal;
  // Propagate to parent frame when running inside a same-origin carrier iframe
  // so that Playwright page.evaluate() in the main frame can access it directly.
  if (window.parent !== window) {
    try { (window.parent as unknown as Record<string, unknown>).__forgeax_editor = editorGlobal; } catch { /* cross-origin */ }
  }

  // Generated-visual presenters obtain their host inputs through this explicit
  // registration, never by querying #app or the DEV-only debug object above.
  // Register immediately before starting the app so teardown unregisters the
  // source before it stops the renderer and releases the canvas.
  registerTeardown(registerEditorVisualHost({
    gateway: gateway as never,
    canvas,
    gameRoot: gameSession.gameRoot,
    getActiveCameraEntity: deriveActiveCameraEntity,
  }));

  // start the live render loop + reporters (was :895). The host error listener
  // is installed immediately after createApp so an in-flight HMR/page reload
  // cannot leave a live renderer without its structured error owner.
  // Register the telemetry system before arming the App loop. World schedules
  // are consumed by the first running frame; installing this after start can
  // leave the live carrier rendering while the FPS publisher never runs.
  registerTeardown(installFpsReport(
    (listener) => renderer.subscribe((event) => {
      if (event.kind === 'frame-submitted') listener();
    }),
    { shouldPublish: () => !remotePlayFpsActive },
  ));
  editorApp.start();
  const reportedSaveRuns = new Set<string>();
  registerTeardown(gateway.subscribeOperationRuns((run) => {
    if (run.status !== 'failed' || run.operationId !== 'saveDocToDisk' || reportedSaveRuns.has(run.runId)) return;
    reportedSaveRuns.add(run.runId);
    forwardFeedbackHealth({
      source: 'edit',
      code: normalizeSaveFailureCode(run.error),
      message: errorMessage(run.error, 'The scene could not be saved.'),
    });
  }));
  // Cross-realm M1 boundary: the Runtime owns Gateway/World/Registry and serves
  // their typed operation/projection surface over one transferred MessagePort.
  // A top-level local viewport has no owning window and installs no listener.
  const runtimeOwner = window.opener ?? (window.parent === window ? null : window.parent);
  const runtimeUiGraph = getActiveRuntimeUiGraph();
  if (
    runtimeUiGraph !== null
    && (runtimeIdentity.carrierKind === 'browser-page'
      || runtimeIdentity.carrierKind === 'tauri-webview')
  ) {
    // Top-level popup/Tauri carriers do not share a durable WindowProxy shape.
    // Both therefore use the same generation-fenced structured channel; iframe
    // carriers retain the lower-overhead transferred MessagePort path below.
    const service = createViewportRuntimeTransportService({
      runtime: runtimeIdentity,
      referenceCreationScope,
      graph: runtimeUiGraph,
      gateway,
      readRuntimeBinding: () => gameSession.runtimeBinding,
      readMaterialInspection: materialPublicationBinding.readMaterialInspection,
      readVersionControlSnapshot: versionControlBinding.provider.snapshot,
      refreshVersionControlSnapshot: versionControlBinding.provider.refresh,
      readViewportStatus: () => ({
        quadrant: getViewportQuadrant(),
        playPhase: gateway.playPhase,
        lastPlayError: gateway.lastPlayError,
        fps: getFps(),
        canUndo: gateway.canUndo(),
        canRedo: gateway.canRedo(),
        gizmoMode: getGizmoMode(),
        gizmoSpace: getGizmoSpace(),
        gizmoPivot: getGizmoPivot(),
      }),
      readExecutionReport: executionDiagnostics.report,
    });
    referenceCreationTransport = service;
    registerTeardown(installBroadcastViewportRuntimeHost({
      runtime: runtimeIdentity,
      service,
    }));
    // Detached popup/Tauri windows still host PanelShell in THIS window.
    // Broadcast serves other windows; the local client is what enables Play.
    if (shouldBindInProcessViewportRuntimeClient(runtimeIdentity.carrierKind)) {
      const localClient: MessagePortTransportClient = createInProcessViewportRuntimeClient(service);
      const unbindLocalClient = bindViewportRuntimeClient(
        runtimeIdentity,
        localClient,
        gameSession.runtimeBinding?.catalogRoots,
      );
      const uninstallPreviewExecutorLease = installInProcessPreviewExecutorLeaseHost(
        bindVfxPreviewExecutorLease,
      );
      registerTeardown(() => {
        uninstallPreviewExecutorLease();
        unbindLocalClient();
        localClient.dispose();
      });
    }
  } else if (runtimeOwner !== null && runtimeUiGraph !== null && runtimeIdentity.carrierKind === 'iframe') {
    const runtimeHostOrigin = readViewportRuntimeHostOrigin(window.location.search, window.location.origin);
    registerTeardown(configureEditorPageNavigation({
      openAsset: async (asset) => {
        runtimeOwner.postMessage({
          type: VIEWPORT_RUNTIME_OPEN_ASSET,
          runtime: runtimeIdentity,
          asset,
        }, runtimeHostOrigin);
      },
      getActiveAsset: () => null,
      subscribe: () => () => {},
    }));
    const service = createViewportRuntimeTransportService({
      runtime: runtimeIdentity,
      referenceCreationScope,
      graph: runtimeUiGraph,
      gateway,
      readRuntimeBinding: () => gameSession.runtimeBinding,
      readMaterialInspection: materialPublicationBinding.readMaterialInspection,
      readVersionControlSnapshot: versionControlBinding.provider.snapshot,
      refreshVersionControlSnapshot: versionControlBinding.provider.refresh,
      readAssetPayload: (guid) => loadRuntimeAssetPayload(assets, guid),
      readViewportStatus: () => ({
        quadrant: getViewportQuadrant(),
        playPhase: gateway.playPhase,
        lastPlayError: gateway.lastPlayError,
        fps: getFps(),
        canUndo: gateway.canUndo(),
        canRedo: gateway.canRedo(),
        gizmoMode: getGizmoMode(),
        gizmoSpace: getGizmoSpace(),
        gizmoPivot: getGizmoPivot(),
      }),
      readExecutionReport: executionDiagnostics.report,
    });
    referenceCreationTransport = service;
    registerTeardown(service.dispose);
    registerTeardown(installViewportRuntimeConnectionHost({
      target: window as unknown as ViewportRuntimeMessageTarget,
      expectedSource: runtimeOwner as unknown as ViewportRuntimeMessageSource,
      expectedOrigin: runtimeHostOrigin,
      runtime: runtimeIdentity,
      service,
      onPreviewExecutorLeaseConnect: bindVfxPreviewExecutorLease,
      onReject: (reason) => console.warn(`[editor] ${reason}`),
    }));
    const projectedAssetRuns = new Set<string>();
    registerTeardown(gateway.subscribeOperationRuns((run) => {
      runtimeOwner.postMessage({
        type: VIEWPORT_RUNTIME_PROJECTION_INVALIDATED,
        runtime: runtimeIdentity,
        projection: 'operations',
        revision: gateway.operationRunSnapshot().revision,
      }, runtimeHostOrigin);
      if (run.status !== 'succeeded'
        || run.operationId !== 'saveAssetSourceOverride'
        || projectedAssetRuns.has(run.runId)) return;
      const guid = (run.input as { readonly guid?: unknown } | undefined)?.guid;
      if (typeof guid !== 'string') return;
      projectedAssetRuns.add(run.runId);
      runtimeOwner.postMessage({
        type: VIEWPORT_RUNTIME_PROJECTION_INVALIDATED,
        runtime: runtimeIdentity,
        projection: 'assets',
        revision: run.sequence,
        guid,
      }, runtimeHostOrigin);
    }));
    registerTeardown(gateway.subscribeOperationCapabilities((snapshot) => {
      runtimeOwner.postMessage({
        type: VIEWPORT_RUNTIME_PROJECTION_INVALIDATED,
        runtime: runtimeIdentity,
        projection: 'capabilities',
        revision: snapshot.revision,
      }, runtimeHostOrigin);
    }));
  } else if (runtimeUiGraph !== null && shouldBindInProcessViewportRuntimeClient(runtimeIdentity.carrierKind)) {
    // Studio's current editor is a single realm: the shell and this Runtime
    // share one window, so there is no iframe MessagePort handshake to bind the
    // panel-side viewport client. Reuse the exact canonical service locally so
    // toolbar enablement and projection queries observe the same Runtime-owned
    // Gateway/World surface as the isolated carrier path.
    // WebView2/Tauri may expose a wrapper `window.parent !== window` even for
    // the main window; that is not an iframe carrier and must not skip bind.
    const service = createViewportRuntimeTransportService({
      runtime: runtimeIdentity,
      referenceCreationScope,
      graph: runtimeUiGraph,
      gateway,
      readRuntimeBinding: () => gameSession.runtimeBinding,
      readMaterialInspection: materialPublicationBinding.readMaterialInspection,
      readVersionControlSnapshot: versionControlBinding.provider.snapshot,
      refreshVersionControlSnapshot: versionControlBinding.provider.refresh,
      readAssetPayload: (guid) => loadRuntimeAssetPayload(assets, guid),
      readViewportStatus: () => ({
        quadrant: getViewportQuadrant(),
        playPhase: gateway.playPhase,
        lastPlayError: gateway.lastPlayError,
        fps: getFps(),
        canUndo: gateway.canUndo(),
        canRedo: gateway.canRedo(),
        gizmoMode: getGizmoMode(),
        gizmoSpace: getGizmoSpace(),
        gizmoPivot: getGizmoPivot(),
      }),
      readExecutionReport: executionDiagnostics.report,
    });
    referenceCreationTransport = service;
    const localClient: MessagePortTransportClient = createInProcessViewportRuntimeClient(service);
    const unbindLocalClient = bindViewportRuntimeClient(
      runtimeIdentity,
      localClient,
      gameSession.runtimeBinding?.catalogRoots,
    );
    const uninstallPreviewExecutorLease = installInProcessPreviewExecutorLeaseHost(
      bindVfxPreviewExecutorLease,
    );
    registerTeardown(() => {
      uninstallPreviewExecutorLease();
      unbindLocalClient();
      localClient.dispose();
      service.dispose();
    });
  }
  // W1-L1H producer: a managed Studio page is the editor viewport carrier.
  // Publish identity/readiness from this same canvas/renderer and keep the
  // heartbeat owned by this realm; ordinary Studio pages stay silent.
  // The typed gameplay bridge is installed from the same live Gateway + canvas
  // seam; it is the only gameplay transport exposed by the viewport.
  void installManagedCarrierHealth(canvas, renderer, gameSession.slug, rendererProvenance)
    .then((health) => {
      registerTeardown(health.dispose);
      const capture = createGameplayCaptureGateway({
        captureImage: () => captureGameplayViewport(container, canvas),
        getProvenance: health.getIdentity,
      });
      const gameplayGateway = session?.getGameplayGateway() ?? gateway;
      const bridge = createGameplayCarrierBridge(
        createGameplayOperations(gameplayGateway, capture),
        health.getIdentity,
      );
      registerTeardown(registerLiveGameplayBridge(bridge));
      const host = globalThis as typeof globalThis & { __forgeax_editor_gameplay?: unknown };
      host.__forgeax_editor_gameplay = bridge;
      registerTeardown(() => {
        if (host.__forgeax_editor_gameplay === bridge) delete host.__forgeax_editor_gameplay;
      });
    })
    .catch((error) => console.warn('[editor] managed carrier health unavailable:', error));
  registerTeardown(installAssetSpawnBridge());
  // Single-realm drag-to-viewport + pause-when-hidden live on the viewport's own
  // container (drop → gateway spawn; visibility → editorApp.pause/resume).
  registerTeardown(installViewportDropZone(container));
  const visibilityPause = installVisibilityPause(
    container,
    editorApp,
    () => session?.getPlayPauseHandle() ?? null,
  );
  refreshVisibilityTarget = visibilityPause.refresh;
  registerTeardown(visibilityPause);
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
