// io/appliers — three-tier applier registration tables for EditGateway dispatch
//
// feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop M1:
// Three registration tables (documentAppliers / sessionAppliers / transientAppliers)
// determine the domain of each op. The domain = which table the applier is
// registered in (structural, not labeled — plan-strategy S2 D-1).
//
// documentAppliers: produce inverse → undoStack.push + ledger.push
// sessionAppliers: no inverse → ledger.push only (no undo)
// transientAppliers: no inverse, no ledger, no undo (emit only)
//
// M1 scope: documentAppliers seeded with the 9 existing applyCommand cases.
// sessionAppliers / transientAppliers start empty — filled in M2.
//
// Anchors:
//   plan-strategy S2 D-1: three registration tables
//   requirements AC-09: routing structural, not label-based
//   research F4: inverse split point already exists in applyCommand

import type { CommandError, EditorOp } from '../types';
import type { ApplyResult } from '../types';
import { applyCommand } from '../session/document';
import { registerBuiltinOp as catalogRegisterBuiltinOp } from './catalog';

// ── Applier types ────────────────────────────────────────────────────────────

/** A DOCUMENT applier: takes the session and op, returns ApplyResult (with an
 *  inverse for free Undo). */
export type ApplierFn = (session: unknown, cmd: EditorOp) => ApplyResult;

/** Type alias for the document registration map: op kind → applier function. */
export type ApplierMap = Map<string, ApplierFn>;

/** A SESSION / TRANSIENT applier (plan-strategy §2 D-11): takes only the op and
 *  returns success or a structured error — NO inverse (session/transient ops are
 *  not undoable). The applier mutates the store module's own state and fires its
 *  own listeners; the gateway records the ledger entry (session) or nothing
 *  (transient) purely from which table the kind is registered in. */
export type SessionApplier = (op: EditorOp) => { ok: true } | { ok: false; error: CommandError };

/** Type alias for the session/transient registration map. */
export type SessionApplierMap = Map<string, SessionApplier>;

/** Domain derived from which table the applier is registered in. */
export type OpDomain = 'document' | 'session' | 'transient';

// ── Registration tables ──────────────────────────────────────────────────────

/** document-domain appliers: produce inverse → undo + ledger. */
export const documentAppliers: ApplierMap = new Map();

/** session-domain appliers: no inverse → ledger only. Filled at store-module
 *  eval time (selection/gizmo-mode/frame-request/rename-request/scene-persistence)
 *  and, for play/stop, at edit-runtime boot via registerSessionApplier (D-11). */
export const sessionAppliers: SessionApplierMap = new Map();

/** transient-domain appliers: no inverse, no ledger, no undo (emit only). */
export const transientAppliers: SessionApplierMap = new Map();

// ── Seed document appliers (plan-strategy S2 D-1: 9 existing applyCommand cases) ──

const applierFromApply = (fn: typeof applyCommand): ApplierFn =>
  (session, cmd) => fn(session as Parameters<typeof applyCommand>[0], cmd);

const DOCUMENT_KINDS = [
  'spawnEntity',
  'destroyEntity',
  'rename',
  'reparent',
  'setComponent',
  'addComponent',
  'removeComponent',
  'setHidden',
  'transaction',
] as const;

for (const kind of DOCUMENT_KINDS) {
  documentAppliers.set(kind, applierFromApply(applyCommand));
}

// ── Domain lookup ─────────────────────────────────────────────────────────────

/** Return the domain of an op kind, or null if unregistered. */
export function domainOf(kind: string): OpDomain | null {
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

/** Optional self-description for a registered op (consumed by the M4 catalog /
 *  listOps). Kept plain-JSON so listOps can serialize it (Schema as Contract). */
export interface SessionApplierMeta {
  /** Lightweight JSON-Schema-subset for the op's args (M4 catalog validation). */
  argsSchema?: unknown;
  /** Human-readable label for the command palette (M4). */
  title?: string;
}

/** Registry of meta for dynamically-registered session ops (M4 catalog reads
 *  this; empty for kinds registered without meta). Keyed by op kind. */
export const sessionApplierMeta: Map<string, SessionApplierMeta> = new Map();

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
 * Re-registering an already-registered kind throws OpRegistrationError with
 * code 'OP_ID_CONFLICT' (edge #3 / D-7) — the existing registration is left
 * intact. A kind already claimed by the document or transient table also
 * conflicts (a kind lives in exactly one domain).
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
  const existing = domainOf(kind);
  if (existing !== null) {
    throw new OpRegistrationError('OP_ID_CONFLICT', `op "${kind}" already registered (domain: ${existing})`);
  }
  sessionAppliers.set(kind, applier);
  if (meta) sessionApplierMeta.set(kind, meta);
  let live = true;
  return () => {
    if (!live) return; // idempotent
    live = false;
    // Only remove if this exact applier is still the registered one (defensive
    // against a later re-registration having replaced it).
    if (sessionAppliers.get(kind) === applier) sessionAppliers.delete(kind);
    sessionApplierMeta.delete(kind);
  };
}