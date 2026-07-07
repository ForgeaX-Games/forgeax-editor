// io/appliers — unified applier registration table for EditGateway dispatch
//
// feat-20260707-editor-trace-ioc M1 t1:
// Three registration tables (documentAppliers / sessionAppliers / transientAppliers)
// converged into a single SSOT table _applierTable + single entry point
// registerApplier(domain, kind, applier, meta). Domain information moved from
// "which table the applier is in" into a field on the table entry (SSOT §1).
// DOCUMENT_KINDS hardcoded array eliminated — content declared by registerApplier
// callers. registerSessionApplier demoted to thin wrapper over registerApplier.
// applierFromApply adapter removed.
//
// M1 scope: documentAppliers seeded with the 9 existing applyCommand cases.
// sessionAppliers / transientAppliers start empty — filled in M2.
//
// Backward compatibility: documentAppliers / sessionAppliers / transientAppliers
// remain exported as Map objects for consumers (gateway.ts dispatch, store modules)
// that read from or write to them directly. registerApplier synchronizes writes to
// both the unified table and the legacy Map. domainOf reads from the unified table.
//
// Anchors:
//   plan-strategy §2 D-1: single registration table
//   requirements AC-24: registerApplier(domain, kind, applier, meta) single entry
//   requirements S11: three-domain registration symmetry
//   research F-6: applyCommand switch break-out needs unified table

import type { CommandError, EditorOp } from '../types';
import type { ApplyResult } from '../types';
import {
  applyCommand,
  applySpawnEntity,
  applyDestroyEntity,
  applyRename,
  applyReparent,
  applySetComponent,
  applyAddComponent,
  applyRemoveComponent,
  applySetHidden,
  applyTransaction,
} from '../session/document';
import { registerBuiltinOp as catalogRegisterBuiltinOp } from './catalog';

// ── Applier types ────────────────────────────────────────────────────────────

/** A DOCUMENT applier: takes the session and op, returns ApplyResult (with an
 *  inverse for free Undo). */
export type ApplierFn = (session: unknown, cmd: EditorOp) => ApplyResult;

/** Type alias for the document registration map: op kind → applier function. */
export type ApplierMap = Map<string, ApplierFn>;

/** The IoC context a session/transient applier receives as its SECOND arg
 *  (M3 t20d). Structurally mirrors the gateway's ApplierCtx `engine` field — kept
 *  as a local shape here (not imported from gateway) to avoid an appliers↔gateway
 *  import cycle. Optional so existing (op)-only session appliers stay compatible. */
export interface SessionApplierCtx {
  /** Controlled engine-write proxy (the same EngineFacade the document executor
   *  hands document appliers via ctx.engine). A session applier that must move the
   *  engine world (e.g. cameraOrbit, D-12) writes through this — the ONLY move path
   *  when an AI drives the op over eval (no per-frame facade write). */
  engine: {
    set(entity: number, component: unknown, data: Record<string, unknown>): unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawn(...components: any[]): any;
    despawn(entity: number): unknown;
    allocSharedRef(type: unknown, asset: unknown): unknown;
    get(entity: number, component: unknown): unknown;
  };
}

/** A SESSION / TRANSIENT applier (plan-strategy §2 D-11): takes the op and an
 *  optional IoC ctx (M3 t20d, D-12), returns success or a structured error — NO
 *  inverse (session/transient ops are not undoable). The applier mutates the store
 *  module's own state (and, via ctx.engine, the engine world) and fires its own
 *  listeners; the gateway records the ledger entry (session) or nothing (transient)
 *  purely from which table the kind is registered in. */
export type SessionApplier = (op: EditorOp, ctx?: SessionApplierCtx) => { ok: true } | { ok: false; error: CommandError };

/** Type alias for the session/transient registration map. */
export type SessionApplierMap = Map<string, SessionApplier>;

/** Domain derived from which table the applier is registered in. */
export type OpDomain = 'document' | 'session' | 'transient';

// ── Unified table (SSOT, plan-strategy §2 D-1) ───────────────────────────────

interface ApplierTableEntry {
  domain: OpDomain;
  applier: ApplierFn | SessionApplier;
  meta?: SessionApplierMeta;
}

/** Single SSOT registration table. Domain is a field on each entry —
 *  readers never need to guess which table a kind lives in (§1). */
const _applierTable = new Map<string, ApplierTableEntry>();

