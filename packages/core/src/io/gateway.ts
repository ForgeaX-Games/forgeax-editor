import { applyCommand, createEditSession } from '../session/document';
import type { DocApplierCtx, DocAliasMap, EngineWriteProxy } from '../session/document';
import type { CommandError, EditorOp, EditSession } from '../types';
import type { World } from '@forgeax/engine-ecs';
import { clearSelection } from '../store/selection';
import { documentAppliers, sessionAppliers, transientAppliers, domainOf } from './appliers';
import type { ApplierFn, SessionApplier, SessionApplierCtx } from './appliers';
import type { OpDescriptor, PlanFn, ArgsSchema } from './catalog';
import { listOps as catalogListOps, registerBuiltinOp, registerDefinedOp, hasOp, getOp } from './catalog';
import type { QuerySnapshotFn } from './query-snapshot';
import { validate as validateArgs } from './args-schema';
import type { ValidateResult } from './args-schema';
import { EngineFacade } from './engine-facade';
import { assetIO, type AssetIOFacade } from './asset-io-facade';
import { pushSpan, popSpan, lastRoot, recentRoots, activeSpan, droppedTracesCount, type SpanNode } from './trace';
// M3 w10 (plan-strategy §2 D-4, AC-04): non-entry history/step + op-handle detail
// and the querySnapshot read-side assembly are sunk into these sibling modules.
// gateway.ts keeps ONLY the single-entry dispatch/apply/ledger narrative; the
// helpers it imports here shape steps / mint ids / bind the reader to the world —
// none of them route a command or decide a domain.
import { labelOf, entityOf, step, nextOpHandleId } from './gateway-history';
import type { CommandOrigin, HistoryStep } from './gateway-history';
import { makeQueryFn } from './gateway-query';

export type BusListener = (doc: EditSession, lastCommand: EditorOp | null) => void;

export type DispatchResult =
  | { ok: true }
  | { ok: false; error: CommandError };

// CommandOrigin + HistoryStep now live in io/gateway-history.ts (sunk non-entry
// detail, w10). Re-exported here so the barrel (index.ts) surface stays byte-
// identical — every consumer keeps importing them from editor-core unchanged
// (AC-03 consumers zero-edit).
export type { CommandOrigin, HistoryStep };

interface StackEntry {
  cmd: EditorOp;
  inverse: EditorOp;
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

  /** The current active World pointer (Derive). edit mode → doc.world, play mode → playWorld. */
  get activeWorld(): World {
    return (this._playWorld ?? this.doc.world) as unknown as World;
  }

  /** Derived read surface for current mode (Derive from _playWorld, no second state field). */
  get mode(): 'edit' | 'play' {
    return this._playWorld !== null ? 'play' : 'edit';
  }

  /** Switch the pointer to a play World. Clears selection + emits notification (D-3/D-11). */
  enterPlay(playWorld: World): void {
    this._playWorld = playWorld;
    clearSelection();
    this._rev++;
    for (const fn of this.listeners) fn(this.doc, null);
  }

  /** Return the pointer to the edit world. Clears selection + emits notification. */
  exitPlay(): void {
    this._playWorld = null;
    clearSelection();
    this._rev++;
    for (const fn of this.listeners) fn(this.doc, null);
  }

  // ── Lifecycle: active-op slot (plan-strategy §2 D-2) ──────────────────────
  private _activeOp: ActiveOp | null = null;

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

  constructor(doc: EditSession = createEditSession()) {
    this.doc = doc;
  }

  // ── Executor: build ApplierCtx (plan-strategy §2 D-2) ────────────────────

