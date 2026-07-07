import { applyCommand, createEditSession } from '../session/document';
import type { CommandError, EditorOp, EditSession } from '../types';
import { documentAppliers, sessionAppliers, transientAppliers, domainOf } from './appliers';
import type { ApplierFn } from './appliers';
import type { OpDescriptor, PlanFn, ArgsSchema } from './catalog';
import { listOps as catalogListOps, registerBuiltinOp, registerDefinedOp, hasOp, getOp } from './catalog';
import { querySnapshot as _querySnapshot } from './query-snapshot';
import type { QuerySnapshotDescriptor, QuerySnapshotRow, QuerySnapshotFn } from './query-snapshot';
import { validate as validateArgs } from './args-schema';
import type { ValidateResult } from './args-schema';

export type BusListener = (doc: EditSession, lastCommand: EditorOp | null) => void;

export type DispatchResult =
  | { ok: true }
  | { ok: false; error: CommandError };

/** Who issued a command — human UI action vs AI tool-call. */
export type CommandOrigin = 'human' | 'ai';

interface StackEntry {
  cmd: EditorOp;
  inverse: EditorOp;
  origin: CommandOrigin;
}

/** One timeline step for the History panel. */
export interface HistoryStep {
  label: string;
  origin: CommandOrigin;
  /** true if this step is currently undone (a redoable "future" step). */
  future: boolean;
  /** the entity this command operated on, if any (for selection sync). */
  entity?: number;
}

function labelOf(cmd: EditorOp): string {
  return cmd.kind + ('component' in cmd ? ` ${(cmd as { component: string }).component}` : '');
}

function entityOf(cmd: EditorOp): number | undefined {
  return 'entity' in cmd ? (cmd as { entity: number }).entity : undefined;
}

function step(label: string, origin: CommandOrigin, future: boolean, entity: number | undefined): HistoryStep {
  return entity === undefined ? { label, origin, future } : { label, origin, future, entity };
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

let _opHandleCounter = 0;
function nextOpHandleId(): string {
  return `op-${Date.now().toString(36)}-${(_opHandleCounter++).toString(36)}`;
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

  // ── Lifecycle: active-op slot (plan-strategy §2 D-2) ──────────────────────
  private _activeOp: ActiveOp | null = null;

  constructor(doc: EditSession = createEditSession()) {
    this.doc = doc;
  }

  dispatch(cmd: EditorOp, origin: CommandOrigin = 'human'): DispatchResult {
    const kind = cmd.kind;

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
      // Document ops mutate the engine World and produce an inverse for Undo.
      const applier = documentAppliers.get(kind);
      if (!applier) return { ok: false, error: { code: 'UNKNOWN_OP', hint: `applier not found for "${kind}"` } };
      const r = applier(this.doc, cmd);
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

    // Session / transient ops: applier takes only the op (no session, no
    // inverse). The applier mutates its store module's own state and fires that
    // module's own listeners (selection/hover/etc.) — so the gateway must NOT
    // call emit() here (that would fire the doc-version / _isDirty bus
    // subscribers, wrongly marking the scene dirty on every select/hover).
    const applier = (domain === 'session' ? sessionAppliers : transientAppliers).get(kind);
    if (!applier) return { ok: false, error: { code: 'UNKNOWN_OP', hint: `applier not found for "${kind}"` } };
    const r = applier(cmd);
    if (!r.ok) return r;

    // Ledger-only middle tier (plan-strategy §2 D-1): session ops append to the
    // flat append-only ledger (never the undo stack — they carry no inverse);
    // transient ops append to neither. transientMode gates ALL THREE domains
    // uniformly (AC-09): under it, even session ops skip the ledger write.
    if (!this.transientMode && domain === 'session') {
      this.ledger.push(cmd);
      this.origins.push(origin);
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
    const r = applyCommand(this.doc, entry.inverse);
    if (!r.ok) {
      // should not happen; restore stack and bail
      this.undoStack.push(entry);
      return false;
    }
    this.redoStack.push({ cmd: entry.cmd, inverse: r.inverse, origin: entry.origin });
    this.emit(entry.inverse);
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    const r = applyCommand(this.doc, entry.cmd);
    if (!r.ok) {
      this.redoStack.push(entry);
      return false;
    }
    this.undoStack.push({ cmd: entry.cmd, inverse: r.inverse, origin: entry.origin });
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

  /** Build a query-snapshot function for defineOp plan(). */
  buildQueryFn(): QuerySnapshotFn {
    return (descriptor: QuerySnapshotDescriptor): QuerySnapshotRow[] =>
      _querySnapshot(this.doc.world!, descriptor);
  }

  /**
   * defineOp — cast a new operation from primitives at runtime (plan-strategy §2 D-4).
   *
   * Idempotent: defines a new op (does not execute). The op appears in listOps
   * immediately (source='defined'). Dispatch calls later route through the
   * existing document-domain path (applyCommand → inverse → undo+ledger).
   *
   * v1: document domain only. Other domains → INVALID_ARGS.
   * Duplicate id (builtin or already-defined) → OP_ID_CONFLICT.
   */
  defineOp(spec: {
    id: string;
    domain: 'document';
    argsSchema: Record<string, unknown> | null;
    plan: PlanFn;
  }): { ok: true } | { ok: false; error: CommandError } {
    const { id, domain, argsSchema, plan } = spec;

    // v1: document domain only (D-4)
    if (domain !== 'document') {
      return { ok: false, error: { code: 'INVALID_ARGS', hint: 'defineOp v1 only supports domain "document"' } };
    }

    // Duplicate detection: both builtin and previously-defined ids conflict
    if (hasOp(id)) {
      return { ok: false, error: { code: 'OP_ID_CONFLICT', hint: `op "${id}" already exists in catalog` } };
    }

    // Register a custom document applier that wraps plan() → transaction
    // into applyCommand. The existing dispatch() method then handles undo/
    // ledger/inverse automatically through the document-domain path.
    documentAppliers.set(id, (session: unknown, cmd: EditorOp) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { kind: _kind, ...args } = cmd as { kind: string } & Record<string, unknown>;
      const query: unknown = (desc: QuerySnapshotDescriptor): QuerySnapshotRow[] =>
        _querySnapshot(this.doc.world!, desc);

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
      return applyCommand(session as EditSession, txOp);
    });

    // Register in catalog — source='defined', visible in listOps immediately
    registerDefinedOp({
      id,
      domain: 'document',
      argsSchema: argsSchema as ArgsSchema | null,
      title: id,
    });

    return { ok: true };
  }
}