// ── Backward-compatible Map exports ──────────────────────────────────────────
// These Maps are synchronized with _applierTable: every write syncs to both.
// They remain exported so existing consumers (gateway.ts dispatch, store modules)
// work unchanged — the transition to reading from _applierTable is M1 t2-t4.

/** document-domain appliers: produce inverse → undo + ledger. */
export const documentAppliers: ApplierMap = new Map();

/** session-domain appliers: no inverse → ledger only. Filled at store-module
 *  eval time (selection/gizmo-mode/frame-request/rename-request/scene-persistence)
 *  and, for play/stop, at edit-runtime boot via registerSessionApplier (D-11). */
export const sessionAppliers: SessionApplierMap = new Map();

/** transient-domain appliers: no inverse, no ledger, no undo (emit only). */
export const transientAppliers: SessionApplierMap = new Map();

// ── Unified registration API (plan-strategy §2 D-1, requirements S11 / AC-24) ─

/**
 * Register an applier for a given domain and op kind.
 * This is the single entry point for all three domains — domain information is
 * a field on the entry, not derived from which table the applier is in (SSOT §1).
 *
 * Re-registering an already-registered kind in a different domain throws
 * OpRegistrationError with code 'OP_ID_CONFLICT'. Re-registering the same
 * domain+kind is a no-op (idempotent registration).
 *
 * @param domain  'document' | 'session' | 'transient'
 * @param kind    op kind string
 * @param applier the applier function (ApplierFn for document, SessionApplier for session/transient)
 * @param meta    optional self-description for catalog / listOps
 */
export function registerApplier(
  domain: OpDomain,
  kind: string,
  applier: ApplierFn | SessionApplier,
  meta?: SessionApplierMeta,
): void {
  const existing = _applierTable.get(kind);
  if (existing !== undefined && existing.domain !== domain) {
    throw new OpRegistrationError(
      'OP_ID_CONFLICT',
      `op "${kind}" already registered (domain: ${existing.domain})`,
    );
  }
  // Write to unified table (SSOT)
  _applierTable.set(kind, { domain, applier: applier as ApplierTableEntry['applier'], meta });
  // Sync to backward-compatible Maps
  if (domain === 'document') {
    documentAppliers.set(kind, applier as ApplierFn);
  } else if (domain === 'session') {
    sessionAppliers.set(kind, applier as SessionApplier);
  } else {
    transientAppliers.set(kind, applier as SessionApplier);
  }
}

/** Remove an applier from the unified table (and all legacy Maps).
 *  Used by unregister callback from registerSessionApplier.
 *  Idempotent — no-op if the kind is not registered or a different applier
 *  now occupies the slot. */
function _unregisterApplier(kind: string, expectedApplier: ApplierFn | SessionApplier): void {
  const entry = _applierTable.get(kind);
  if (!entry || entry.applier !== expectedApplier) return; // already replaced, no-op
  _applierTable.delete(kind);
  documentAppliers.delete(kind);
  sessionAppliers.delete(kind);
  transientAppliers.delete(kind);
}

// ── Seed document appliers (plan-strategy §2 D-1: 9 existing applyCommand cases) ──
// Each kind is registered explicitly via registerApplier — no DOCUMENT_KINDS
// hardcoded array (AC-24). M1 t2: spawnEntity/destroyEntity/rename/reparent
// now have their own per-op applier functions. The remaining 5 kinds
// (setComponent/addComponent/removeComponent/setHidden/transaction) still
// delegate to applyCommand for now; t3/t4 will replace them.

registerApplier('document', 'spawnEntity', applySpawnEntity as unknown as ApplierFn);
registerApplier('document', 'destroyEntity', applyDestroyEntity as unknown as ApplierFn);
registerApplier('document', 'rename', applyRename as unknown as ApplierFn);
registerApplier('document', 'reparent', applyReparent as unknown as ApplierFn);
	registerApplier('document', 'setComponent', applySetComponent as unknown as ApplierFn);
	registerApplier('document', 'addComponent', applyAddComponent as unknown as ApplierFn);
	registerApplier('document', 'removeComponent', applyRemoveComponent as unknown as ApplierFn);
	registerApplier('document', 'setHidden', applySetHidden as unknown as ApplierFn);