  /** Build the IoC context for an applier execution.
   *  ctx.engine / ctx.dispatchSub / ctx.query — NO world field (AC-01). */
  private _buildCtx(): ApplierCtx {
    const engine = this._getEngineFacade();
    // Read-side reader bound to the LIVE world (makeQueryFn calls getWorld per
    // query, so a world swap is reflected) — sunk assembly, w10.
    const query: QuerySnapshotFn = makeQueryFn(() => this.doc.world);
    // dispatchSub: recursive dispatch through the executor — replaces M1's
    // module-level _dispatchDocumentSub for transaction/plan sub-ops.
    // Nested spans are automatically created via _execDocumentApplier.
    const dispatchSub = (_kind: string, sub: EditorOp): ReturnType<ApplierFn> => {
      return this._execDocumentApplier(sub);
    };
    return { engine, assetIO, dispatchSub, query };
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
      // Span-pushing sub-dispatch: a transaction sub-op recurses back through
      // the executor so each sub-op gets its own child span AND records its own
      // engine leaves via the same cached facade (AC-07 + AC-09). The SAME alias
      // map is reused so placeholders stay resolvable across the transaction.
      dispatchSub: (_ctx, sub) => this._execDocumentApplier(sub, alias),
      // Read side: same query-snapshot the session/eval ctx exposes (D-2 ctx
      // contract, t12a). Document appliers don't read it, but it is part of the
      // ctx shape and available for defined document ops that might. Sunk
      // assembly via makeQueryFn (w10); DocQueryFn's structural (desc:unknown)
      // shape widens the io QuerySnapshotFn — cast at the boundary as before.
      query: makeQueryFn(() => this.doc.world) as unknown as DocApplierCtx['query'],
    };
    return ctx;
  }

  /** Execute a document applier through the executor: build DocApplierCtx →
   *  pushSpan → call applier(ctx, cmd) → popSpan.
   *  Used by dispatch (and, via ctx.dispatchSub, by transaction sub-ops).
   *
   *  The applier receives a DocApplierCtx whose only world access is the
   *  controlled `engine` proxy — no raw world, no EditSession (AC-01 / D-2).
   *  Every write it performs records its engine interface leaf onto the span
   *  pushed here (AC-09). */
  private _execDocumentApplier(cmd: EditorOp, alias: DocAliasMap = new Map()): ReturnType<ApplierFn> {
    const kind = cmd.kind;
    const applier = documentAppliers.get(kind);
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

  dispatch(cmd: EditorOp, origin: CommandOrigin = 'human'): DispatchResult {
    const kind = cmd.kind;

    // Scan-lock guard: during startup scan, reject all dispatch until catalog is ready.
    // This is an infrastructure guard (not an op), matching the north-star §8 principle
    // that scan is a pre-condition phase before the editor is usable.
    if (this._scanLocked) {
      return { ok: false, error: { code: 'scan-in-progress', hint: 'Asset scan is in progress; edits are blocked until catalog is ready.' } };
    }

    // Three-tier routing: the DOMAIN of an op = which applier table registers its
    // kind (plan-strategy §2 D-1, structural, no bypassable label). Unregistered
    // kind → UNKNOWN_OP (Fail Fast; headless play/stop lands here — D-11).
    const domain = domainOf(kind);
    if (domain === null) {
      // D-11: play/stop are session ops whose applier is registered by
      // edit-runtime at boot (registerSessionApplier). In headless core they are
      // legitimately absent — say so instead of a generic miss, so a headless AI
      // caller learns it is a boot-registered capability, not a typo.
      const hint = (kind === 'play' || kind === 'stop')
        ? `op "${kind}" has no applier registered; edit-runtime registers it at boot via registerSessionApplier (D-11) — unavailable in headless core`
        : `no applier registered for "${kind}"; see listOps()`;
      return { ok: false, error: { code: 'UNKNOWN_OP', hint } };
    }

    if (domain === 'document') {
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
          },
        };
      }
      // Document ops: executor wraps applier → ctx created → span pushed.
      const r = this._execDocumentApplier(cmd);
      if (!r.ok) return r;
      // transientMode (play·scene): still apply + emit for immediate feedback,
      // but skip undo/ledger writes (AC-09) — the non-committing edit mode.
      if (!this.transientMode) {
        this.undoStack.push({ cmd, inverse: r.inverse, origin });
        this.redoStack.length = 0;
        this.ledger.push(cmd);
        this.origins.push(origin);
      }
      // emit() fires the bus subscribers (docVersion re-render + _isDirty tracker
      // + engine sync repaint) — the World changed, so panels/disk must react.
      this.emit(cmd);
      return { ok: true };
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

    // Session / transient ops: executor builds ctx → pushes span → calls applier.
    // M3 t20d (D-12): the ctx is passed as the SECOND arg (applier(op, ctx)) so a
    // session applier can move the engine world through ctx.engine — cameraOrbit's
    // applier is the ONLY camera-move path when an AI drives it over eval (no
    // per-frame facade write). Existing session appliers keep their (op) signature
    // and simply ignore the extra arg (backward compatible — SessionApplier's ctx
    // param is optional). Op stays the first arg (unchanged from M1/M2).
    const applier = (domain === 'session' ? sessionAppliers : transientAppliers).get(kind);
    if (!applier) return { ok: false, error: { code: 'UNKNOWN_OP', hint: `applier not found for "${kind}"` } };
    const ctx = this._buildCtx();
    pushSpan(kind);
    const sResult = applier(cmd, ctx);
    const sOk = sResult.ok;
    popSpan(sOk ? 'OK' : 'ERROR');
    if (!sOk) return sResult;

    // Ledger-only middle tier (plan-strategy §2 D-1): session ops append to the
    // flat append-only ledger (never the undo stack — they carry no inverse);
    // transient ops append to neither. transientMode gates ALL THREE domains
    // uniformly (AC-09): under it, even session ops skip the ledger write.
    // M4 t28: defineOp-cast session ops push their sub-ops to ledger inside
    // the applier itself (D-7: each sub-op gets its own flat entry). Skip the
    // top-level dispatch-level push to avoid double-counting.
    if (!this.transientMode && domain === 'session') {
      const desc = getOp(kind);
      if (!(desc && desc.source === 'defined')) {
        this.ledger.push(cmd);
        this.origins.push(origin);
      }
    }
    return { ok: true };
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
    // Discharge current state: revert to pre-begin, then re-apply with accumulated patch.
    const revertR = applyCommand(this.doc, active.beginInverse);
    if (!revertR.ok) {
      return { ok: false, error: { code: 'SET_FAILED', hint: 'failed to revert during update' } };
    }
    // Build the accumulated command from beginCmd + patch
    const updatedCmd = { ...active.beginCmd, ...patch } as EditorOp;
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
    this.redoStack.push({ cmd: entry.cmd, inverse: r.inverse, origin: entry.origin });
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
    this.undoStack.push({ cmd: entry.cmd, inverse: r.inverse, origin: entry.origin });
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

  private emit(last: EditorOp): void {
    this._rev++;
    for (const fn of this.listeners) fn(this.doc, last);
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

  /** Operation catalog — AI self-introspection + command palette SSOT. */
  listOps(): readonly OpDescriptor[] {
    return catalogListOps();
  }

  /** Register a builtin op at catalog build time. */
  static registerBuiltinOp(op: Readonly<OpDescriptor>): void {
    registerBuiltinOp(op);
  }

  /** Build a query-snapshot function for defineOp plan(). Public entry face is
   *  frozen (AC-03); the read-side assembly it returns is sunk into
   *  io/gateway-query.ts (makeQueryFn, w10). */
  buildQueryFn(): QuerySnapshotFn {
    return makeQueryFn(() => this.doc.world);
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

    if (domain === 'document') {
      // EXISTING document-domain path: transaction wrapper → undo+ledger.
      // The executor invokes this applier with a DocApplierCtx as the first arg
      // (F-1), which this defineOp path does not consume — it delegates to the
      // public applyCommand(this.doc, …), which builds its own ctx from the live
      // session. this.doc IS the session the executor's ctx wraps, so routing
      // through it is behavior-identical AND keeps the facade leaf recording
      // (applyCommand's facade writes onto the span _execDocumentApplier pushed).
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      documentAppliers.set(id, (_ctx: unknown, cmd: EditorOp) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { kind: _kind, ...args } = cmd as { kind: string } & Record<string, unknown>;
        const query: unknown = makeQueryFn(() => this.doc.world);

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
      });
    } else {
      // ── Session domain (M4 t28, plan-strategy §2 D-7) ──
      // Register a session applier that, on dispatch, runs the plan and
      // emits each sub-op through the session executor path.
      // Ledger layout: each sub-op gets its own flat entry (D-7: no composite).
      // Partial failure: first fail stops, PLAN_STEP_FAILED, already-emitted
      // ops stay in ledger (AC-18: append-only, never rollback).
      sessionAppliers.set(id, ((op: EditorOp, _ctx?: SessionApplierCtx) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { kind: _kind, ...args } = op as { kind: string } & Record<string, unknown>;
        const query: unknown = makeQueryFn(() => this.doc.world);

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

          const applier = (subDomain === 'session' ? sessionAppliers : transientAppliers).get(subOp.kind);
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
          }
        }

        return { ok: true };
      }));
    }

    // Register in catalog — source='defined', visible in listOps immediately
    registerDefinedOp({
      id,
      domain: domain as 'document' | 'session',
      argsSchema: argsSchema as ArgsSchema | null,
      title: id,
    });

    return { ok: true };
  }
}
