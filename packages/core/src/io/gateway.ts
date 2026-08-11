import { applyCommand, createEditSession } from '../session/document';
import type { DocApplierCtx, DocAliasMap, EngineWriteProxy } from '../session/document';
import type { CommandError, EditorOp, EditSession } from '../types';
import {
  createEntityObjectRef,
  createCommandError,
  type ErrorCategory,
  type ErrorObjectRefs,
  type RunProgress,
} from '@forgeax/editor-product';
import type { FieldShapeKind, World } from '@forgeax/engine-ecs';
import { clearSelection, getSelection, getSelectionList } from '../store/selection';
import {
  applierFor,
  applierRegistrySnapshot,
  domainOf,
  registerApplier,
  subscribeApplierRegistry,
} from './appliers';
import type { ApplierFn, SessionApplier, SessionApplierCtx } from './appliers';
import type {
  CatalogReconcileProvider,
  GatewayOpDescriptor,
  GatewayOpSnapshot,
  OpDescriptor,
  PlanFn,
  ArgsSchema,
} from './catalog';
import { listOps as catalogListOps, registerBuiltinOp, registerDefinedOp, hasOp, getOp } from './catalog';
import type { QuerySnapshotFn } from './query-snapshot';
import { validate as validateArgs } from './args-schema';
import type { ValidateResult } from './args-schema';
import { EngineFacade } from './engine-facade';
import { assetIO, type AssetIOFacade } from './asset-io-facade';
import { pushSpan, popSpan, lastRoot, recentRoots, activeSpan, droppedTracesCount, type SpanNode } from './trace';
import { assetsErrorRevision, recentAssetsErrors } from '../store/assets-error-bus';
import {
  createDiagnosticsReadModel,
  type DiagnosticsReadModel,
  type RuntimeDiagnosticsProvider,
} from './diagnostics';
import { EMPTY_SCENE_READ_MODEL, type SceneReadModel } from './scene-read-model';
import type { SelectionReadModel } from './selection-read-model';
import {
  AUTHORED_SCENE_AUTHORING_SESSION,
  type SceneAuthoringSessionReadModel,
} from './scene-authoring-session';
import { describeSceneActivation } from '../assets/scene-activation';
import { createRuntimeReadiness } from './vfx-runtime-readiness';
import {
  queryCompatibleAssetCatalog,
  type CompatibleAssetCatalogResult,
} from '../assets/compatible-asset-catalog';
import { catalogStoragePath } from '../assets/catalog-storage-path';
// gateway.ts keeps the single-entry dispatch/apply/ledger narrative; sibling
// modules host non-entry helpers (history/step/handle-id shaping, query-side
// reader binding). None of them route a command or decide a domain.
import { labelOf, entityOf, step, nextOpHandleId } from './gateway-history';
import type { CommandOrigin, HistoryDiff, HistoryStep } from './gateway-history';
import { makeQueryFn } from './gateway-query';
import {
  GameProjectionRegistry,
  type GameActionDescriptor,
  type GameProjectionResult,
  type GameProjectionValue,
  type GameReadDescriptor,
} from './game-projection';
import {
  collectSceneAsset as collectLiveSceneAsset,
  type CollectSceneAssetResult,
} from './scene-asset-collect';
import { entName, entParent, worldEntityHandles } from '../store/entity-state';
import type { EntityHandle } from '../scene/scene-types';
import {
  sceneInstanceRoots,
  snapshotSceneInstanceValue,
  type SceneInstanceReadModel,
  type SceneInstanceReadResult,
} from './scene-instance-read-model';
// Asset read surface: resolveAssetHandle turns a shared<T> handle (query
// returns it as opaque-handle.raw) into its live payload — covering both
// builtin (HANDLE_CUBE via BuiltinAssetRegistry) and catalog assets, O(1).
import { resolveAssetHandle, type AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { Asset, AssetGuid, CatalogEntry, Handle } from '@forgeax/engine-types';

function importPayloadFingerprint(base64: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < base64.length; i++) {
    hash ^= base64.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}:${base64.length}`;
}

/** Keep selected-file bytes only for the active effect, never in retained runs or ledger. */
function retainedCommand(cmd: EditorOp): EditorOp {
  if (cmd.kind !== 'importAsset') return cmd;
  const source = cmd as EditorOp & {
    readonly base64?: unknown;
    readonly companionSources?: readonly { readonly destPath?: unknown; readonly base64?: unknown }[];
  };
  const { base64, companionSources, ...intent } = source;
  return {
    ...intent,
    skipUpload: true,
    ...(typeof base64 === 'string' ? { payloadFingerprint: importPayloadFingerprint(base64) } : {}),
    ...(Array.isArray(companionSources) ? {
      companionFingerprints: companionSources.map((companion) => ({
        destPath: companion.destPath,
        ...(typeof companion.base64 === 'string' ? { fingerprint: importPayloadFingerprint(companion.base64) } : {}),
      })),
    } : {}),
  } as EditorOp;
}
// Component read surface: same registry the query snapshot uses to resolve
// component names, projected here so an AI can discover component names +
// field schemas BEFORE a spawn/setComponent (instead of learning them only by
// triggering a SPAWN_FAILED). Derive, don't duplicate.
import { getRegisteredComponents, resolveComponent } from '@forgeax/engine-ecs';
import { getComponentSchema } from '../scene/schema';
import {
  projectSourceFileDeleteStatus,
  sourceFileDeletePath,
} from '../session/source-file-delete-status';
import type { SourceFileDeleteStatus } from '../session/source-file-delete-status';
import {
  deriveAssetImpact,
  type AssetImpactResult,
  type AssetMutationPreviewRequest,
} from './asset-impact';
import {
  OperationRunRegistry,
  type OperationRun,
  type OperationRunListener,
  type OperationRunReadResult,
  type OperationRunSnapshot,
} from './operation-runs';
import { acceptOperationRun } from './operation-run-dispatch';

export type BusListener = (doc: EditSession, lastCommand: EditorOp | null) => void;

export type DispatchResult =
  // `result.created` — new entity roots a document dispatch produced (see
  // ApplyResult.created). Optional: document ops carry it (possibly []); session/
  // transient ops and the lifecycle methods (update/commit/cancel) omit it. This
  // is how a caller (UI selection, AI over the eval bridge) learns what it just
  // made without re-reading the mutated op or diffing a query snapshot.
  | { ok: true; result?: { created: EntityHandle[]; operationRun?: OperationRun } }
  | { ok: false; error: CommandError };

function requestIdOf(cmd: EditorOp): string | undefined {
  const requestId = (cmd as { readonly requestId?: unknown }).requestId;
  return typeof requestId === 'string' ? requestId : undefined;
}

/** Derive stable locator context from the operation payload, never from hint text. */
function objectRefsOf(cmd: EditorOp): ErrorObjectRefs {
  const refs: ErrorObjectRefs = {
    operation: { kind: 'operation', id: cmd.kind },
  };
  const entity = (cmd as { readonly entity?: unknown }).entity;
  const component = (cmd as { readonly component?: unknown }).component;
  const guid = (cmd as { readonly guid?: unknown }).guid;
  const sceneGuid = (cmd as { readonly sceneGuid?: unknown }).sceneGuid;
  const path = (cmd as { readonly path?: unknown }).path;
  const packPath = (cmd as { readonly packPath?: unknown }).packPath;
  return {
    ...refs,
    ...(typeof entity === 'number' ? { entity: createEntityObjectRef({ handle: entity }) } : {}),
    ...(typeof component === 'string' ? { component: { kind: 'component', id: component } } : {}),
    ...(typeof guid === 'string' ? { asset: { kind: 'asset', id: guid } } : {}),
    ...(typeof sceneGuid === 'string' ? { asset: { kind: 'scene-asset', id: sceneGuid } } : {}),
    ...(typeof path === 'string' ? { file: { kind: 'file', id: path } } : {}),
    ...(typeof packPath === 'string' ? { scene: { kind: 'scene', id: packPath } } : {}),
  };
}

function categoryOf(error: CommandError): ErrorCategory {
  if (error.category !== undefined) return error.category;
  if (error.code === 'INVALID_ARGS') return 'validation';
  if (error.code === 'UNKNOWN_OP' || error.code === 'OP_INTERRUPTED' || error.code === 'edit-rejected-in-play') return 'state';
  return 'unknown';
}

/** Gateway's one boundary projection for all immediate dispatch failures. */
function normalizeGatewayError(error: CommandError, cmd: EditorOp): CommandError {
  const requestId = requestIdOf(cmd);
  return createCommandError({
    ...error,
    owner: error.owner ?? 'editor-core',
    category: categoryOf(error),
    operationId: error.operationId ?? cmd.kind,
    ...(error.requestId === undefined && requestId === undefined ? {} : { requestId: error.requestId ?? requestId }),
    objectRefs: error.objectRefs ?? objectRefsOf(cmd),
    retryable: error.retryable ?? false,
    recoveryActions: error.recoveryActions ?? [],
  }) as unknown as CommandError;
}

// Lightweight asset summary — the shared shape both describe legs (describeAsset
// by-handle, describeAssetByGuid by-guid) return, so a caller reads one identity
// contract regardless of how it addressed the asset. `kind` always; `guid`+`name`
// when catalogued, else `builtin:true`. `meta` carries the POD's own lightweight
// fields (a texture's width/height/format, a mesh's attributes, …) with the heavy
// binary buffers stripped — so it is safe to read without dragging pixels/vertices
// into scope. The FULL payload (incl. buffers) stays behind resolveAsset(handle) /
// lookupAsset(guid). `meta` is an open bag on purpose: its keys are the engine
// Asset POD's own field names (Derive — this type declares no per-kind field).
export interface AssetSummary {
  kind: string;
  guid?: string;
  name?: string;
  builtin?: boolean;
  meta?: Record<string, unknown>;
}

export type AssetSummaryResult = ({ ok: true } & AssetSummary) | { ok: false; error: CommandError };

// A field is a "heavy buffer" iff it is a binary blob (TypedArray/DataView view of
// an ArrayBuffer, or a raw ArrayBuffer). This is the structural test summarizeAsset
// uses to drop pixel/vertex/index data — deliberately SHAPE-based, not a per-kind
// field list, so no asset-kind business knowledge leaks into the gateway.
function isHeavyBuffer(value: unknown): boolean {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
}

// CommandOrigin + HistoryStep + HistoryDiff now live in io/gateway-history.ts (sunk non-entry
// detail, w10). Re-exported here so the barrel (index.ts) surface stays byte-
// identical — every consumer keeps importing them from editor-core unchanged
// (AC-03 consumers zero-edit).
export type { CommandOrigin, HistoryDiff, HistoryStep };

interface StackEntry {
  cmd: EditorOp;
  inverse: EditorOp;
  /** Original command inverse retained for review after an undo/redo round-trip. */
  reviewInverse?: EditorOp;
  origin: CommandOrigin;
}

// ── Lifecycle types (plan-strategy §2 D-2) ──────────────────────────────────

export interface OpHandle {
  readonly id: string;
}

interface ActiveOp {
  handle: OpHandle;
  /** The op-skeleton at begin time — used to apply inverse on cancel. */
  beginCmd: EditorOp;
  /** The inverse of beginCmd — computed at begin via applyCommand, used to roll back on cancel. */
  beginInverse: EditorOp;
  /**
   * The last FORWARD command actually applied (= beginCmd, then the accumulated
   * begin+patch after each update). commit records THIS (not beginCmd) as the
   * undo entry's forward command and the ledger entry — so Redo re-applies the
   * FINAL drag pose (not the begin-time pose) and the ledger reflects what the op
   * actually did. m3-w6: without this, a gizmo drag migrated to begin/update/
   * commit would Redo back to the pre-drag pose (a regression vs the old single
   * pointerup dispatch, which recorded the final setComponent).
   */
  lastCmd: EditorOp;
  /**
   * Who issued this lifecycle op (default 'human'). commit records THIS in the
   * ledger/undo origins so an AI-initiated begin/update/commit is indistinguishable
   * from a human one except for the origin field (AC-01 human/AI isomorphism —
   * verify F1). begin() takes the origin; the whole lifecycle carries it.
   */
  origin: CommandOrigin;
}

// ── Executor + ApplierCtx (§2 D-2, requirements AC-01) ────────────────────
//
// The executor is the only code path that calls appliers. It constructs an
// ApplierCtx object per execution and hands it to the applier. Document
// appliers currently receive (session, cmd) — the executor wraps them with
// a backward-compatible adapter that maps ctx back to session for the
// document-domain appliers. When all appliers are migrated to ctx-shaped
// signatures, the adapter can be removed.
//
// plan-strategy §2 D-2: ctx type has NO world field (AC-01).
// plan-strategy §2 D-2: ctx type has engine / dispatchSub / query.

/** ApplierCtx — constructor-injected IoC context (plan-strategy §2 D-2).
 *  Contains ONLY the controlled proxy (engine), recursive dispatch (dispatchSub),
 *  and read-side query (query). NO world field (AC-01 negative). */
export interface ApplierCtx {
  /** Controlled proxy for engine World writes. Sole mutator outside this file
   *  is a lint violation (gateway A). */
  engine: EngineFacade;
  /** Controlled proxy for asset/pack IO (north-star §2 write-gate axis symmetry
   *  with engine). Sole mutator outside this file is a lint-unique-mutator
   *  violation (G-5 / AC-D1). */
  assetIO: AssetIOFacade;
  /** Recursive dispatch — transaction applier uses this to run sub-ops
   *  through the executor (replacing the M1 module-level _dispatchDocumentSub). */
  dispatchSub(kind: string, payload: EditorOp): ReturnType<ApplierFn>;
  /** Read-side query snapshot function. Same as the gateway.buildQueryFn() output. */
  query: QuerySnapshotFn;
  /** Origin of the outer Gateway dispatch, preserved for session appliers. */
  origin: CommandOrigin;
  /** Resolve a live shared<T> handle to its asset payload against THIS gateway's
   *  active world — lets a session applier read bound-asset facts (e.g. a clip's
   *  duration) without importing the gateway singleton (animation-preview M1). */
  resolveAsset(handle: number): { ok: true; asset: Asset } | { ok: false; error: CommandError };
  /** Gateway-owned progress reporter for request-correlated operations. */
  operationRun?: {
    reportProgress(progress: RunProgress): void;
  };
}

/**
 * The single authoritative mutable path. Human UI and AI both call `dispatch`.
 * Maintains Undo/Redo stacks (each entry = the command + its inverse) and
 * notifies subscribers after every change. Selection is intentionally NOT a
 * command here — it is transient view state (see selection store).
 *
 * Lifecycle (plan-strategy S2 D-2): begin / update / commit / cancel with
 * single active-op slot + implicit cancel on interrupt.
 */
export class EditGateway {
  doc: EditSession;
  private undoStack: StackEntry[] = [];
  private redoStack: StackEntry[] = [];
  private listeners = new Set<BusListener>();
  /** Diagnostics consumers need session-ledger pulses too; document `subscribe`
   * intentionally remains the World/docVersion signal. */
  private diagnosticsListeners = new Set<() => void>();
  private readonly runtimeDiagnosticsProviders = new Map<string, {
    readonly provider: RuntimeDiagnosticsProvider;
    readonly unsubscribe: () => void;
  }>();
  private _runtimeDiagnosticsRevision = 0;
  // Scene-reload listeners (M5 / D-4). Fired by replaceDoc — the SSOT collar every
  // scene reload funnels through (scene switch, disk/storage load). The super
  // (world-manager) subscribes to bump the sceneWorld epoch + revalidate the
  // selection, so every handle-pair minted before the reload is batch-invalidated
  // (AC-05). Distinct from `listeners`: those fire on every mutation (rev bump);
  // this fires ONLY on a whole-document swap, which is exactly a world reload.
  private sceneReloadListeners = new Set<() => void>();
  // Monotonic revision — bumped on EVERY mutation that notifies subscribers
  // (dispatch/undo/redo via emit, and replaceDoc). Lets consumers (e.g. the
  // engine sync) detect "did the doc change since I last looked?" in O(1) instead
  // of hashing the whole document. Every path that fires subscribers bumps this,
  // so a subscriber that only ever runs on notification can trust rev as a
  // complete change signal.
  private _rev = 0;
  get rev(): number { return this._rev; }
  /** append-only log of every applied command — the "AI did X" ledger. */
  readonly ledger: EditorOp[] = [];
  /** origin of each ledger entry (index-aligned): who issued the command. */
  readonly origins: CommandOrigin[] = [];
  /**
   * Non-committing edit mode (feat-20260630-viewport w27, requirements AC-11).
   * play·scene (UE Simulate) lets the user edit a running game for observation,
   * but those edits must NOT persist: while true, `dispatch` STILL applies the
   * command and STILL emits (the world changes + the engine sync repaints for
   * immediate feedback), but it does NOT push to undoStack / ledger / origins.
   * So Undo stays disabled and the AI ledger is not polluted; the ■ Stop snapshot
   * (AC-07) discards the transient world state on exit. Set true on play·scene
   * entry, false otherwise. Default false (normal committing dispatch).
   *
   * M2 (plan-strategy §4 R4, requirements AC-09, m2-w10): the same boolean now
   * gates ALL THREE domains uniformly — under transientMode, document ops skip
   * undo+ledger AND session ops skip their ledger write, while every op still
   * routes through the single gateway door and still applies + emits. There is no
   * per-mode routing exception: the extension is one wider boolean gate, not a
   * new mechanism (still the one read point here, one write point in
   * edit-runtime's ViewportComponent — research R4).
   */
  transientMode = false;

  // Async authored operations hold their history entry until the canonical
  // resource/effect promise succeeds. This is deliberately one slot, matching
  // the existing async session-op capture seam in scene-persistence.
  private deferHistory = false;
  private deferredEntry: { cmd: EditorOp; inverse?: EditorOp; origin: CommandOrigin } | null = null;

  dispatchDeferred(cmd: EditorOp, origin: CommandOrigin = 'human'): DispatchResult {
    if (this.deferHistory || this.deferredEntry !== null) {
      return { ok: false, error: { code: 'OP_INTERRUPTED', hint: 'An authored commit is already waiting for its canonical effect.' } };
    }
    this.deferHistory = true;
    this.deferredEntry = null;
    const result = this.dispatch(cmd, origin);
    this.deferHistory = false;
    if (!result.ok) this.deferredEntry = null;
    return result;
  }

  publishDeferred(cmd: EditorOp): boolean {
    const entry = this.deferredEntry;
    if (entry === null || entry.cmd !== cmd) return false;
    if (entry.inverse !== undefined) {
      this.undoStack.push({ cmd: entry.cmd, inverse: entry.inverse, origin: entry.origin });
      this.redoStack.length = 0;
    }
    this.ledger.push(entry.cmd);
    this.origins.push(entry.origin);
    this.emitDiagnostics();
    this.deferredEntry = null;
    return true;
  }

  discardDeferred(cmd: EditorOp): boolean {
    if (this.deferredEntry?.cmd !== cmd) return false;
    this.deferredEntry = null;
    return true;
  }

  // ── Scan-phase lock (north-star §8 infrastructure, not an op) ──────────────
  // During startup asset scan, dispatch() rejects ALL ops so the catalog stays
  // consistent. The UI shows a blocking overlay. This is NOT an op — it's a
  // precondition guard (like engine init), and doesn't appear in the ledger.
  private _scanLocked = false;

  /** Whether the gateway is currently locked for a scan. */
  get scanLocked(): boolean { return this._scanLocked; }

  /** Lock the gateway: all dispatch() calls will be rejected. */
  lockForScan(): void { this._scanLocked = true; }

  /** Unlock the gateway: dispatch() resumes normal operation. */
  unlockAfterScan(): void { this._scanLocked = false; }

  // ── activeWorld / play-bookmark (plan-strategy D-3, M1) ──────────────────
  //
  // Single pointer model: _playWorld is null in edit mode, set to a play
  // World during play. activeWorld + mode are derived from it (Derive,
  // architecture-principles section 2 — no second state field).
  // enterPlay/exitPlay are the ONLY mutation paths; both clear selection
  // and emit a notification so panels know to re-read the hierarchy.

  private _playWorld: World | null = null;
  /** A disposable Play carrier owns its World in another realm. The edit World
   * stays retained here only as a frozen projection and must never be mutated. */
  private _remotePlayActive = false;

  // ── Game-owned Play projection ─────────────────────────────────────────────
  // The registry contains closures supplied by the CURRENT game bootstrap only.
  // It is never an editor operation registry: actions are transient gameplay
  // behavior (no authoring ledger/undo/pack) and reads return JSON snapshots. The
  // edit-runtime host installs it only after Play succeeds and clears it before the
  // fresh play world is dropped, so stale game closures cannot outlive their world.
  private _gameProjection: GameProjectionRegistry | null = null;

  // Dirty state remains owned by scene-persistence. The downstream host binds
  // this read-only provider so AI and UI inspect the same fact through Gateway
  // without importing or duplicating persistence state.
  private _dirtyReadProvider: (() => boolean) | null = null;
  // Scene identity/current/default facts remain owned by scene-persistence. The
  // Gateway only projects that single provider so AI and UI have one read door.
  private _sceneReadProvider: (() => SceneReadModel) | null = null;
  private _sceneAuthoringSessionProvider: (() => SceneAuthoringSessionReadModel) | null = null;
  // The Catalog replica remains owned by the engine/read model. Gateway stores
  // only this injected read callback, never a second catalog or revision map.
  private _catalogReconcileProvider: CatalogReconcileProvider | null = null;


  // ── Play-attempt observability (solo round-8, friction #3) ────────────────
  // ▶ Play assembly is ASYNC and fire-and-forget: `dispatch({kind:'play'})`
  // returns {ok:true} synchronously while run-lifecycle.playSimulation() spins
  // up a fresh world in a detached promise that CAN fail (bad scene / createApp
  // error) and degrade back to edit (run-lifecycle.ts). Without a front-door
  // terminal signal, an AI polling `mode` cannot tell "still assembling" from
  // "already failed, will never flip" — rounds 3 & 5 both misdiagnosed exactly
  // this (round 5 escalated a non-bug). These two fields are the failure
  // COUNTERPART to enterPlay's success path: _playPending marks an in-flight
  // attempt, _lastPlayError carries why the last one failed. playPhase is
  // DERIVED from (_playWorld, _playPending, _lastPlayError) — no second `mode`
  // field (architecture-principles §2 Derive).
  private _playPending = false;
  private _lastPlayError: CommandError | null = null;

  /** The current active World pointer (Derive). edit mode → doc.world, play mode → playWorld.
   *  During a studio cross-game switch teardown may briefly leave doc.world undefined
   *  until the next createApp inject — callers must treat a missing world as empty
   *  (see entity-state / Hierarchy guards). */
  get activeWorld(): World {
    return (this._playWorld ?? this.doc.world) as unknown as World;
  }

  /** Derived read surface for current mode (Derive from _playWorld, no second state field). */
  get mode(): 'edit' | 'play' {
    return this._playWorld !== null || this._remotePlayActive ? 'play' : 'edit';
  }

  /**
   * Terminal-aware play lifecycle phase (Derive from _playWorld/_playPending/
   * _lastPlayError — no second state field). Unlike `mode` (a two-value edit/play
   * pointer view), this distinguishes the async assembly's intermediate + failure
   * states so a front-door caller polls a TERMINAL phase, not a value that may
   * never change:
   *   - `play`     — assembled, live play world active (_playWorld set)
   *   - `starting` — ▶ dispatched, assembly in flight (poll again)
   *   - `failed`   — last attempt failed + degraded to edit; read `lastPlayError`
   *   - `edit`     — not playing, no failed attempt pending inspection
   * `starting`/`failed` win over the bare edit pointer so a docs-only AI can wait
   * for `play`|`failed` (both terminal) instead of blind-polling `mode` (round-8 #3).
   */
  get playPhase(): 'edit' | 'starting' | 'play' | 'failed' {
    if (this._playWorld !== null || this._remotePlayActive) return 'play';
    if (this._playPending) return 'starting';
    if (this._lastPlayError !== null) return 'failed';
    return 'edit';
  }

  /** The error from the last failed ▶ Play attempt, or null. Cleared when a new
   *  attempt begins or play succeeds (see beginPlayAttempt/enterPlay). */
  get lastPlayError(): CommandError | null {
    return this._lastPlayError;
  }

  /** Mark a ▶ Play attempt as in flight (playPhase → 'starting'). Clears any prior
   *  error so a retry starts clean. Called by run-lifecycle at the top of
   *  playSimulation(), BEFORE the async assemble. Emits so panels/AI re-read. */
  beginPlayAttempt(): void {
    this._playPending = true;
    this._lastPlayError = null;
    this._rev++;
    for (const fn of this.listeners) fn(this.doc, null);
  }

  /** Record a failed ▶ Play attempt (playPhase → 'failed'; mode stays 'edit').
   *  Called by run-lifecycle's assemble-failure branch after it thaws the edit
   *  world. The error rides the front door so a poller reads WHY, not just that
   *  the flip never came. Emits so subscribers re-read. */
  failPlayAttempt(error: CommandError): void {
    this._playPending = false;
    this._lastPlayError = error;
    this._rev++;
    for (const fn of this.listeners) fn(this.doc, null);
  }

  /** Switch the pointer to a play World. Clears selection + emits notification (D-3/D-11).
   *  Success clears the pending flag + any stale error → playPhase 'play'. */
  enterPlay(playWorld: World): void {
    this._remotePlayActive = false;
    this._playWorld = playWorld;
    this._playPending = false;
    this._lastPlayError = null;
    clearSelection();
    this._rev++;
    for (const fn of this.listeners) fn(this.doc, null);
  }

  /** Enter read-only Play while the disposable child realm owns PlayWorld. */
  enterRemotePlay(): void {
    this._playWorld = null;
    this._remotePlayActive = true;
    this._playPending = false;
    this._lastPlayError = null;
    clearSelection();
    this._rev++;
    for (const fn of this.listeners) fn(this.doc, null);
  }

  /** Return the pointer to the edit world. Clears selection + emits notification.
   *  Also clears the pending flag + last error → playPhase back to 'edit'. */
  exitPlay(): void {
    this.clearGameProjection();
    this._playWorld = null;
    this._remotePlayActive = false;
    this._playPending = false;
    this._lastPlayError = null;
    clearSelection();
    this._rev++;
    for (const fn of this.listeners) fn(this.doc, null);
  }

  /**
   * Create the one ephemeral registry a game bootstrap may fill for the pending
   * Play run. Downstream host code owns when it is installed; core owns discovery
   * and invocation so scope① stays `{ gateway, query, _import }`.
   */
  createGameProjectionRegistry(): GameProjectionRegistry {
    return new GameProjectionRegistry();
  }

  /** Install a fully bootstrapped game's projection only while its play World is live. */
  installGameProjection(registry: GameProjectionRegistry): void {
    if (this._playWorld === null) {
      registry.clear();
      return;
    }
    this.clearGameProjection();
    this._gameProjection = registry;
    this._rev++;
    for (const fn of this.listeners) fn(this.doc, null);
  }

  /** Drop all game-owned closures before their Play world is torn down. */
  clearGameProjection(): void {
    if (this._gameProjection === null) return;
    this._gameProjection.clear();
    this._gameProjection = null;
  }

  /** List game-owned, Play-only action descriptors; empty outside live Play. */
  listGameActions(): readonly GameActionDescriptor[] {
    return this._gameProjection?.listActions() ?? [];
  }

  /** List game-owned, Play-only read descriptors; empty outside live Play. */
  listGameReads(): readonly GameReadDescriptor[] {
    return this._gameProjection?.listReads() ?? [];
  }

  /** Invoke one registered gameplay action without creating an editor command. */
  invokeGameAction(id: string, args: unknown): Promise<GameProjectionResult<undefined>> {
    if (this.mode !== 'play' || this._gameProjection === null) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'game-projection-unavailable',
          hint: 'game actions are available only while a game Play session is active',
        },
      });
    }
    return this._gameProjection.invokeAction(id, args);
  }

  /** Read one serializable game-owned snapshot without exposing a raw Play World. */
  readGameState(id: string): Promise<GameProjectionResult<GameProjectionValue>> {
    if (this.mode !== 'play' || this._gameProjection === null) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'game-projection-unavailable',
          hint: 'game reads are available only while a game Play session is active',
        },
      });
    }
    return this._gameProjection.readState(id);
  }

  // ── Lifecycle: active-op slot (plan-strategy §2 D-2) ──────────────────────
  private _activeOp: ActiveOp | null = null;

  // Request-correlated session operations share the Gateway-owned OperationRun surface.
  // The registry is Gateway-owned; wrappers and downstream projections read it
  // instead of maintaining a completion map of their own.
  readonly operationRuns = new OperationRunRegistry();

  /**
   * Read-only diagnostics projection. Each source remains owned by its
   * existing producer: trace ring, ledger, asset-error bus, or OperationRun
   * registry. The projection adds only bounded source-specific dedupe and
   * exposes its policy in the returned snapshot.
   */
  readonly diagnostics: DiagnosticsReadModel = createDiagnosticsReadModel({
    getRevision: () => this._rev,
    getLedger: () => this.ledger,
    getTraceRoots: recentRoots,
    getDroppedTraceCount: droppedTracesCount,
    getAssetErrors: recentAssetsErrors,
    getAssetErrorRevision: assetsErrorRevision,
    getOperationRunSnapshot: () => this.operationRuns.snapshot(),
    getRuntimeDiagnosticsProviders: () => [...this.runtimeDiagnosticsProviders.values()].map((entry) => entry.provider),
    getRuntimeDiagnosticsRevision: () => this._runtimeDiagnosticsRevision,
  });

  // ── Executor: EngineFacade (boot-constructed, plan-strategy §2 D-2) ───────
  // Created lazily and REBOUND when the underlying world changes. The same
  // facade instance is reused across dispatch calls as long as doc.world is
  // stable; a world swap (boot injection or scene replaceDoc) rebuilds it.
  private _engineFacade: EngineFacade | null = null;
  /** The world the cached facade currently wraps — used to detect a world swap.
   *  M3 t16: configureHostSession dispatches `setSceneId` (a session op that
   *  builds ctx → the facade) BEFORE ViewportComponent injects the real world
   *  (gateway.doc.world = world). If we cached the first facade permanently it
   *  would wrap `undefined` forever. Tracking the wrapped world and rebinding on
   *  change makes the facade always point at the live world — no boot-order trap,
   *  and scene switches (replaceDoc → new doc.world) get a fresh facade too. */
  private _facadeWorld: unknown = undefined;

  /** Get or create an EngineFacade bound to the CURRENT session world.
   *  Rebuilds when doc.world changes (boot injection / scene swap). */
  private _getEngineFacade(): EngineFacade {
    const world = this.doc.world;
    if (!this._engineFacade || this._facadeWorld !== world) {
      // Pass doc.registry so the facade's instantiateSceneAssetFlat can run
      // GUID→live-handle resolution (registry.instantiateFlat). registry is
      // injected by edit-runtime at boot; a rebuild on world swap re-reads the
      // then-current registry. Read side (worldToPack) uses doc.registry the
      // same way (disk-io.ts:236).
      this._engineFacade = new EngineFacade(world!, this.doc.registry);
      this._facadeWorld = world;
    }
    return this._engineFacade;
  }

  /** Public accessor for the boot-constructed EngineFacade (plan-strategy §2 D-2,
   *  research F-3 injection seam). edit-runtime calls this AFTER injecting the
   *  world (gateway.doc.world = world) to obtain the controlled write proxy it
   *  hands to view scaffolding (viewport / preview-skin / drag-spawn) and to
   *  skylight's async IBL handle casting (D-11). Same facade the executor gives
   *  appliers via ctx.engine — one write gate, one instance. */
  engineFacade(): EngineFacade {
    return this._getEngineFacade();
  }

  /** Read whether the authored scene has unsaved in-memory edits. */
  hasPendingDiskSave(): boolean {
    return this._dirtyReadProvider?.() ?? false;
  }

  /** Bind the persistence-owned dirty read model; returns an idempotent detach. */
  registerDirtyReadProvider(provider: () => boolean): () => void {
    this._dirtyReadProvider = provider;
    return () => {
      if (this._dirtyReadProvider === provider) this._dirtyReadProvider = null;
    };
  }

  /** Read the persistence-owned scene list and identity markers. */
  sceneReadModel(): SceneReadModel {
    return this._sceneReadProvider?.() ?? EMPTY_SCENE_READ_MODEL;
  }

  /** Read every engine-owned SceneInstance in the active world. Synthetic
   * roots are included even when they have no Name component. */
  sceneInstancesReadModel(): readonly SceneInstanceReadModel[] {
    const models: SceneInstanceReadModel[] = [];
    for (const root of sceneInstanceRoots(this.doc.world)) {
      const result = this.sceneInstanceReadModel(root);
      if (result.ok) models.push(result.value);
    }
    return models;
  }

  /** Read one SceneInstance's source, stable local-id mapping, and overrides. */
  sceneInstanceReadModel(root: EntityHandle): SceneInstanceReadResult {
    const state = this._getEngineFacade().getSceneInstanceState(root);
    if (!state.ok) {
      return {
        ok: false,
        error: {
          code: 'SCENE_COLLECT_FAILED',
          hint: `entity ${root} is not a live SceneInstance root`,
          details: { fieldPath: `SceneInstance(${root})`, reason: 'scene-instance-root-required' },
        },
      };
    }
    const sourceHandle = state.value.source as unknown as number;
    const sourceAsset = resolveAssetHandle(
      this.doc.world,
      state.value.source as unknown as Handle<string, 'shared'>,
    );
    if (!sourceAsset.ok) {
      return {
        ok: false,
        error: {
          code: 'ASSET_NOT_FOUND',
          hint: `no SceneAsset source for handle ${sourceHandle}; it may be stale or unloaded`,
        },
      };
    }
    const source = this.summarizeAsset(
      sourceAsset.value,
      this.doc.registry?._guidForAsset(sourceAsset.value),
    );
    const members = [...state.value.entityToLocalId.entries()]
      .map(([entity, localId]) => ({
        entity,
        localId: Number(localId),
        name: entName(this.doc.world, entity),
        detached: state.value.detachedLocalIds.has(localId),
      }))
      .sort((a, b) => a.localId - b.localId);
    const memberByLocalId = new Map(members.map((member) => [member.localId, member.entity]));
    // `overrides` records live edits while `mountTimeOverrides` records the
    // same authored fact after a save/reopen. Merge by semantic key so a
    // reopened instance remains inspectable and revertible without adding a
    // second persistence model in the editor.
    const overrideByKey = new Map<string, SceneInstanceReadModel['overrides'][number]>();
    for (const override of state.value.mountTimeOverrides) {
      const localId = Number(override.localId);
      const member = memberByLocalId.get(localId);
      if (member === undefined) continue;
      const key = `${localId}:${override.comp}:${override.field ?? ''}`;
      overrideByKey.set(key, {
        member,
        localId,
        component: override.comp,
        ...(override.field === undefined ? {} : { field: override.field }),
        value: snapshotSceneInstanceValue(override.value),
      });
    }
    for (const [localId, fields] of state.value.overrides.entries()) {
      for (const override of fields.values()) {
        const localIdNumber = Number(localId);
        const member = memberByLocalId.get(localIdNumber);
        if (member === undefined) continue;
        const key = `${localIdNumber}:${override.comp}:${override.field ?? ''}`;
        overrideByKey.set(key, {
          member,
          localId: localIdNumber,
          component: override.comp,
          ...(override.field === undefined ? {} : { field: override.field }),
          value: snapshotSceneInstanceValue(override.value),
        });
      }
    }
    const overrides = [...overrideByKey.values()]
      .sort((a, b) => a.localId - b.localId || `${a.component}.${a.field ?? ''}`.localeCompare(`${b.component}.${b.field ?? ''}`));
    return {
      ok: true,
      value: {
        root,
        source: {
          handle: sourceHandle,
          kind: source.kind,
          ...(source.guid === undefined ? {} : { guid: source.guid }),
          ...(source.name === undefined ? {} : { name: source.name }),
          ...(source.builtin === undefined ? {} : { builtin: source.builtin }),
          ...(source.meta === undefined ? {} : { meta: snapshotSceneInstanceValue(source.meta) as Record<string, unknown> }),
        },
        members,
        overrides,
      },
    };
  }

  /** Resolve the owning SceneInstance for a live member handle. */
  sceneInstanceForMember(member: EntityHandle): SceneInstanceReadResult {
    for (const root of sceneInstanceRoots(this.doc.world)) {
      const state = this._getEngineFacade().getSceneInstanceState(root);
      if (state.ok && state.value.entityToLocalId.has(member)) return this.sceneInstanceReadModel(root);
    }
    return {
      ok: false,
      error: {
        code: 'SCENE_COLLECT_FAILED',
        hint: `entity ${member} is not a member of a live SceneInstance`,
        details: { fieldPath: `SceneInstance.member(${member})`, reason: 'member-not-in-instance' },
      },
    };
  }

  /** Read the transient selection projection from the selection store.
   *
   * The Gateway is the public read door for eval callers as well as panels. The
   * selection store remains the only owner; this method derives a fresh plain
   * JSON shape so callers cannot mutate its cached Set or infer a second
   * identity namespace.
   */
  selectionReadModel(): SelectionReadModel {
    return {
      primary: getSelection(),
      ids: [...getSelectionList()],
    };
  }

  /** Bind the persistence-owned scene read model; returns an idempotent detach. */
  registerSceneReadProvider(provider: () => SceneReadModel): () => void {
    this._sceneReadProvider = provider;
    return () => {
      if (this._sceneReadProvider === provider) this._sceneReadProvider = null;
    };
  }

  /** Read the persistence-owned scene authoring boundary (Human and AI share it). */
  sceneAuthoringSession(): SceneAuthoringSessionReadModel {
    return this._sceneAuthoringSessionProvider?.() ?? AUTHORED_SCENE_AUTHORING_SESSION;
  }

  registerSceneAuthoringSessionProvider(provider: () => SceneAuthoringSessionReadModel): () => void {
    this._sceneAuthoringSessionProvider = provider;
    return () => {
      if (this._sceneAuthoringSessionProvider === provider) this._sceneAuthoringSessionProvider = null;
    };
  }

  registerCatalogReconcile(provider: CatalogReconcileProvider): () => void {
    this._catalogReconcileProvider = provider;
    return () => {
      if (this._catalogReconcileProvider === provider) this._catalogReconcileProvider = null;
    };
  }

  constructor(doc: EditSession = createEditSession()) {
    this.doc = doc;
    this.registerCatalogReconcile = this.registerCatalogReconcile.bind(this);
  }

  getOperationRun(requestId: string): OperationRun | undefined {
    return this.operationRuns.getRun(requestId);
  }

  getOperationRunResult(requestId: string): OperationRunReadResult {
    return this.operationRuns.getRunResult(requestId);
  }

  waitOperationRun(requestId: string): Promise<OperationRunReadResult> {
    return this.operationRuns.wait(requestId);
  }

  subscribeOperationRun(requestId: string, listener: OperationRunListener): () => void {
    return this.operationRuns.subscribe(requestId, listener);
  }

  /** Subscribe to every Gateway-owned operation run fact, including terminal updates. */
  subscribeOperationRuns(listener: OperationRunListener): () => void {
    return this.operationRuns.subscribeAll(listener);
  }

  /** Read/reconcile the canonical run registry without creating another state map. */
  reconcileOperationRuns(): { readonly ok: true; readonly value: OperationRunSnapshot } {
    return { ok: true, value: this.operationRuns.snapshot() };
  }

  /** Read the retained Gateway-owned runs and their monotonic projection revision. */
  operationRunSnapshot(): OperationRunSnapshot {
    return this.operationRuns.snapshot();
  }

  cancelOperationRun(requestId: string): OperationRunReadResult<never> {
    return this.operationRuns.cancel(requestId);
  }

  retryOperationRun(requestId: string, retryRequestId: string, origin: CommandOrigin = 'human'): DispatchResult {
    const source = this.operationRuns.getRunResult(requestId);
    if (!source.ok) return { ok: false, error: source.error as unknown as CommandError };
    if (source.value.status !== 'failed' || !source.value.retryable) {
      return {
        ok: false,
        error: {
          code: 'operation-not-retryable',
          hint: 'Only a failed retryable operation run can be retried.',
          current: source.value,
        },
      };
    }
    if (source.value.operationId === 'saveDocToDisk') {
      return this.dispatch({ kind: 'saveDocToDisk', requestId: retryRequestId, retryOfRequestId: requestId }, origin);
    }
    if (source.value.input === null || typeof source.value.input !== 'object' || Array.isArray(source.value.input)) {
      return {
        ok: false,
        error: {
          code: 'operation-not-retryable',
          hint: 'The failed operation did not retain replayable input.',
          current: source.value,
        },
      };
    }
    return this.dispatch({
      ...(source.value.input as Record<string, unknown>),
      kind: source.value.operationId,
      requestId: retryRequestId,
      retryOfRequestId: requestId,
    } as EditorOp, origin);
  }

  // ── Executor: build ApplierCtx (plan-strategy §2 D-2) ────────────────────

  /** Build the IoC context for an applier execution.
   *  ctx.engine / ctx.dispatchSub / ctx.query — NO world field (AC-01). */
  private _buildCtx(
    progressReporter?: (progress: RunProgress) => void,
    cancelHandlerRegistrar?: (handler: Parameters<OperationRunRegistry['registerCancelHandler']>[1]) => void,
    origin: CommandOrigin = 'human',
  ): ApplierCtx {
    const engine = this._getEngineFacade();
    // Read-side reader bound to the ACTIVE world (makeQueryFn calls getWorld per
    // query, so a world swap is reflected) — sunk assembly, w10. activeWorld
    // (not doc.world) so `query` reads the play world during ▶ Play, mirroring
    // activeWorld/mode/childrenOf which already Derive from _playWorld (play-world
    // observability: read-side must follow the active-world pointer, not the
    // frozen edit doc — architecture-principles §2 Derive).
    const query: QuerySnapshotFn = makeQueryFn(() => this.activeWorld);
    // dispatchSub: recursive dispatch through the executor — replaces M1's
    // module-level _dispatchDocumentSub for transaction/plan sub-ops.
    // Nested spans are automatically created via _execDocumentApplier.
    const dispatchSub = (_kind: string, sub: EditorOp): ReturnType<ApplierFn> => {
      return this._execDocumentApplier(sub);
    };
    return {
      engine,
      assetIO,
      dispatchSub,
      query,
      origin,
      // Bound to THIS gateway's active world so session appliers (e.g.
      // setAnimationPreview) resolve shared handles without the singleton (M1).
      resolveAsset: (handle: number) => this.resolveAsset(handle),
      ...(progressReporter === undefined
        ? {}
        : {
          operationRun: {
            reportProgress: progressReporter,
            ...(cancelHandlerRegistrar === undefined ? {} : { registerCancelHandler: cancelHandlerRegistrar }),
          },
        }),
    };
  }

  // ── Executor: span-wrapped document applier call ──────────────────────────

  /** Build the DocApplierCtx for document-op execution (F-1 IoC).
   *  engine = the cached EngineFacade (records leaves onto the active span,
   *  AC-09); ids = the session id<->handle map (no world); dispatchSub =
   *  span-pushing recursion through the executor (nested transaction spans).
   *  Type-level this ctx has NO `world` field (AC-01). */
  private _buildDocCtx(alias: DocAliasMap): DocApplierCtx {
    const engine = this._getEngineFacade() as unknown as EngineWriteProxy;
    const ctx: DocApplierCtx = {
      engine,
      // Asset write gate (north-star §2 axis symmetry): document appliers such as
      // destroyAsset reach the pack IO through this, never the raw pack-ops API.
      assetIO,
      // M3 (I1): the transaction-scoped placeholder alias (replaces the deleted
      // legacy id-to-handle map). One map threads through a whole top-level
      // dispatch so a transaction's forward-references (spawn then reparent under
      // it) resolve.
      alias,
      // Span-pushing sub-dispatch: a transaction sub-op first receives the same
      // gateway-owned preparation as top-level dispatch (notably duplicate's
      // SceneAsset collection), then recurses through the executor. Each sub-op
      // therefore gets its own child span + engine leaves; the SAME alias map
      // keeps forward-reference placeholders resolvable across the transaction.
      dispatchSub: (_ctx, sub) => {
        const prepared = this._prepareDocumentCommand(sub);
        return prepared.ok ? this._execDocumentApplier(sub, alias) : prepared;
      },
      // Read side: same query-snapshot the session/eval ctx exposes (D-2 ctx
      // contract, t12a). Document appliers don't read it, but it is part of the
      // ctx shape and available for defined document ops that might. Sunk
      // assembly via makeQueryFn (w10); DocQueryFn's structural (desc:unknown)
      // shape widens the io QuerySnapshotFn — cast at the boundary as before.
      // activeWorld (not doc.world) so a defined document op's plan reads the
      // active world consistently with the eval/session query (play-world read).
      query: makeQueryFn(() => this.activeWorld) as unknown as DocApplierCtx['query'],
    };
    return ctx;
  }

  /**
   * Prepare a document command whose gateway contract includes a live read before
   * its applier can write. This runs at the shared executor entrance — rather than
   * only top-level dispatch — so a transaction's nested `duplicateEntity` command
   * has the exact same public semantics as a direct duplicate (solo round-27 P9).
   * The preparation is idempotent: a replay command already carries `_asset`, so
   * redo never re-collects a source that may have changed or been deleted.
   */
  private _prepareDocumentCommand(cmd: EditorOp): { ok: true } | { ok: false; error: CommandError } {
    if (cmd.kind === 'destroyAsset') {
      const destroy = cmd as Extract<EditorOp, { kind: 'destroyAsset' }>;
      if (destroy._resolvedPackPath !== undefined) return { ok: true };
      const row = this.assetCatalog().find(
        (entry) => entry.guid.toLowerCase() === destroy.guid.toLowerCase(),
      );
      const storagePath = row === undefined ? null : catalogStoragePath(row);
      if (storagePath === null) {
        return {
          ok: false,
          error: {
            code: 'ASSET_NOT_FOUND',
            hint: `destroyAsset could not derive writable storage for catalog GUID ${destroy.guid}. Refresh the active game catalog before retrying.`,
            current: row ?? null,
            recoveryActions: ['editor.requestReimport', 'request.retry'],
          },
        };
      }
      destroy._resolvedPackPath = storagePath;
      return { ok: true };
    }
    if (cmd.kind !== 'duplicateEntity') return { ok: true };

    const duplicate = cmd as Extract<EditorOp, { kind: 'duplicateEntity' }>;
    if (typeof duplicate.entity !== 'number') {
      return {
        ok: false,
        error: { code: 'INVALID_ARGS', hint: 'duplicateEntity requires an entity handle' },
      };
    }
    if (duplicate._asset !== undefined) return { ok: true };

    const source = duplicate.entity as EntityHandle;
    const collected = this.collectSceneAsset(source);
    if (!collected.ok) return collected;
    duplicate._asset = collected.asset;
    if (duplicate.parent === undefined) duplicate.parent = entParent(this.activeWorld, source);
    const sourceName = entName(this.activeWorld, source);
    if (duplicate.name === undefined) duplicate.name = `${sourceName} copy`;
    if (duplicate.label === undefined) duplicate.label = `duplicate ${sourceName}`;
    return { ok: true };
  }

  /** Project ordinary component writes onto the engine-owned mount override
   *  operation. This keeps the public setComponent door symmetric for human UI
   *  and AI callers, including grouped array fields such as AnimationPlayer's
   *  clips/times/weights/speeds columns. */
  private _projectMountMemberMutation(cmd: EditorOp): EditorOp {
    if (cmd.kind === 'transaction') {
      const transaction = cmd as { kind: 'transaction'; label: string; commands: EditorOp[] };
      const commands = transaction.commands.map((sub) => this._projectMountMemberMutation(sub));
      return { ...transaction, commands };
    }
    if (cmd.kind !== 'setComponent' || typeof cmd.entity !== 'number' || typeof cmd.patch !== 'object' || cmd.patch === null || Array.isArray(cmd.patch)) {
      return cmd;
    }
    const set = cmd as { kind: 'setComponent'; entity: number; component: string; patch: Record<string, unknown> };
    const instance = this.sceneInstanceForMember(set.entity as EntityHandle);
    if (!instance.ok) return cmd;
    const commands: EditorOp[] = [];
    for (const [field, value] of Object.entries(set.patch)) {
      commands.push({
        kind: 'setSceneOverride',
        root: instance.value.root,
        member: set.entity,
        component: set.component,
        field,
        value,
      });
    }
    if (commands.length === 0) return cmd;
    return commands.length === 1
      ? commands[0]!
      : { kind: 'transaction', label: `override ${set.component} ×${commands.length}`, commands };
  }

  /** Edit-time capability collar for derived SceneInstance members. */
  private _validateMountMemberEdit(cmd: EditorOp): { ok: true } | { ok: false; error: CommandError } {
    if (cmd.kind === 'transaction') {
      for (const sub of (cmd as Extract<EditorOp, { kind: 'transaction' }>).commands) {
        const result = this._validateMountMemberEdit(sub);
        if (!result.ok) return result;
      }
      return { ok: true };
    }
    const entity = (cmd as { entity?: unknown }).entity;
    if (typeof entity !== 'number' || !this._isMountMember(entity as EntityHandle)) return { ok: true };
    let reason: string | null = null;
    if (cmd.kind === 'removeComponent') reason = 'Removing a component from a mount member cannot round-trip in mount overrides.';
    else if (cmd.kind === 'destroyEntity') reason = 'Destroying an imported mount member cannot round-trip in mount overrides.';
    else if (cmd.kind === 'reparent') reason = 'Reparenting an imported mount member cannot round-trip in mount overrides.';
    else if (cmd.kind === 'setComponent') {
      const set = cmd as Extract<EditorOp, { kind: 'setComponent' }>;
      const token = resolveComponent(set.component);
      const schema = token?.schema as Record<string, string> | undefined;
      if (Object.keys(set.patch).some((field) => schema?.[field]?.includes('entity'))) {
        reason = 'Entity-reference patches on mount members cannot round-trip in mount overrides.';
      }
    }
    if (reason === null) return { ok: true };
    return {
      ok: false,
      error: {
        code: 'mount-member-operation-unsupported',
        hint: reason,
        current: { entity, operation: cmd.kind, policy: 'component-add-and-field-patch-only' },
        recoveryActions: ['promoteImportedScene'],
      },
    };
  }

  private _isMountMember(entity: EntityHandle): boolean {
    const world = this.doc.world as unknown as {
      getSceneInstanceState(root: EntityHandle): {
        ok: boolean;
        value?: { entityToLocalId: Map<EntityHandle, unknown> };
      };
    };
    if (!world || typeof world.getSceneInstanceState !== 'function') return false;
    for (const candidate of worldEntityHandles(this.doc.world)) {
      const state = world.getSceneInstanceState(candidate);
      if (state.ok && state.value?.entityToLocalId.has(entity)) return true;
    }
    return false;
  }

  /** Execute a document applier through the executor: prepare → build DocApplierCtx
   *  → pushSpan → call applier(ctx, cmd) → popSpan. Used by dispatch (and, via
   *  ctx.dispatchSub, by transaction sub-ops). The applier receives a DocApplierCtx
   *  whose only world access is the controlled `engine` proxy — no raw world or
   *  EditSession (AC-01 / D-2). Every write records its engine interface leaf on
   *  the active span (AC-09). */
  private _execDocumentApplier(cmd: EditorOp, alias: DocAliasMap = new Map()): ReturnType<ApplierFn> {
    const kind = cmd.kind;
    const applier = applierFor(kind, 'document');
    if (!applier) {
      return { ok: false, error: { code: 'UNKNOWN_OP' as const, hint: `applier not found for "${kind}"` } };
    }
    const ctx = this._buildDocCtx(alias);
    pushSpan(kind);
    // Document appliers are (ctx, cmd) => ApplyResult. The registered ApplierFn
    // type is intentionally loose (session: unknown) so a single table can hold
    // both document and defineOp document appliers — the concrete applier bodies
    // are typed against DocApplierCtx (that is where the AC-01 no-world guard
    // lives). Pass the ctx as the first arg.
    const r = applier(ctx as unknown as EditSession, cmd);
    if (!r.ok) {
      popSpan('ERROR');
    } else {
      popSpan('OK');
    }
    return r;
  }

  /**
  * The public failure envelope is completed at this single Gateway boundary.
  * Appliers remain domain owners of their stable codes and causal details;
  * callers never need to parse a hint to recover operation context.
  */
  dispatch(cmd: EditorOp, origin: CommandOrigin = 'human'): DispatchResult {
    const result: DispatchResult = (() => {
      const requestedKind = cmd.kind;

    // Scan-lock guard: during startup scan, reject all dispatch until catalog is ready.
    // This is an infrastructure guard (not an op), matching the north-star §8 principle
    // that scan is a pre-condition phase before the editor is usable.
    if (this._scanLocked) {
      return { ok: false, error: { code: 'scan-in-progress', hint: 'Asset scan is in progress; edits are blocked until catalog is ready.' } };
    }

    if (requestedKind === 'catalog.reconcile') return this._dispatchCatalogReconcile(cmd, origin);

    // Three-tier routing: the DOMAIN of an op = which applier table registers its
    // kind (plan-strategy §2 D-1, structural, no bypassable label). Unregistered
    // kind → UNKNOWN_OP (Fail Fast; headless play/stop lands here — D-11).
    const domain = domainOf(requestedKind);
    if (domain === null) {
      // D-11: play/stop are session ops whose applier is registered by
      // edit-runtime at boot (registerSessionApplier). In headless core they are
      // legitimately absent — say so instead of a generic miss, so a headless AI
      // caller learns it is a boot-registered capability, not a typo.
      const hint = (requestedKind === 'play' || requestedKind === 'stop')
        ? `op "${requestedKind}" has no applier registered; edit-runtime registers it at boot via registerSessionApplier (D-11) — unavailable in headless core`
        : `no applier registered for "${requestedKind}"; see listOps()`;
      return { ok: false, error: { code: 'UNKNOWN_OP', hint } };
    }

    // The public document command is the single semantic door for both UI and
    // AI. A mount member cannot be authored through a plain world.set: the
    // engine only persists that edit when it enters setSceneOverride. Project
    // here so headless AI dispatches and the Inspector's existing projection
    // converge on the same document applier and ledger shape.
    if (domain === 'document') cmd = this._projectMountMemberMutation(cmd);
    const kind = cmd.kind;

    if (domain === 'document') {
      if (this.sceneAuthoringSession().mode === 'imported-preview') {
        return {
          ok: false,
          error: {
            code: 'edit-rejected-in-imported-preview',
            hint: 'Imported scene previews are read-only.',
            recoveryActions: ['addSceneAssetToScene', 'promoteImportedScene'],
            current: this.sceneAuthoringSession(),
          },
        };
      }
      // ── Play-mode write gate (plan-strategy D-5, M2) ──────────────────────
      // While in play mode the active data is a read-only simulation view. A
      // document-domain op WRITES the world; applying it would either mutate the
      // frozen edit world (breaking the AC-07 snapshot) or the play world
      // (creating an "edited in play, gone on stop" Edit != Play illusion). Reject
      // at the single gateway door — a UI-disable would not stop an AI caller who
      // reaches dispatch directly (research Finding 13). session-domain ops
      // (play/stop/selection/camera) are how the user LEAVES play, so they fall
      // through this branch untouched. transientMode is NOT reused for this: its
      // semantics are "apply + emit, skip undo/ledger" — it still writes, which is
      // orthogonal to the play freeze (D-5 explicit).
      if (this.mode === 'play') {
        return {
          ok: false,
          error: {
            code: 'edit-rejected-in-play',
            hint: 'stop play mode before editing; play data is a read-only simulation view',
            retryable: true,
            recoveryActions: ['stop', 'run.retry'],
          },
        };
      }
      // Entry args validation for ALL catalogued document ops (Fail Fast §5 /
      // Schema-as-Contract §3), the SAME door-validation session/transient ops get
      // below. Previously this was gated on `source==='defined'`, on the belief
      // (stated in a since-deleted comment) that "builtin document ops are validated
      // field-by-field inside applyCommand" — that was FALSE: e.g. applySetComponent
      // does `Object.keys(cmd.patch)` with no guard, so a missing/null `patch`
      // THREW a raw `TypeError: Cannot convert undefined or null to object` through
      // the gateway, which promises a structured `{ok:false,error}` for all bad
      // input (solo round-14). The catalog ALREADY declares each op's argsSchema
      // (e.g. setComponent.required:['entity','component','patch']) and validateArgs
      // ALREADY exists — only the wiring skipped builtins. Validating every doc op
      // with an argsSchema here (defined + builtin, uniform with the other two
      // domains) turns those crashes into a loud, catchable INVALID_ARGS and closes
      // the whole class (every builtin doc op reading a required field unguarded).
      // The applier stays defended too (applySetComponent guards `patch`) because
      // ctx.dispatchSub (transaction sub-ops) and begin() bypass THIS door.
      const docDescriptor = getOp(kind);
      if (docDescriptor?.argsSchema) {
        const v = validateArgs(docDescriptor.argsSchema, cmd);
        if (!v.ok) {
          const first = v.errors[0];
          const hint = `invalid args for "${kind}": ${first ? `${first.path}: ${first.message}` : 'schema validation failed'}`;
          return { ok: false, error: { code: 'INVALID_ARGS', hint } };
        }
      }
      // destroyEntity: pre-collect a scene-asset snapshot so undo can restore
      // materials via GUID round-trip (instantiateSceneAsset). Collection runs
      // before the applier despawns while the entity tree remains live. For
      // multi-delete the commands arrive wrapped in a transaction, so pre-fill
      // each direct destroy sub-op before the applier iterates them.
      if (kind === 'destroyEntity') {
        this._preCollectDestroyAsset(cmd as Extract<EditorOp, { kind: 'destroyEntity' }>);
      }
      if (kind === 'transaction') {
        for (const sub of (cmd as Extract<EditorOp, { kind: 'transaction' }>).commands) {
          if (sub.kind === 'destroyEntity') {
            this._preCollectDestroyAsset(sub as Extract<EditorOp, { kind: 'destroyEntity' }>);
          }
        }
      }

      // updateMaterialParams: gateway-fill _oldPatch / _oldRefs / _oldEntry from
      // the synchronous assetCatalog so the applier can construct a correct inverse
      // and write the updated entry. Same gateway-fill pattern as destroyEntity._asset.
      if (kind === 'updateMaterialParams') {
        this._preFillMaterialOp(cmd as { kind: 'updateMaterialParams'; guid: string; _oldPatch?: unknown; _oldRefs?: unknown; _oldEntry?: unknown; [k: string]: unknown });
      }
      // Material Instance mutators: fill `_oldEntry` (+ optional parent-chain catalog
      // stubs for cycle detection) from the live asset catalog.
      if (
        kind === 'saveMaterialInstance'
        || kind === 'saveInputMap'
        || kind === 'setMaterialInstanceParent'
        || kind === 'setMaterialInstanceOverride'
        || kind === 'setMaterialInstanceLightmass'
      ) {
        this._preFillMaterialInstanceOp(cmd as {
          guid: string;
          parentGuid?: string;
          _oldEntry?: unknown;
          _catalogEntries?: unknown[];
          [k: string]: unknown;
        });
      }

      // Prepare this public document command before the executor writes. Nested
      // transaction duplicates pass through the same helper in dispatchSub above.
      const prepared = this._prepareDocumentCommand(cmd);
      if (!prepared.ok) return prepared;
      const mountPolicy = this._validateMountMemberEdit(cmd);
      if (!mountPolicy.ok) return mountPolicy;
      const r = this._execDocumentApplier(cmd);
      if (!r.ok) return r;
      // transientMode (play·scene): still apply + emit for immediate feedback,
      // but skip undo/ledger writes (AC-09) — the non-committing edit mode.
      if (!this.transientMode && !this.deferHistory) {
        this.undoStack.push({ cmd, inverse: r.inverse, origin });
        this.redoStack.length = 0;
        this.ledger.push(cmd);
        this.origins.push(origin);
      } else if (!this.transientMode && this.deferHistory) {
        this.deferredEntry = { cmd, inverse: r.inverse, origin };
      }
      // emit() fires the bus subscribers (docVersion re-render + _isDirty tracker
      // + engine sync repaint) — the World changed, so panels/disk must react.
      this.emit(cmd);
      // Surface the new roots the applier produced (spawn/instantiate/duplicate/
      // transaction) so the caller learns what it just made without re-reading cmd.
      return { ok: true, result: { created: r.created } };
    }

    // F-4: entry args validation (boundary #8 / D-7 Fail Fast). Document ops are
    // validated inside applyCommand (entity/field checks); session/transient ops
    // reach a hand-written applier that trusts its op shape, so validate their
    // args against the catalog argsSchema HERE — before the applier runs — and
    // return a structured INVALID_ARGS on mismatch instead of letting a malformed
    // op (e.g. setSelection with no id) pollute the store's state silently. Ops
    // with no catalog descriptor or a null argsSchema (requestFrame, play/stop,
    // downstream-registered seams) skip validation.
    const descriptor = getOp(kind);
    if (descriptor?.argsSchema) {
      const v = validateArgs(descriptor.argsSchema, cmd);
      if (!v.ok) {
        const first = v.errors[0];
        const hint = `invalid args for "${kind}": ${first ? `${first.path}: ${first.message}` : 'schema validation failed'}`;
        return { ok: false, error: { code: 'INVALID_ARGS', hint } };
      }
    }

    if (kind === 'saveAssetSourceOverride') {
      const sourceOverride = cmd as Extract<EditorOp, { kind: 'saveAssetSourceOverride' }>;
      if (!('sourceKey' in sourceOverride.scope)) {
        return {
          ok: false,
          error: {
            code: 'INVALID_ARGS',
            hint: 'saveAssetSourceOverride requires scope.sourceKey so one producer payload schema can be selected.',
            recoveryActions: ['asset.preflight'],
          },
        };
      }
      const catalogFacts = this.assetCatalog() as readonly (ReturnType<AssetRegistry['listCatalog']>[number] & {
        readonly sourceOverrideDescriptors?: CatalogEntry['sourceOverrideDescriptors'];
      })[];
      const payloadSchema = catalogFacts
        .filter((asset) => asset.guid.toLowerCase() === sourceOverride.guid.toLowerCase())
        .flatMap((asset) => asset.sourceOverrideDescriptors ?? [])
        .find((entry) => entry.sourceKey === sourceOverride.scope.sourceKey)
        ?.payloadSchema;
      if (payloadSchema === null || typeof payloadSchema !== 'object' || Array.isArray(payloadSchema)) {
        return {
          ok: false,
          error: {
            code: 'INVALID_ARGS',
            hint: `No producer payload schema is published for sourceKey "${sourceOverride.scope.sourceKey}".`,
            recoveryActions: ['asset.preflight', 'catalog.reconcile'],
          },
        };
      }
      const payloadValidation = validateArgs(payloadSchema as ArgsSchema, sourceOverride.override);
      if (!payloadValidation.ok) {
        const first = payloadValidation.errors[0];
        return {
          ok: false,
          error: {
            code: 'INVALID_ARGS',
            hint: `invalid producer override for "${sourceOverride.scope.sourceKey}": ${first ? `${first.path}: ${first.message}` : 'schema validation failed'}`,
            recoveryActions: ['asset.preflight'],
          },
        };
      }
    }

    if (kind === 'promoteImportedScene') {
      const promote = cmd as {
        importedGuid: string;
        sourceKey: string;
        revision: string;
      };
      const catalogAsset = this.assetCatalog().find((asset) =>
        asset.guid.toLowerCase() === promote.importedGuid.toLowerCase()
      );
      const activation = catalogAsset === undefined
        ? null
        : describeSceneActivation(
            {
              guid: catalogAsset.guid,
              kind: catalogAsset.kind,
              packageUrl: catalogAsset.packageUrl,
              ...(catalogAsset.sourcePath === undefined ? {} : { sourcePath: catalogAsset.sourcePath }),
              ...(catalogAsset.sourceKey === undefined ? {} : { sourceKey: catalogAsset.sourceKey }),
              revision: promote.revision,
              ...(catalogAsset.authoring === undefined ? {} : { authoring: catalogAsset.authoring }),
            },
            this.sceneReadModel().scenes.map((scene) => ({ id: scene.id, guid: scene.guid })),
            promote.revision,
          );
      if (activation?.canPromote !== true || activation.provenance !== 'imported-output') {
        return {
          ok: false,
          error: {
            code: 'promote-capability-unavailable',
            hint: 'The current catalog descriptor does not publish canPromote for this imported scene.',
            current: activation,
            recoveryActions: ['previewImportedScene'],
          },
        };
      }
      const sessionIdentity = this.sceneAuthoringSession().imported;
      if (sessionIdentity === undefined
        || sessionIdentity.guid.toLowerCase() !== promote.importedGuid.toLowerCase()
        || sessionIdentity.sourceKey !== promote.sourceKey
        || sessionIdentity.revision !== promote.revision) {
        return {
          ok: false,
          error: {
            code: 'promote-session-mismatch',
            hint: 'Promote requires the same imported GUID, sourceKey, and revision as the active imported session.',
            expected: promote,
            current: sessionIdentity ?? this.sceneAuthoringSession(),
            recoveryActions: ['previewImportedScene'],
          },
        };
      }
    }

    if (kind === 'saveDocToDisk' && this.sceneAuthoringSession().mode !== 'authored') {
      return {
        ok: false,
        error: {
          code: 'save-rejected-in-imported-preview',
          hint: 'Imported scene previews have no authored save target; source editing is unavailable with the current Engine.',
          recoveryActions: ['addSceneAssetToScene', 'promoteImportedScene'],
          current: this.sceneAuthoringSession(),
        },
      };
    }

    // Session / transient ops: executor builds ctx → pushes span → calls applier.
    // M3 t20d (D-12): the ctx is passed as the SECOND arg (applier(op, ctx)) so a
    // session applier can move the engine world through ctx.engine — cameraOrbit's
    // applier is the ONLY camera-move path when an AI drives it over eval (no
    // per-frame facade write). Existing session appliers keep their (op) signature
    // and simply ignore the extra arg (backward compatible — SessionApplier's ctx
    // param is optional). Op stays the first arg (unchanged from M1/M2).
    const applier = applierFor(kind, domain);
    if (!applier) return { ok: false, error: { code: 'UNKNOWN_OP', hint: `applier not found for "${kind}"` } };

    const operationRunContract = this.listOps().find((descriptor) => descriptor.id === kind)?.operationRun;
    const requestId = operationRunContract === undefined
      ? undefined
      : (cmd as { readonly requestId?: unknown }).requestId;
    const isRequestCorrelatedSave = kind === 'saveDocToDisk' && typeof requestId === 'string';
    const isRequestCorrelatedDelete = kind === 'deleteSourceFile' && typeof requestId === 'string';
    const isRequestCorrelatedImport = (kind === 'importAsset' || kind === 'reimportAsset') && typeof requestId === 'string';
    const isRequestCorrelatedSceneActivation = (kind === 'addSceneAssetToScene' || kind === 'previewImportedScene' || kind === 'promoteImportedScene') && typeof requestId === 'string';
    const isRequestCorrelatedBind = kind === 'bindAssetRef' && typeof requestId === 'string';
    const isRequestCorrelatedSceneSwitch = kind === 'switchSceneFile' && typeof requestId === 'string';
    const isRequestCorrelatedSceneCreate = kind === 'createSceneFile' && typeof requestId === 'string';
    const isRequestCorrelatedDefaultScene = kind === 'setDefaultScene' && typeof requestId === 'string';
    const isRequestCorrelatedSceneDelete = kind === 'deleteScene' && typeof requestId === 'string';
    const isRequestCorrelatedCapture = kind === 'captureFrame' && typeof requestId === 'string';
    const isRequestCorrelatedValidation = kind === 'validateGameProject' && typeof requestId === 'string';
    const isRequestCorrelatedSource = (kind === 'asset.preflight' || kind === 'previewAssetSourceMutation' || kind === 'saveAssetSourceOverride' || kind === 'discardSourceOverridesAndReimport') && typeof requestId === 'string';
    let acceptedRun: OperationRunReadResult | null = null;
    if (isRequestCorrelatedSave) {
      const saveRequestId = requestId as string;
      const retryOfRequestId = (cmd as { readonly retryOfRequestId?: unknown }).retryOfRequestId;
      const actor = origin === 'ai'
        ? { id: 'ai', kind: 'ai' as const }
        : { id: 'human', kind: 'human' as const };
      const retrySource = typeof retryOfRequestId === 'string'
        ? this.operationRuns.getRunResult(retryOfRequestId)
        : null;
      if (retrySource !== null && !retrySource.ok) {
        return { ok: false, error: retrySource.error as unknown as CommandError };
      }
      if (retrySource !== null && (retrySource.value.status !== 'failed' || !retrySource.value.retryable)) {
        return {
          ok: false,
          error: {
            code: 'operation-not-retryable',
            hint: 'Only a failed save run can be retried.',
            current: retrySource.value,
          },
        };
      }
      const retryOptions = retrySource === null ? {} : {
        parentRunId: retrySource.value.runId,
        attempt: retrySource.value.attempt + 1,
      };
      const accepted = this.operationRuns.acceptSave(saveRequestId, { ...cmd }, actor, retryOptions);
      if (!accepted.ok) return { ok: false, error: accepted.error as unknown as CommandError };
      if (accepted.reused) {
        return { ok: true, result: { created: [], operationRun: accepted.run } };
      }
      acceptedRun = { ok: true, value: accepted.run };
    } else if (isRequestCorrelatedDelete) {
      const actor = origin === 'ai'
        ? { id: 'ai', kind: 'ai' as const }
        : { id: 'human', kind: 'human' as const };
      const accepted = this.operationRuns.acceptOperation(requestId as string, { ...cmd }, actor, {
        operationId: kind,
        cancellable: false,
        retryable: false,
      });
      if (!accepted.ok) return { ok: false, error: accepted.error as unknown as CommandError };
      if (accepted.reused) {
        return { ok: true, result: { created: [], operationRun: accepted.run } };
      }
      acceptedRun = { ok: true, value: accepted.run };
    } else if (isRequestCorrelatedImport) {
      const actor = origin === 'ai'
        ? { id: 'ai', kind: 'ai' as const }
        : { id: 'human', kind: 'human' as const };
      const retryOfRequestId = (cmd as { readonly retryOfRequestId?: unknown }).retryOfRequestId;
      const retrySource = typeof retryOfRequestId === 'string'
        ? this.operationRuns.getRunResult(retryOfRequestId)
        : null;
      if (retrySource !== null && !retrySource.ok) {
        return { ok: false, error: retrySource.error as unknown as CommandError };
      }
      if (retrySource !== null && (retrySource.value.status !== 'failed' || !retrySource.value.retryable)) {
        return {
          ok: false,
          error: {
            code: 'operation-not-retryable',
            hint: 'Only a failed retryable operation run can be retried.',
            current: retrySource.value,
          },
        };
      }
      const accepted = this.operationRuns.acceptOperation(requestId as string, { ...retainedCommand(cmd) }, actor, {
        operationId: kind,
        cancellable: true,
        retryable: true,
        ...(retrySource === null ? {} : {
          parentRunId: retrySource.value.runId,
          attempt: retrySource.value.attempt + 1,
        }),
      });
      if (!accepted.ok) return { ok: false, error: accepted.error as unknown as CommandError };
      if (accepted.reused) {
        return { ok: true, result: { created: [], operationRun: accepted.run } };
      }
      acceptedRun = { ok: true, value: accepted.run };
    } else if (isRequestCorrelatedSceneActivation) {
      const actor = origin === 'ai'
        ? { id: 'ai', kind: 'ai' as const }
        : { id: 'human', kind: 'human' as const };
      const accepted = this.operationRuns.acceptOperation(requestId as string, { ...cmd }, actor, {
        operationId: kind,
        cancellable: false,
        retryable: false,
      });
      if (!accepted.ok) return { ok: false, error: accepted.error as unknown as CommandError };
      if (accepted.reused) {
        return { ok: true, result: { created: [], operationRun: accepted.run } };
      }
      acceptedRun = { ok: true, value: accepted.run };
    } else if (isRequestCorrelatedBind) {
      const actor = origin === 'ai'
        ? { id: 'ai', kind: 'ai' as const }
        : { id: 'human', kind: 'human' as const };
      const accepted = this.operationRuns.acceptOperation(requestId as string, { ...cmd }, actor, {
        operationId: kind,
        cancellable: false,
        retryable: false,
      });
      if (!accepted.ok) return { ok: false, error: accepted.error as unknown as CommandError };
      if (accepted.reused) {
        return { ok: true, result: { created: [], operationRun: accepted.run } };
      }
      acceptedRun = { ok: true, value: accepted.run };
    } else if (isRequestCorrelatedSceneSwitch || isRequestCorrelatedSceneCreate || isRequestCorrelatedDefaultScene || isRequestCorrelatedSceneDelete) {
      const actor = origin === 'ai'
        ? { id: 'ai', kind: 'ai' as const }
        : { id: 'human', kind: 'human' as const };
      const retryOfRequestId = (cmd as { readonly retryOfRequestId?: unknown }).retryOfRequestId;
      const retrySource = typeof retryOfRequestId === 'string'
        ? this.operationRuns.getRunResult(retryOfRequestId)
        : null;
      if (retrySource !== null && !retrySource.ok) {
        return { ok: false, error: retrySource.error as unknown as CommandError };
      }
      if (retrySource !== null && (retrySource.value.status !== 'failed' || !retrySource.value.retryable)) {
        return {
          ok: false,
          error: {
            code: 'operation-not-retryable',
            hint: `Only a failed retryable ${kind} run can be retried.`,
            current: retrySource.value,
          },
        };
      }
      const accepted = this.operationRuns.acceptOperation(requestId as string, { ...cmd }, actor, {
        operationId: kind,
        cancellable: false,
        retryable: true,
        ...(retrySource === null ? {} : {
          parentRunId: retrySource.value.runId,
          attempt: retrySource.value.attempt + 1,
        }),
      });
      if (!accepted.ok) return { ok: false, error: accepted.error as unknown as CommandError };
      if (accepted.reused) {
        return { ok: true, result: { created: [], operationRun: accepted.run } };
      }
      acceptedRun = { ok: true, value: accepted.run };
    } else if (isRequestCorrelatedCapture) {
      const actor = origin === 'ai'
        ? { id: 'ai', kind: 'ai' as const }
        : { id: 'human', kind: 'human' as const };
      const retryOfRequestId = (cmd as { readonly retryOfRequestId?: unknown }).retryOfRequestId;
      const retrySource = typeof retryOfRequestId === 'string'
        ? this.operationRuns.getRunResult(retryOfRequestId)
        : null;
      if (retrySource !== null && !retrySource.ok) {
        return { ok: false, error: retrySource.error as unknown as CommandError };
      }
      if (retrySource !== null && (retrySource.value.status !== 'failed' || !retrySource.value.retryable)) {
        return {
          ok: false,
          error: {
            code: 'operation-not-retryable',
            hint: 'Only a failed retryable capture run can be retried.',
            current: retrySource.value,
          },
        };
      }
      const accepted = this.operationRuns.acceptOperation(requestId as string, { ...cmd }, actor, {
        operationId: kind,
        cancellable: false,
        retryable: true,
        ...(retrySource === null ? {} : {
          parentRunId: retrySource.value.runId,
          attempt: retrySource.value.attempt + 1,
        }),
      });
      if (!accepted.ok) return { ok: false, error: accepted.error as unknown as CommandError };
      if (accepted.reused) {
        return { ok: true, result: { created: [], operationRun: accepted.run } };
      }
      acceptedRun = { ok: true, value: accepted.run };
    } else if (isRequestCorrelatedValidation) {
      const retryOfRequestId = (cmd as { readonly retryOfRequestId?: unknown }).retryOfRequestId;
      const accepted = acceptOperationRun({
        registry: this.operationRuns,
        command: cmd,
        origin,
        operationId: kind,
        requestId: requestId as string,
        cancellable: false,
        retryable: true,
        ...(typeof retryOfRequestId === 'string' ? { retryOfRequestId } : {}),
      });
      if (!accepted.ok) return { ok: false, error: accepted.error as unknown as CommandError };
      if (accepted.reused) return { ok: true, result: { created: [], operationRun: accepted.run } };
      acceptedRun = { ok: true, value: accepted.run };
    } else if (isRequestCorrelatedSource) {
      const retryOfRequestId = (cmd as { readonly retryOfRequestId?: unknown }).retryOfRequestId;
      const accepted = acceptOperationRun({
        registry: this.operationRuns,
        command: cmd,
        origin,
        operationId: kind,
        requestId: requestId as string,
        cancellable: kind !== 'previewAssetSourceMutation' && kind !== 'asset.preflight',
        retryable: true,
        ...(typeof retryOfRequestId === 'string' ? { retryOfRequestId } : {}),
      });
      if (!accepted.ok) return { ok: false, error: accepted.error as unknown as CommandError };
      if (accepted.reused) return { ok: true, result: { created: [], operationRun: accepted.run } };
      acceptedRun = { ok: true, value: accepted.run };
    } else if (operationRunContract !== undefined && typeof requestId === 'string') {
      // Dynamic Runtime-owned operations use the same cataloged lifecycle as
      // builtins. Their applier completion is bound below; this branch avoids a
      // second Shell journal and prevents async preview work from appearing
      // terminal at dispatch acceptance.
      const retryOfRequestId = (cmd as { readonly retryOfRequestId?: unknown }).retryOfRequestId;
      const accepted = acceptOperationRun({
        registry: this.operationRuns,
        command: cmd,
        origin,
        operationId: kind,
        requestId,
        cancellable: operationRunContract.cancellable,
        retryable: true,
        ...(typeof retryOfRequestId === 'string' ? { retryOfRequestId } : {}),
      });
      if (!accepted.ok) return { ok: false, error: accepted.error as unknown as CommandError };
      if (accepted.reused) return { ok: true, result: { created: [], operationRun: accepted.run } };
      acceptedRun = { ok: true, value: accepted.run };
    }

    const progressReporter = acceptedRun === null
      ? undefined
      : (progress: RunProgress) => {
        this.operationRuns.reportProgress(acceptedRun.value.runId, progress);
      };
    const cancelHandlerRegistrar = acceptedRun === null
      ? undefined
      : (handler: Parameters<OperationRunRegistry['registerCancelHandler']>[1]) => {
        this.operationRuns.registerCancelHandler(acceptedRun.value.runId, handler);
      };
    let runningRun: OperationRun | undefined;
    if (acceptedRun !== null) {
      const running = this.operationRuns.markRunning(acceptedRun.value.runId);
      if (!running.ok) return { ok: false, error: running.error as unknown as CommandError };
      runningRun = running.value;
    }
    const ctx = this._buildCtx(progressReporter, cancelHandlerRegistrar, origin);
    pushSpan(kind);
    const sResult = applier(cmd, ctx);
    const sOk = sResult.ok;
    popSpan(sOk ? 'OK' : 'ERROR');
    if (!sOk) {
      if (acceptedRun !== null) this.operationRuns.fail(acceptedRun.value.runId, sResult.error as unknown as import('@forgeax/editor-product').CommandError);
      return sResult;
    }

    if (acceptedRun !== null) {
      if (sResult.completion !== undefined) {
        const completion = isRequestCorrelatedImport
          ? sResult.completion.then((value) => {
            const envelope = value as { readonly ok?: unknown; readonly result?: unknown };
            if (envelope.ok !== true || envelope.result === undefined || typeof envelope.result !== 'object' || envelope.result === null) return value;
            const imported = envelope.result as { readonly status?: unknown; readonly guid?: unknown; readonly subAssets?: readonly { readonly guid?: unknown }[] };
            if (imported.status !== 'done') return value;
            const assetGuid: string | undefined = typeof imported.guid === 'string'
              ? imported.guid
              : imported.subAssets?.find((asset) => typeof asset.guid === 'string')?.guid as string | undefined;
            if (assetGuid === undefined) return value;
            const catalogAsset = this.assetCatalog().find((asset) => asset.guid === assetGuid);
            const runtimeReadiness = createRuntimeReadiness({
              state: 'committed-awaiting-reload',
              requestId: requestId as string,
              assetGuid,
              committedRevision: catalogAsset?.revision ?? null,
              residentRevision: null,
              hint: 'Stop and Play to load the committed revision.',
            });
            return { ok: true, result: { ...imported, runtimeReadiness } };
          })
          : sResult.completion;
        this.operationRuns.bindCompletion(acceptedRun.value.runId, completion, (run) => {
          if (run.status !== 'succeeded' || this.transientMode || domain !== 'session') return;
          this.ledger.push(retainedCommand(cmd));
          this.origins.push(origin);
          this.emitDiagnostics();
        });
      }
      return { ok: true, result: { created: [], operationRun: runningRun } };
    }

    // Ledger-only middle tier (plan-strategy §2 D-1): session ops append to the
    // flat append-only ledger (never the undo stack — they carry no inverse);
    // transient ops append to neither. transientMode gates ALL THREE domains
    // uniformly (AC-09): under it, even session ops skip the ledger write.
    // M4 t28: defineOp-cast session ops push their sub-ops to ledger inside
    // the applier itself (D-7: each sub-op gets its own flat entry). Skip the
    // top-level dispatch-level push to avoid double-counting.
    if (!this.transientMode && !this.deferHistory && domain === 'session') {
      const desc = getOp(kind);
      if (!(desc && desc.source === 'defined')) {
        this.ledger.push(cmd);
        this.origins.push(origin);
        this.emitDiagnostics();
      }
    } else if (!this.transientMode && this.deferHistory && domain === 'session') {
      const desc = getOp(kind);
      if (!(desc && desc.source === 'defined')) this.deferredEntry = { cmd, origin };
    }
      return { ok: true };
    })();
    return result.ok ? result : { ok: false, error: normalizeGatewayError(result.error, cmd) };
  }

  private _dispatchCatalogReconcile(cmd: EditorOp, origin: CommandOrigin): DispatchResult {
    const descriptor = getOp('catalog.reconcile');
    if (descriptor?.argsSchema !== null && descriptor?.argsSchema !== undefined) {
      const validation = validateArgs(descriptor.argsSchema, cmd);
      if (!validation.ok) {
        const first = validation.errors[0];
        return {
          ok: false,
          error: {
            code: 'INVALID_ARGS',
            hint: `invalid args for "catalog.reconcile": ${first ? `${first.path}: ${first.message}` : 'schema validation failed'}`,
          },
        };
      }
    }
    const provider = this._catalogReconcileProvider;
    if (provider === null) {
      return {
        ok: false,
        error: {
          code: 'UNKNOWN_OP',
          hint: 'catalog.reconcile has no existing Catalog replica provider; register the read-only reconcile seam before dispatch.',
          recoveryActions: ['catalog.reconcile'],
        },
      };
    }

    const requestId = requestIdOf(cmd);
    if (requestId === undefined) {
      return { ok: false, error: { code: 'INVALID_ARGS', hint: 'catalog.reconcile requires requestId' } };
    }
    const actor = origin === 'ai'
      ? { id: 'ai', kind: 'ai' as const }
      : { id: 'human', kind: 'human' as const };
    const retryOfRequestId = (cmd as { readonly retryOfRequestId?: unknown }).retryOfRequestId;
    const retrySource = typeof retryOfRequestId === 'string'
      ? this.operationRuns.getRunResult(retryOfRequestId)
      : null;
    if (retrySource !== null && !retrySource.ok) return { ok: false, error: retrySource.error as unknown as CommandError };
    if (retrySource !== null && (retrySource.value.status !== 'failed' || !retrySource.value.retryable)) {
      return {
        ok: false,
        error: {
          code: 'operation-not-retryable',
          hint: 'Only a failed catalog reconciliation run can be retried.',
          current: retrySource.value,
        },
      };
    }
    const accepted = this.operationRuns.acceptOperation(requestId, { ...cmd }, actor, {
      operationId: 'catalog.reconcile',
      cancellable: false,
      retryable: true,
      ...(retrySource === null ? {} : {
        parentRunId: retrySource.value.runId,
        attempt: retrySource.value.attempt + 1,
      }),
    });
    if (!accepted.ok) return { ok: false, error: accepted.error as unknown as CommandError };
    if (accepted.reused) return { ok: true, result: { created: [], operationRun: accepted.run } };
    const running = this.operationRuns.markRunning(accepted.run.runId);
    if (!running.ok) return { ok: false, error: running.error as unknown as CommandError };
    this.operationRuns.bindCompletion(accepted.run.runId, Promise.resolve().then(() => provider()));
    return { ok: true, result: { created: [], operationRun: running.value } };
  }

  // ── Lifecycle methods (plan-strategy §2 D-2) ────────────────────────────
  //
  // begin → update* → commit/cancel. Single active-op slot: a second begin
  // implicitly cancels the first (reverts via beginInverse, no ledger/undo trace
  // for the cancelled op). Stale-handle calls return {ok:false, code:'OP_INTERRUPTED'}.
  //
  // begin validates the op (pre-apply check via applyCommand), snapshots the
  // pre-mutation state (the inverse of beginCmd = beginInverse), and returns a
  // handle. State is restored to pre-begin immediately.
  //
  // update discharges the current state and re-applies with the accumulated
  // patch: apply beginInverse (revert) → apply updatedCmd (re-apply) → update
  // beginInverse to the new inverse. No ledger/undo growth. _rev bumped for
  // repaint. Multiple updates accumulate (last write wins).
  //
  // commit: the world is in the final state. beginInverse is the full from→to
  // inverse. Push beginCmd + beginInverse as one undo entry; record beginCmd in
  // ledger. Release slot.
  //
  // cancel: apply beginInverse to roll back to pre-begin state. No ledger/undo
  // trace. Slot released.

  begin(cmd: EditorOp, origin: CommandOrigin = 'human'): { ok: true; handle: OpHandle } | { ok: false; error: CommandError } {
    if (this.sceneAuthoringSession().mode === 'imported-preview') {
      return {
        ok: false,
        error: normalizeGatewayError({
          code: 'edit-rejected-in-imported-preview',
          hint: 'Imported scene previews are read-only.',
          recoveryActions: ['addSceneAssetToScene', 'promoteImportedScene'],
        }, cmd),
      };
    }
    const mountPolicy = this._validateMountMemberEdit(cmd);
    if (!mountPolicy.ok) return { ok: false, error: normalizeGatewayError(mountPolicy.error, cmd) };
    // Step 1: pre-validate — applyCommand confirms entity exists, fields valid.
    const validateR = applyCommand(this.doc, cmd);
    if (!validateR.ok) return validateR;

    // Step 2: snapshot. applyCommand already applied the op; apply the inverse
    // to restore the pre-begin state.
    const restoreR = applyCommand(this.doc, validateR.inverse);
    if (!restoreR.ok) {
      return { ok: false, error: { code: 'SET_FAILED', hint: 'failed to restore begin snapshot' } };
    }

    // Step 3: implicit cancel of previous active op (if any)
    if (this._activeOp !== null) {
      applyCommand(this.doc, this._activeOp.beginInverse);
      this._activeOp = null;
    }

    // Step 4: occupy the slot. lastCmd starts as beginCmd (a begin→commit with no
    // update commits the begin op verbatim) and is updated on each update() call.
    const handle: OpHandle = { id: nextOpHandleId() };
    this._activeOp = { handle, beginCmd: cmd, beginInverse: validateR.inverse, lastCmd: cmd, origin };
    return { ok: true, handle };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(handle: OpHandle, patch: Record<string, any>): DispatchResult {
    const active = this._activeOp;
    if (active === null || active.handle.id !== handle.id) {
      return { ok: false, error: { code: 'OP_INTERRUPTED', hint: 'operation was interrupted; begin a new one' } };
    }
    // Build the accumulated command from beginCmd + patch
    const updatedCmd = { ...active.beginCmd, ...patch } as EditorOp;
    // Discharge current state: revert to pre-begin, then re-apply with accumulated patch.
    const revertR = applyCommand(this.doc, active.beginInverse);
    if (!revertR.ok) {
      return { ok: false, error: { code: 'SET_FAILED', hint: 'failed to revert during update' } };
    }
    const applyR = applyCommand(this.doc, updatedCmd);
    if (!applyR.ok) return applyR;
    // Update beginInverse to track the new inverse from the current (final) state
    active.beginInverse = applyR.inverse;
    // Track the final forward command so commit records the accumulated pose (not
    // beginCmd) — this is what Redo re-applies and what the ledger reports.
    active.lastCmd = updatedCmd;
    // Bump rev for repaint — no ledger/undo/emit
    this._rev++;
    return { ok: true };
  }

  commit(handle: OpHandle): DispatchResult {
    const active = this._activeOp;
    if (active === null || active.handle.id !== handle.id) {
      return { ok: false, error: { code: 'OP_INTERRUPTED', hint: 'operation was interrupted; begin a new one' } };
    }
    this._activeOp = null;
    // beginInverse is the full from→to inverse (updated after each update call).
    // Push one undo entry: lastCmd (the FINAL accumulated forward command) so Redo
    // re-applies the committed pose; beginInverse as the undo inverse. Ledger
    // records lastCmd — the op as it actually landed, not the begin-time skeleton.
    if (!this.transientMode) {
      this.undoStack.push({ cmd: active.lastCmd, inverse: active.beginInverse, origin: active.origin });
      this.redoStack.length = 0;
      this.ledger.push(active.lastCmd);
      this.origins.push(active.origin);
    }
    this.emit(active.lastCmd);
    return { ok: true };
  }

  cancel(handle: OpHandle): DispatchResult {
    const active = this._activeOp;
    if (active === null || active.handle.id !== handle.id) {
      return { ok: false, error: { code: 'OP_INTERRUPTED', hint: 'operation was interrupted; begin a new one' } };
    }
    // Rollback to pre-begin state: apply beginInverse. No ledger/undo trace.
    applyCommand(this.doc, active.beginInverse);
    this._activeOp = null;
    // Fire subscribers (world changed) but NO ledger/undo
    this._rev++;
    for (const fn of this.listeners) fn(this.doc, null);
    return { ok: true };
  }

  /** Subscribe to scene reloads (whole-document swaps via replaceDoc). Returns an
   *  unregister fn. M5 / D-4: the super (world-manager) uses this to bump the
   *  sceneWorld epoch + revalidate the selection so pre-reload handle-pairs are
   *  batch-invalidated (AC-05). */
  onSceneReload(fn: () => void): () => void {
    this.sceneReloadListeners.add(fn);
    return () => this.sceneReloadListeners.delete(fn);
  }

  /** Swap in a new authored session (scene load). Clears history — old
   * inverses target the previous session and must not be replayed. */
  replaceDoc(doc: EditSession): void {
    // D-2: scene switch is an interrupt source — cancel active op
    if (this._activeOp !== null) {
      applyCommand(this.doc, this._activeOp.beginInverse);
      this._activeOp = null;
    }
    this.doc = doc;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.ledger.length = 0;
    this.origins.length = 0;
    this._rev++;
    // Fire scene-reload listeners BEFORE the general subscribers: the super bumps
    // the epoch + revalidates selection first, so any subscriber that reads the
    // selection (panels) already sees the post-reload (cleared) state (D-4/AC-05).
    for (const fn of this.sceneReloadListeners) fn();
    for (const fn of this.listeners) fn(this.doc, null);
    this.emitDiagnostics();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    // D-2: implicit cancel active op before undo (interrupt source)
    if (this._activeOp !== null) {
      applyCommand(this.doc, this._activeOp.beginInverse);
      this._activeOp = null;
    }
    const entry = this.undoStack.pop();
    if (!entry) return false;
    // undo goes through executor (plan-strategy §2 D-2: undo/redo same executor,
    // everything leaves a span trace)
    pushSpan(`undo:${entry.cmd.kind}`);
    const r = applyCommand(this.doc, entry.inverse);
    if (!r.ok) {
      popSpan('ERROR');
      // should not happen; restore stack and bail
      this.undoStack.push(entry);
      return false;
    }
    this.redoStack.push({
      cmd: entry.cmd,
      inverse: r.inverse,
      reviewInverse: entry.reviewInverse ?? entry.inverse,
      origin: entry.origin,
    });
    popSpan('OK');
    this.emit(entry.inverse);
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    // redo goes through executor (plan-strategy §2 D-2: everything leaves a span)
    pushSpan(`redo:${entry.cmd.kind}`);
    const r = applyCommand(this.doc, entry.cmd);
    if (!r.ok) {
      popSpan('ERROR');
      this.redoStack.push(entry);
      return false;
    }
    this.undoStack.push({
      cmd: entry.cmd,
      inverse: r.inverse,
      reviewInverse: entry.reviewInverse ?? entry.inverse,
      origin: entry.origin,
    });
    popSpan('OK');
    this.emit(entry.cmd);
    return true;
  }

  /** Number of currently-applied steps (the history "head" position). */
  appliedCount(): number {
    return this.undoStack.length;
  }

  /** Full timeline (applied steps oldest→newest, then redoable future steps). */
  historySteps(): HistoryStep[] {
    const applied = this.undoStack.map((e) => step(labelOf(e.cmd), e.origin, false, entityOf(e.cmd)));
    const future = [...this.redoStack].reverse().map((e) => step(labelOf(e.cmd), e.origin, true, entityOf(e.cmd)));
    return [...applied, ...future];
  }

  /**
   * Read one bounded review projection from the existing document timeline.
   * The one-based index follows historySteps(): applied entries first, then
   * redoable future entries in replay order. Invalid positions are absent so a
   * caller can probe a changing timeline without an exception or mutation.
   */
  historyDiff(index: number): HistoryDiff | undefined {
    if (!Number.isInteger(index) || index < 1) return undefined;
    const appliedCount = this.undoStack.length;
    const total = appliedCount + this.redoStack.length;
    if (index > total) return undefined;

    const future = index > appliedCount;
    const entry = future
      ? this.redoStack[this.redoStack.length - (index - appliedCount)]
      : this.undoStack[index - 1];
    if (!entry) return undefined;

    const timelineStep = step(labelOf(entry.cmd), entry.origin, future, entityOf(entry.cmd));
    return {
      ...timelineStep,
      index,
      op: entry.cmd,
      inverse: entry.reviewInverse ?? entry.inverse,
    };
  }

  /**
   * Read-only audit projection: the append-only ledger zipped with its
   * index-aligned origin ("who issued it"), oldest→newest. Because `ledger` and
   * `origins` are two parallel arrays (push-in-lockstep at dispatch/commit),
   * "which command carried which origin" otherwise requires the caller to zip
   * them by index by hand — the exact trap that makes `gateway.ledger` alone look
   * like it lost the origin marker. This is the single-read "who did what" view:
   * unlike `historySteps()` (undoStack-derived, undo/redo timeline, document ops
   * only) it includes irreversible session ops (setSelection / save / play), so
   * it is the honest record of every applied command including AI-vs-human.
   */
  auditLog(): ReadonlyArray<{ op: EditorOp; origin: CommandOrigin }> {
    return this.ledger.map((op, i) => ({ op, origin: this.origins[i] ?? 'human' }));
  }

  /** Inverse of the most recent applied step, if any (introspection / test helper). */
  peekUndoInverse(): EditorOp | undefined {
    return this.undoStack[this.undoStack.length - 1]?.inverse;
  }

  /** Move the timeline head to exactly `target` applied steps (undo/redo as needed). */
  jumpTo(target: number): void {
    while (this.undoStack.length > target && this.undo()) {
      /* undo down */
    }
    while (this.undoStack.length < target && this.redo()) {
      /* redo up */
    }
  }

  subscribe(fn: BusListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Subscribe to bounded diagnostics source facts. Unlike `subscribe`, this
   * includes session-ledger entries that do not mutate the authored World
   * (for example `assetValidationFailed`). */
  subscribeDiagnostics(fn: () => void): () => void {
    this.diagnosticsListeners.add(fn);
    return () => this.diagnosticsListeners.delete(fn);
  }

  /**
   * Register a producer-owned runtime read projection. The provider supplies
   * only current JSON-safe facts; Gateway owns the bounded aggregation and
   * notification surface consumed by both panels and scope-1 AI callers.
   */
  registerRuntimeDiagnosticsProvider(provider: RuntimeDiagnosticsProvider): () => void {
    const previous = this.runtimeDiagnosticsProviders.get(provider.id);
    previous?.unsubscribe();
    const onChange = (): void => {
      this._runtimeDiagnosticsRevision += 1;
      this.emitDiagnostics();
    };
    const unsubscribe = provider.subscribe?.(onChange) ?? (() => {});
    this.runtimeDiagnosticsProviders.set(provider.id, { provider, unsubscribe });
    this._runtimeDiagnosticsRevision += 1;
    this.emitDiagnostics();
    return () => {
      const current = this.runtimeDiagnosticsProviders.get(provider.id);
      if (current?.provider !== provider) return;
      current.unsubscribe();
      this.runtimeDiagnosticsProviders.delete(provider.id);
      this._runtimeDiagnosticsRevision += 1;
      this.emitDiagnostics();
    };
  }

  private emit(last: EditorOp): void {
    this._rev++;
    for (const fn of this.listeners) fn(this.doc, last);
    this.emitDiagnostics();
  }

  private emitDiagnostics(): void {
    for (const fn of this.diagnosticsListeners) fn();
  }

  // ── Trace read API (plan-strategy §2 D-3, AC-10) ──────────────────────────

  /** Programming read API for trace trees: recent() → last N root trees,
   *  last() → most recent single root tree, or null if no traces recorded;
   *  dropped() → count of root trees evicted by the ring buffer (D-3 explicit
   *  drop detection, exposed on the gateway so scope① eval can read it). */
  readonly trace = {
    recent: (n: number = 1): SpanNode[] => recentRoots(n),
    last: (): SpanNode | null => lastRoot(),
    dropped: (): number => droppedTracesCount(),
  };

  // ── M4 catalog / defineOp stubs ─────────────────────────────────────────
  // RED phase (m4-w1/w2/w4/w10): stubs return empty/error so tests can
  // compile and fail. Implemented in green phase: m4-w5 (listOps),
  // m4-w7 (defineOp), m4-w8 (querySnapshot).

  /** Operation contracts joined with the live unified-applier availability fact. */
  operationCapabilitySnapshot(): GatewayOpSnapshot {
    const registry = applierRegistrySnapshot();
    const registered = new Map(registry.entries.map((entry) => [entry.id, entry]));
    const ops: GatewayOpDescriptor[] = catalogListOps().map((descriptor) => {
      const entry = registered.get(descriptor.id);
      registered.delete(descriptor.id);
      const available = entry?.domain === descriptor.domain;
      return {
        ...descriptor,
        availability: available
          ? { available: true }
          : {
              available: false,
              code: 'applier-unavailable',
              reason: entry === undefined
                ? `no ${descriptor.domain} applier is registered for "${descriptor.id}"`
                : `registered ${entry.domain} applier conflicts with the ${descriptor.domain} contract`,
              resolution: 'Connect the Runtime owner that registers this operation.',
            },
      };
    });
    for (const entry of registered.values()) {
      ops.push({
        id: entry.id,
        domain: entry.domain,
        argsSchema: (entry.argsSchema ?? null) as ArgsSchema | null,
        source: 'registered',
        ...(entry.title === undefined ? {} : { title: entry.title }),
        ...(entry.operationRun === undefined ? {} : { operationRun: entry.operationRun }),
        availability: { available: true },
      });
    }
    return Object.freeze({ revision: registry.revision, ops: Object.freeze(ops) });
  }

  /** Operation catalog — AI self-introspection + command palette SSOT. */
  listOps(): readonly GatewayOpDescriptor[] {
    return this.operationCapabilitySnapshot().ops;
  }

  subscribeOperationCapabilities(listener: (snapshot: GatewayOpSnapshot) => void): () => void {
    return subscribeApplierRegistry(() => listener(this.operationCapabilitySnapshot()));
  }

  /** Register a builtin op at catalog build time. */
  static registerBuiltinOp(op: Readonly<OpDescriptor>): void {
    registerBuiltinOp(op);
  }

  /**
   * Collect one active-world entity subtree into a material-safe SceneAsset POD.
   * Read-only: collection never mutates the world, undo stack, or ledger. The
   * result can be supplied to instantiateSceneAsset for advanced composition;
   * ordinary copies should dispatch duplicateEntity instead.
   */
  collectSceneAsset(entity: EntityHandle): CollectSceneAssetResult {
    return collectLiveSceneAsset(this.doc.registry, this.activeWorld, entity);
  }

  /** Pre-fill a destroyEntity op's _asset / _parent / _name before the applier
   *  runs. Called from dispatch for both top-level destroyEntity AND for
   *  destroyEntity sub-ops inside a transaction (deleteManyCascade). Collection
   *  failure is non-fatal: the applier falls back to the legacy spawnEntity
   *  inverse path (materials lost, but delete still works). */
  private _preCollectDestroyAsset(
    destroy: Extract<EditorOp, { kind: 'destroyEntity' }>,
  ): void {
    if (destroy._asset !== undefined) return;
    const entity = destroy.entity as EntityHandle;
    const collected = this.collectSceneAsset(entity);
    if (collected.ok) {
      destroy._asset = collected.asset;
      destroy._parent = entParent(this.activeWorld, entity);
      destroy._name = entName(this.activeWorld, entity);
    }
  }

  /** Pre-fill an updateMaterialParams op's _oldPatch / _oldRefs / _oldEntry from
   *  the synchronous assetCatalog before the applier runs. Idempotent — skips if
   *  already filled (redo replay carries the pre-filled fields). */
  private _preFillMaterialOp(
    cmd: { guid: string; _oldPatch?: unknown; _oldRefs?: unknown; _oldEntry?: unknown; [k: string]: unknown },
  ): void {
    if (cmd._oldPatch !== undefined) return;
    const registry = this.doc.registry;
    if (!registry) return;
    const key = cmd.guid.toLowerCase();
    const envelope = registry.assetCatalog.get(key);
    if (!envelope) return;
    const payload = envelope.payload as unknown as Record<string, unknown>;
    cmd._oldPatch = (payload.values ?? {}) as Record<string, unknown>;
    // Engine-memory → wire-format projection: envelope.refs are AssetRef
    // OBJECTS ({ guid, sourceField?, sceneEntityId? }), but the pack on disk
    // stores refs as GUID STRINGS (zod: refs: z.array(z.string())), and the
    // applier's encodeTextureRefs/invertTextureGuids operate on strings
    // (indexOf / numeric-index lookup). Copying the objects through made
    // writePack reject the entry (PACK_SHELL_INVALID at assets.N.refs.0).
    // The typeof guard tolerates either runtime form.
    const refGuids = (envelope.refs ?? []).map((r: { guid: string } | string) => (typeof r === 'string' ? r : r.guid));
    cmd._oldRefs = refGuids;
    cmd._oldEntry = { guid: envelope.guid, kind: envelope.kind, name: (envelope as unknown as { name?: string }).name, payload, refs: [...refGuids] };
  }

  /** Pre-fill Material Instance mutator ops with `_oldEntry` (+ parent chain for
   *  cycle checks). Idempotent when `_oldEntry` is already present. */
  private _preFillMaterialInstanceOp(
    cmd: {
      guid: string;
      parentGuid?: string;
      _oldEntry?: unknown;
      _catalogEntries?: unknown[];
      [k: string]: unknown;
    },
  ): void {
    if (cmd._oldEntry !== undefined) return;
    const registry = this.doc.registry;
    if (!registry) return;
    const envelope = registry.assetCatalog.get(cmd.guid.toLowerCase());
    if (!envelope) return;
    const payload = envelope.payload as unknown as Record<string, unknown>;
    const refGuids = (envelope.refs ?? []).map((r: { guid: string } | string) => (typeof r === 'string' ? r : r.guid));
    cmd._oldEntry = {
      guid: envelope.guid,
      kind: envelope.kind,
      name: (envelope as unknown as { name?: string }).name,
      payload,
      refs: [...refGuids],
    };

    // Collect a shallow parent-chain snapshot for cycle detection (setParent).
    if (cmd._catalogEntries !== undefined) return;
    const entries: Array<{ guid: string; kind: string; name?: string; payload: Record<string, unknown>; refs: string[] }> = [];
    const seen = new Set<string>([cmd.guid.toLowerCase()]);
    let walk: string | undefined =
      typeof cmd.parentGuid === 'string'
        ? cmd.parentGuid
        : typeof payload.parent === 'string'
          ? payload.parent
          : undefined;
    while (walk !== undefined) {
      const key = walk.toLowerCase();
      if (seen.has(key)) break;
      seen.add(key);
      const next = registry.assetCatalog.get(key);
      if (!next) break;
      const nextPayload = next.payload as unknown as Record<string, unknown>;
      const nextRefs = (next.refs ?? []).map((r: { guid: string } | string) => (typeof r === 'string' ? r : r.guid));
      entries.push({
        guid: next.guid,
        kind: next.kind,
        name: (next as unknown as { name?: string }).name,
        payload: nextPayload,
        refs: [...nextRefs],
      });
      const parent = nextPayload.parent;
      walk = typeof parent === 'string' && parent.length > 0 ? parent : undefined;
    }
    if (entries.length > 0) cmd._catalogEntries = entries;
  }

  // ── Asset read surface (Part 4) ────────────────────────────────────────────
  // query() returns a shared<T> field as { kind:'opaque-handle', type, raw },
  // where `raw` is the engine handle value. These read methods turn that handle —
  // or a catalog GUID — into meaning. They are pure reads: no world/undo/ledger
  // mutation. This is the read half of the "write=dispatch, read=gateway" symmetry
  // an AI needs (previously reads had to bypass the gateway to doc.registry).

  /**
   * Resolve a shared<T> asset handle (query's opaque-handle.raw) to its live
   * payload. Covers BOTH builtin meshes (HANDLE_CUBE via BuiltinAssetRegistry)
   * and catalog assets (world.sharedRefs), O(1). Returns a structured miss
   * instead of throwing (charter P3) — a stale/unregistered handle is data.
   */
  resolveAsset(handle: number): { ok: true; asset: Asset } | { ok: false; error: CommandError } {
    const r = resolveAssetHandle(this.activeWorld, handle as unknown as Handle<string, 'shared'>);
    if (!r.ok) {
      return { ok: false, error: { code: 'ASSET_NOT_FOUND', hint: `no asset for handle ${handle}; it may be slot 0 (unset), stale, or not a shared<T> handle` } };
    }
    return { ok: true, asset: r.value };
  }

  /**
   * Describe an asset handle as a lightweight summary (best-effort): its `kind`,
   * a catalog GUID + name when registered, and — for heavy-data kinds — its
   * SHAPE metadata (texture w/h/format, mesh vertex count) but NEVER the pixel /
   * vertex buffer itself. Builtin/procedural payloads have no GUID (not in the
   * catalog) → `builtin:true`, no GUID/name. This is the "what mesh is this
   * entity using?" answer: query MeshFilter.assetHandle.raw → describeAsset(raw).
   * For the payload (geometry / pixels), use resolveAsset(handle).
   */
  describeAsset(handle: number): AssetSummaryResult {
    const r = this.resolveAsset(handle);
    if (!r.ok) return r;
    const guid = this.doc.registry?._guidForAsset(r.asset);
    return { ok: true, ...this.summarizeAsset(r.asset, guid) };
  }

  /**
   * Describe a CATALOGUED asset by GUID — the lightweight, by-GUID complement of
   * describeAsset(handle). Completes the asset read-surface 2×2 matrix:
   *   full payload → resolveAsset(handle) / lookupAsset(guid)
   *   lightweight  → describeAsset(handle) / describeAssetByGuid(guid)
   * A material POD exposes its texture bindings as GUID strings (e.g.
   * `values.baseColorTexture`); feed that GUID here to inspect the texture's
   * kind + dimensions + format WITHOUT lookupAsset dragging the whole pixel
   * buffer into scope. Same summary projection as describeAsset (SSOT — the
   * summarizeAsset helper), so the two legs can never drift. Unknown GUID / no
   * registry → structured ASSET_NOT_FOUND (charter P3), never a silent undefined.
   */
  describeAssetByGuid(guid: AssetGuid | string): AssetSummaryResult {
    const registry = this.doc.registry;
    const asset = registry?.lookup(guid);
    if (asset === undefined) {
      return { ok: false, error: { code: 'ASSET_NOT_FOUND', hint: `no catalog asset for guid ${String(guid)}; it may be uncooked, a builtin (no GUID), or a scene sub-asset fetched by loadByGuid` } };
    }
    // Re-derive the canonical catalog string key from the payload (SSOT — same
    // path describeAsset uses), so guid/name in the summary match exactly.
    return { ok: true, ...this.summarizeAsset(asset, registry!._guidForAsset(asset)) };
  }

  /**
   * Project an Asset POD to its lightweight summary — the SSOT both describe legs
   * (by-handle, by-guid) share so their output can never diverge (Derive, don't
   * Duplicate). Emits identity (`kind`/`guid`/`name`, or `builtin:true` when the
   * payload isn't catalogued) plus a `meta` bag of the POD's own lightweight
   * fields — every scalar/plain field (a texture's `width`/`height`/`format`, a
   * mesh's `attributes`, …) EXCEPT the heavy binary buffers (`TextureAsset.data`,
   * `MeshAsset.vertices`, …).
   *
   * Deliberately KIND-AGNOSTIC: it discriminates by a field's runtime SHAPE (is it
   * a binary buffer?), not by `asset.kind`. So the gateway holds no per-asset-kind
   * business knowledge — a new heavy-data asset kind in the engine needs zero edit
   * here, and its lightweight fields flow through automatically (Derive; the engine
   * `Asset` POD stays the single source of what fields exist).
   */
  private summarizeAsset(asset: Asset, guid: string | undefined): AssetSummary {
    const identity: AssetSummary =
      guid === undefined
        ? { kind: asset.kind, builtin: true } // not in catalog → builtin/procedural
        : { kind: asset.kind, guid, name: this.doc.registry!.resolveName(guid) };
    const meta: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(asset)) {
      if (key === 'kind') continue; // already in identity
      if (isHeavyBuffer(value)) continue; // drop pixel/vertex/index buffers — the whole point
      meta[key] = value;
    }
    return { ...identity, meta };
  }

  /**
   * List the asset catalog through the registry's canonical read-only surface.
   * The Engine return type and row value are passed through unchanged, so
   * producer-owned facts remain lossless. Empty array when no registry is bound.
   */
  assetCatalog(options: { readonly compatibleWith: string }): CompatibleAssetCatalogResult<ReturnType<AssetRegistry['listCatalog']>[number]>;
  assetCatalog(): ReturnType<AssetRegistry['listCatalog']>;
  assetCatalog(options?: { readonly compatibleWith?: string }): ReturnType<AssetRegistry['listCatalog']> | CompatibleAssetCatalogResult<ReturnType<AssetRegistry['listCatalog']>[number]> {
    const registry = this.doc.registry;
    if (registry === undefined) {
      return options?.compatibleWith === undefined
        ? []
        : queryCompatibleAssetCatalog([], options.compatibleWith);
    }
    const listed = registry.listCatalog();
    const snapshot = registry.catalogSnapshot?.();
    const rows = snapshot === undefined
      ? listed
      : (() => {
        const factsByGuid = new Map(snapshot.entries.map((entry) => [entry.guid.toLowerCase(), entry]));
        const merged = listed.map((row) => ({ ...factsByGuid.get(row.guid.toLowerCase()), ...row }));
        const listedGuids = new Set(listed.map((row) => row.guid.toLowerCase()));
        for (const entry of snapshot.entries) {
          if (!listedGuids.has(entry.guid.toLowerCase())) merged.push(entry);
        }
        return merged as ReturnType<AssetRegistry['listCatalog']>;
      })();
    if (options?.compatibleWith === undefined) return rows;
    const knownAssetTypes = new Set<string>();
    for (const row of rows) {
      const binding = row.authoring?.binding;
      if (binding !== undefined && binding.operation !== 'unavailable') {
        knownAssetTypes.add(binding.target.assetType);
      }
    }
    for (const token of getRegisteredComponents().values()) {
      for (const fieldType of Object.values(token.schema)) {
        const match = /^shared<(.+)>$/.exec(String(fieldType));
        if (match?.[1] !== undefined) knownAssetTypes.add(match[1]);
      }
    }
    return queryCompatibleAssetCatalog(rows, options.compatibleWith, knownAssetTypes);
  }

  /**
   * Derive the current asset reference impact from producer catalog facts.
   * This is a bounded read for delete, source move, and reimport decisions;
   * it never builds or stores a second graph. A sourcePath selector may match
   * several imported outputs from one source file.
   */
  assetImpact(request: AssetMutationPreviewRequest): AssetImpactResult {
    return deriveAssetImpact(this.assetCatalog(), request);
  }

  /** Read the terminal state of an accepted deleteSourceFile request. */
  sourceFileDeleteStatus(requestId: string): SourceFileDeleteStatus | null {
    const run = this.operationRuns.getRun(requestId);
    if (run === undefined) return null;
    const path = sourceFileDeletePath(run);
    return path === null ? null : projectSourceFileDeleteStatus(run, path);
  }

  /**
   * Look up a catalogued asset payload by GUID (no fetch — catalog only). Returns
   * the FULL payload (heavy: a texture's pixels, a mesh's vertices) — for a
   * lightweight identity/shape summary use describeAssetByGuid(guid) instead.
   * undefined when the GUID is unknown or no registry is bound.
   */
  lookupAsset(guid: AssetGuid | string): Asset | undefined {
    return this.doc.registry?.lookup(guid);
  }

  /**
   * List every registered component name (sorted). The "what components exist?"
   * self-introspection leg, parallel to listOps() (ops) and assetCatalog()
   * (assets). Same source as the UNKNOWN_COMPONENT hint (getRegisteredComponents),
   * so the two never drift. An AI enumerates this before a spawn/setComponent
   * instead of guessing a name and triggering an error.
   */
  listComponents(): readonly string[] {
    return Array.from(getRegisteredComponents().keys()).sort();
  }

  /**
   * Describe one component's field schema — the answer to "what fields does
   * Transform take, and of what type?" BEFORE constructing a spawnEntity /
   * setComponent payload. Projects the engine token's frozen `.schema`
   * (field-name → type-keyword) and its layer-2 `.defaults`, the same data the
   * engine uses to validate spawn data (so it can never disagree with the
   * SPAWN_FAILED "Known fields" hint). Unknown name → structured
   * UNKNOWN_COMPONENT whose hint lists the registered names (reused shape from
   * query-snapshot). Read-only: no world/ledger mutation, not an op.
   *
   * `transient` (solo round-25) marks the DERIVED, non-authored fields — a field
   * whose value is recomputed each frame from the persisted local state, skipped
   * by scene collect (engine D-5). It lets a docs-only AI tell an authored INPUT
   * (`Transform.pos`) from a derived read-only OUTPUT (`Transform.world`, the
   * frame-lagged resolved world matrix): don't author a transient field, and
   * expect it to lag a frame after a mutation until the propagate/derive pass runs.
   */
  describeComponent(
    name: string,
  ):
    | {
        ok: true;
        name: string;
        schema: Record<string, string>;
        defaults?: Record<string, unknown>;
        enums?: Record<string, Record<string, number>>;
        shapes?: Record<string, FieldShapeKind>;
        arrays?: Record<string, { elementType: string; length?: number; group?: string }>;
        transient?: Record<string, true>;
      }
    | { ok: false; error: CommandError } {
    const token = resolveComponent(name);
    if (!token) {
      const known = Array.from(getRegisteredComponents().keys()).sort();
      return {
        ok: false,
        error: {
          code: 'UNKNOWN_COMPONENT',
          hint: `component "${name}" is not registered. registered component names: ${known.join(', ')}`,
        },
      };
    }
    // token.schema is a frozen field-name → type-keyword map; copy to a plain
    // JSON-safe object (values are already string keywords like 'array<f32, 3>').
    const schema: Record<string, string> = {};
    for (const [field, type] of Object.entries(token.schema)) {
      schema[field] = String(type);
    }
    const result: {
      ok: true;
      name: string;
      schema: Record<string, string>;
      defaults?: Record<string, unknown>;
      enums?: Record<string, Record<string, number>>;
      shapes?: Record<string, FieldShapeKind>;
      arrays?: Record<string, { elementType: string; length?: number; group?: string }>;
      transient?: Record<string, true>;
    } = {
      ok: true,
      name: token.name,
      schema,
    };
    if (token.defaults !== undefined) {
      // defaults values may be TypedArrays (e.g. Transform.pos is a Float32Array)
      // — snap-copy those into plain number[] so the result is JSON-safe (mirrors
      // query-snapshot's TypedArray handling; without this the object round-trips
      // to indexed-key garbage). Scalars pass through untouched.
      const defaults: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(token.defaults as Record<string, unknown>)) {
        defaults[field] = ArrayBuffer.isView(value) ? Array.from(value as unknown as ArrayLike<number>) : value;
      }
      result.defaults = defaults;
    }
    // Enum-field label→value maps (engine solo round-24): an `enum` field stores
    // a bare u32 variant index; its label map lives on the field descriptor
    // (`token.fields[field].labels`), projected here so a docs-only AI learns the
    // legal variants + their integers (e.g. RigidBody.type → static=0/dynamic=1/
    // kinematic=2) from the schema alone, not from engine source. Only fields
    // that declared labels appear; a JSON-safe plain-object copy. Absent when no
    // field carries labels (backward-compatible: predates the engine change →
    // token.fields[f].labels is undefined for every field → key omitted).
    const enums: Record<string, Record<string, number>> = {};
    const fields = token.fields as Record<
      string,
      { labels?: Readonly<Record<string, number>>; transient?: boolean } | undefined
    >;
    for (const field of Object.keys(schema)) {
      const labels = fields[field]?.labels;
      if (labels !== undefined) enums[field] = { ...labels };
    }
    if (Object.keys(enums).length > 0) result.enums = enums;
    // Producer-declared semantic field shapes (R0-03A). The storage keyword
    // remains in `schema`; this projection carries only the semantic facts
    // that a flat ECS keyword cannot recover (optional / nested) plus the
    // representative vocabulary used by schema-driven consumers.
    const shapes: Record<string, FieldShapeKind> = {};
    const shapeFields = token.fields as Record<string, { shape?: FieldShapeKind } | undefined>;
    for (const field of Object.keys(schema)) {
      const shape = shapeFields[field]?.shape;
      if (shape !== undefined) shapes[field] = shape;
    }
    // Generic container facts are derived from the core schema projection. This
    // keeps the public contract useful for variable arrays whose storage keyword
    // is not itself an Inspector renderer, without maintaining a second field map
    // in the Gateway.
    const arrays: Record<string, { elementType: string; length?: number; group?: string }> = {};
    for (const field of getComponentSchema(name)?.fields ?? []) {
      if (field.arrayMeta === undefined) continue;
      arrays[field.key] = {
        elementType: field.arrayMeta.elementType,
        ...(field.arrayMeta.length === undefined ? {} : { length: field.arrayMeta.length }),
        ...(field.arrayGroup === undefined ? {} : { group: field.arrayGroup }),
      };
      if (shapeFields[field.key]?.shape === undefined && field.shape === 'array') {
        shapes[field.key] = 'array';
      }
    }
    if (Object.keys(arrays).length > 0) result.arrays = arrays;
    if (Object.keys(shapes).length > 0) result.shapes = shapes;
    // Transient (derived, non-authored) fields (solo round-25): the engine field
    // descriptor's `transient` flag (D-5) is reflected on `token.fields[field]`;
    // project the fields where it's true so a docs-only AI can tell an authored
    // INPUT from a derived read-only OUTPUT (e.g. `Transform.world`, recomputed
    // each frame from local TRS — reading it right after a mutation returns the
    // stale value until the propagate pass runs). Only transient fields appear;
    // the key is omitted entirely when none is transient (backward-compatible).
    const transient: Record<string, true> = {};
    for (const field of Object.keys(schema)) {
      if (fields[field]?.transient === true) transient[field] = true;
    }
    if (Object.keys(transient).length > 0) result.transient = transient;
    return result;
  }

  /** Build a query-snapshot function for defineOp plan() and the eval channel's
   *  scope① `query`. Public entry face is frozen (AC-03); the read-side assembly
   *  it returns is sunk into io/gateway-query.ts (makeQueryFn, w10).
   *
   *  Bound to `activeWorld` (Derive from _playWorld), NOT the frozen edit
   *  `doc.world`: during ▶ Play `query` reads the live play world, so an AI can
   *  observe a running mechanic's component values through the documented door —
   *  mirroring activeWorld/mode/childrenOf, which already follow the pointer.
   *  Play writes stay blocked (dispatch → edit-rejected-in-play); only this
   *  read follows the active world ("play data is a read-only simulation view"). */
  buildQueryFn(): QuerySnapshotFn {
    return makeQueryFn(() => this.activeWorld);
  }

  /**
   * defineOp — cast a new operation from primitives at runtime (plan-strategy §2 D-4).
   *
   * Idempotent: defines a new op (does not execute). The op appears in listOps
   * immediately (source='defined').
   *
   * Document domain: plan result is wrapped in a transaction op → applyCommand
   * → single inverse → one undo+ledger step.
   *
   * Session domain (M4 t28, plan-strategy §2 D-7): plan result is a list of
   * session ops. Dispatch executes them sequentially through the session
   * executor — each sub-op gets its own ledger entry (flat append-only,
   * D-7). Partial failure: first failure stops execution, PLAN_STEP_FAILED
   * with hint containing failed op kind + index, already-executed ops stay
   * in ledger (AC-18 — append-only, never pretend-rollback).
   * Empty plan → {ok:true} with no ledger entries.
   *
   * Transient domain: still rejected (OOS-6).
   * Duplicate id (builtin or already-defined) → OP_ID_CONFLICT.
   */
  defineOp(spec: {
    id: string;
    domain: 'document' | 'session';
    argsSchema: Record<string, unknown> | null;
    plan: PlanFn;
  }): { ok: true } | { ok: false; error: CommandError } {
    const { id, domain, argsSchema, plan } = spec;

    // Reject transient domain (OOS-6)
    if (domain !== 'document' && domain !== 'session') {
      return { ok: false, error: { code: 'INVALID_ARGS', hint: 'defineOp supports domain "document" or "session"' } };
    }

    // Duplicate detection: both builtin and previously-defined ids conflict
    if (hasOp(id)) {
      return { ok: false, error: { code: 'OP_ID_CONFLICT', hint: `op "${id}" already exists in catalog` } };
    }
    const registeredDomain = domainOf(id);
    if (registeredDomain !== null) {
      return {
        ok: false,
        error: {
          code: 'OP_ID_CONFLICT',
          hint: `op "${id}" already has a live ${registeredDomain} applier`,
        },
      };
    }

    let definedApplier: ApplierFn | SessionApplier;
    if (domain === 'document') {
      // EXISTING document-domain path: transaction wrapper → undo+ledger.
      // The executor invokes this applier with a DocApplierCtx as the first arg
      // (F-1), which this defineOp path does not consume — it delegates to the
      // public applyCommand(this.doc, …), which builds its own ctx from the live
      // session. this.doc IS the session the executor's ctx wraps, so routing
      // through it is behavior-identical AND keeps the facade leaf recording
      // (applyCommand's facade writes onto the span _execDocumentApplier pushed).
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      definedApplier = (_ctx: unknown, cmd: EditorOp) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { kind: _kind, ...args } = cmd as { kind: string } & Record<string, unknown>;
        // activeWorld (Derive) so plan reads the active world consistently with
        // the eval/session query. Document dispatch is rejected in play
        // (edit-rejected-in-play), so in practice this is always the edit world
        // here — but binding to activeWorld keeps all five query sites uniform.
        const query: unknown = makeQueryFn(() => this.activeWorld);

        let planCommands: EditorOp[];
        try {
          planCommands = plan(query, args);
        } catch (err) {
          const r: { ok: false; error: CommandError } = {
            ok: false,
            error: { code: 'PLAN_FAILED', hint: `plan threw: ${(err as Error).message ?? String(err)}` },
          };
          return r as unknown as ReturnType<ApplierFn>;
        }

        if (!Array.isArray(planCommands) || planCommands.length === 0) {
          const r: { ok: false; error: CommandError } = {
            ok: false,
            error: { code: 'PLAN_FAILED', hint: 'plan returned empty or non-array' },
          };
          return r as unknown as ReturnType<ApplierFn>;
        }

        // Wrap in a transaction op → applyCommand → single inverse → one undo step
        const txOp: EditorOp = {
          kind: 'transaction',
          label: `defineOp:${id}`,
          commands: planCommands,
        };
        return applyCommand(this.doc, txOp);
      };
    } else {
      // ── Session domain (M4 t28, plan-strategy §2 D-7) ──
      // Register a session applier that, on dispatch, runs the plan and
      // emits each sub-op through the session executor path.
      // Ledger layout: each sub-op gets its own flat entry (D-7: no composite).
      // Partial failure: first fail stops, PLAN_STEP_FAILED, already-emitted
      // ops stay in ledger (AC-18: append-only, never rollback).
      definedApplier = (op: EditorOp, _ctx?: SessionApplierCtx): ReturnType<SessionApplier> => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { kind: _kind, ...args } = op as { kind: string } & Record<string, unknown>;
        // activeWorld (Derive): session ops CAN run during play, so a defined
        // session op's plan must read the live play world, not the frozen edit
        // doc — same active-world pointer as the eval/scope① query.
        const query: unknown = makeQueryFn(() => this.activeWorld);

        let planOps: EditorOp[];
        try {
          planOps = plan(query, args);
        } catch (err) {
          return { ok: false, error: { code: 'PLAN_FAILED', hint: `plan threw: ${(err as Error).message ?? String(err)}` } };
        }

        if (!Array.isArray(planOps)) {
          return { ok: false, error: { code: 'PLAN_FAILED', hint: 'plan returned non-array' } };
        }

        // Empty plan → explicit success with no ledger entries (D-7)
        if (planOps.length === 0) {
          return { ok: true };
        }

        // Execute each sub-op sequentially through the session dispatch path
        for (let idx = 0; idx < planOps.length; idx++) {
          const subOp = planOps[idx]!;
          const subDomain = domainOf(subOp.kind);
          if (subDomain === null || subDomain === 'document') {
            return {
              ok: false,
              error: {
                code: 'PLAN_STEP_FAILED',
                hint: `session plan sub-op #${idx + 1} "${subOp.kind}" is not a session/transient op`,
              },
            };
          }

          const applier = applierFor(subOp.kind, subDomain);
          if (!applier) {
            return {
              ok: false,
              error: {
                code: 'PLAN_STEP_FAILED',
                hint: `session plan sub-op #${idx + 1} "${subOp.kind}": no applier registered`,
              },
            };
          }

          const ctx = this._buildCtx();
          pushSpan(subOp.kind);
          const subResult = applier(subOp, ctx);
          const subOk = subResult.ok;
          popSpan(subOk ? 'OK' : 'ERROR');

          if (!subOk) {
            return {
              ok: false,
              error: {
                code: 'PLAN_STEP_FAILED',
                hint: `session plan sub-op #${idx + 1} "${subOp.kind}" failed: ${subResult.error.code}`,
              },
            };
          }

          // Ledger-only: session ops append to flat ledger, NEVER undo.
          if (!this.transientMode) {
            this.ledger.push(subOp);
            this.origins.push('ai'); // defined ops inherit AI origin (session-plan semantics)
            this.emitDiagnostics();
          }
        }

        return { ok: true };
      };
    }

    // Register in catalog — source='defined', visible in listOps immediately
    registerDefinedOp({
      id,
      domain: domain as 'document' | 'session',
      argsSchema: argsSchema as ArgsSchema | null,
      title: id,
    });
    registerApplier(domain, id, definedApplier, { argsSchema, title: id });

    return { ok: true };
  }
}