// ── transaction applier (M1 t4 → F-1 IoC: ctx-based recursion) ─────────────
// The transaction applier recurses through `ctx.dispatchSub`, which the caller
// supplies: the gateway executor supplies a span-pushing dispatchSub (nested
// span tree for sub-ops); the public applyCommand path supplies a non-span
// dispatchSub (M1-equivalent behavior). applyTransaction now takes (ctx, cmd)
// directly, so it registers like the other 8 document appliers — the interim
// module-level `_dispatchDocumentSub` span loop is gone (its job moved onto the
// ctx the executor builds, RD-6 satisfied).
registerApplier('document', 'transaction', applyTransaction as unknown as ApplierFn);

// ── Domain lookup ─────────────────────────────────────────────────────────────

/** Return the domain of an op kind, reading from the SSOT unified table.
 *  Falls back to legacy Maps for entries registered before registerApplier
 *  migration (store modules that write sessionAppliers/transientAppliers
 *  directly during module eval). */
export function domainOf(kind: string): OpDomain | null {
  const entry = _applierTable.get(kind);
  if (entry) return entry.domain;
  // Fallback: entries set via legacy Maps directly (store module eval time)
  // before they are migrated to registerApplier. This keeps backward compat
  // during the transition window of t1 (the store modules are migrated in
  // their respective tasks).
  if (documentAppliers.has(kind)) return 'document';
  if (sessionAppliers.has(kind)) return 'session';
  if (transientAppliers.has(kind)) return 'transient';
  return null;
}

// ── D-11 downstream registration seam ─────────────────────────────────────────
//
// registerSessionApplier lets a DAG-downstream package (edit-runtime) register a
// session-domain applier into core's table — the SAME injection direction as the
// ApiClient backend seam (AGENTS.md invariant 2), so it does not violate the DAG
// (core never imports edit-runtime). play·stop use this: their state machine
// lives in edit-runtime and registers the real applier at boot (M3). Until then,
// dispatch({kind:'play'}) in headless core returns UNKNOWN_OP (the seam reflects
// the CURRENT real capability set — no silent swallow).
//
// The domain is decided structurally (D-1): registering into sessionAppliers IS
// what makes the kind a session op — same judgement as the builtin session
// appliers, no field to mislabel.
//
// M1 t1: demoted to thin wrapper over registerApplier('session', …). Preserves
// OP_ID_CONFLICT conflict detection semantics + unregister function return value +
// idempotent delete defense + OpRegistrationError class.

/** Optional self-description for a registered op (consumed by the M4 catalog /
 *  listOps). Kept plain-JSON so listOps can serialize it (Schema as Contract). */
export interface SessionApplierMeta {
  /** Lightweight JSON-Schema-subset for the op's args (M4 catalog validation). */
  argsSchema?: unknown;
  /** Human-readable label for the command palette (M4). */
  title?: string;
}

/** Error thrown by registerSessionApplier on a duplicate kind. Carries the
 *  structured `code` (plan-strategy §2 D-7 OP_ID_CONFLICT) so callers can branch
 *  on it, matching the CommandError shape used elsewhere. */
export class OpRegistrationError extends Error {
  readonly code: CommandError['code'];
  constructor(code: CommandError['code'], message: string) {
    super(message);
    this.name = 'OpRegistrationError';
    this.code = code;
  }
}

/**
 * Register a session-domain applier for `kind` and return an unregister function.
 * Thin wrapper over registerApplier('session', …) with OP_ID_CONFLICT semantics,
 * idempotent unregister, and meta preservation — identical behavior to the
 * pre-M1 implementation.
 *
 * @param kind  op kind (becomes a session op by virtue of this registration)
 * @param applier  the session applier (op) => {ok} | {ok:false,error}
 * @param meta  optional self-description for the M4 catalog / listOps
 * @returns an idempotent unregister function (removes the applier + its meta)
 */
export function registerSessionApplier(
  kind: string,
  applier: SessionApplier,
  meta?: SessionApplierMeta,
): () => void {
  // OP_ID_CONFLICT detection (appliers.ts:147-149): a kind lives in exactly one
  // domain. Re-registering in any domain is a conflict.
  const existing = domainOf(kind);
  if (existing !== null) {
    throw new OpRegistrationError(
      'OP_ID_CONFLICT',
      `op "${kind}" already registered (domain: ${existing})`,
    );
  }
  // Delegates to unified entry — domain='session' is structural (D-1)
  registerApplier('session', kind, applier, meta);
  let live = true;
  return () => {
    if (!live) return; // idempotent
    live = false;
    // Remove from both unified table and legacy Maps
    _unregisterApplier(kind, applier);
  };
}