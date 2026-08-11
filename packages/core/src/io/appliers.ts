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
// Module-owned document/session/transient registrations all enter this table;
// downstream Runtime owners use the same seam and dispose their scoped entry.
//
// Anchors:
//   plan-strategy §2 D-1: single registration table
//   requirements AC-24: registerApplier(domain, kind, applier, meta) single entry
//   requirements S11: three-domain registration symmetry
//   research F-6: applyCommand switch break-out needs unified table

import type { CommandError, EditorOp } from '../types';
import type { CommandOrigin } from './gateway-history';
import type { ApplyResult } from '../types';
import type { RunProgress } from '@forgeax/editor-product';
import type { OperationRunDescriptor } from './catalog';
import {
  applyCommand,
  applySpawnEntity,
  applyDestroyEntity,
  applyRename,
  applyReparent,
  applyHierarchyGesture,
  applySetComponent,
  applySetSceneOverride,
  applyRemoveSceneOverride,
  applyAddComponent,
  applyRemoveComponent,
  applySetVisibility,
  applyInstantiateSceneAsset,
  applyDuplicateEntity,
  applyTransaction,
} from '../session/document';
import { applyVisualQualityPreset } from '../session/visual-quality';

// ── Applier types ────────────────────────────────────────────────────────────

/** A DOCUMENT applier: takes the session and op, returns ApplyResult (with an
 *  inverse for free Undo). */
export type ApplierFn = (session: unknown, cmd: EditorOp) => ApplyResult;

/** The IoC context a session/transient applier receives as its SECOND arg
 *  (M3 t20d). Structurally mirrors the gateway's ApplierCtx `engine` field — kept
 *  as a local shape here (not imported from gateway) to avoid an appliers↔gateway
 *  import cycle. Optional so existing (op)-only session appliers stay compatible. */
export interface SessionApplierCtx {
  /** Origin of the outer Gateway dispatch. Nested effects preserve authorship
   * when they re-enter the same Gateway door. */
  origin: CommandOrigin;
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
  /** Gateway-owned lifecycle reporter. Appliers may publish executor facts
   * without owning a second operation status store. */
  operationRun?: {
    reportProgress(progress: RunProgress): void;
    registerCancelHandler?(handler: () =>
      | { readonly ok: true }
      | { readonly ok: false; readonly error: CommandError }
    ): void;
  };
  /** Resolve a live shared<T> handle to its asset payload against the ACTIVE
   *  world of the dispatching gateway (animation-preview M1: the preview applier
   *  reads a bound clip's duration without importing the gateway singleton —
   *  IoC symmetry with ctx.engine, and test-dispatchable on a throwaway
   *  gateway). */
  resolveAsset?(handle: number):
    | { ok: true; asset: unknown }
    | { ok: false; error: CommandError };
}

/** A SESSION / TRANSIENT applier (plan-strategy §2 D-11): takes the op and an
 *  optional IoC ctx (M3 t20d, D-12), returns success or a structured error — NO
 *  inverse (session/transient ops are not undoable). The applier mutates the store
 *  module's own state (and, via ctx.engine, the engine world) and fires its own
 *  listeners; the gateway records the ledger entry (session) or nothing (transient)
 *  purely from the domain on the active registry entry. */
export type SessionApplier = (op: EditorOp, ctx?: SessionApplierCtx) =>
  | { ok: true; completion?: Promise<unknown> }
  | { ok: false; error: CommandError };

/** Domain carried by the active unified-registry entry. */
export type OpDomain = 'document' | 'session' | 'transient';

// ── Unified table (SSOT, plan-strategy §2 D-1) ───────────────────────────────

interface ApplierTableEntry {
  readonly domain: OpDomain;
  readonly applier: ApplierFn | SessionApplier;
  readonly meta?: SessionApplierMeta;
}

/** Single SSOT registration table. Domain is a field on each entry —
 *  readers never need to guess which table a kind lives in (§1). */
const _applierTable = new Map<string, ApplierTableEntry[]>();
let _applierRevision = 0;
const _applierListeners = new Set<(revision: number) => void>();

export interface RegisteredApplierDescriptor {
  readonly id: string;
  readonly domain: OpDomain;
  readonly argsSchema?: unknown;
  readonly title?: string;
  readonly operationRun?: OperationRunDescriptor;
}

export interface ApplierRegistrySnapshot {
  readonly revision: number;
  readonly entries: readonly RegisteredApplierDescriptor[];
}

function publishApplierRevision(): void {
  _applierRevision += 1;
  for (const listener of [..._applierListeners]) listener(_applierRevision);
}

function activeEntry(kind: string): ApplierTableEntry | undefined {
  return _applierTable.get(kind)?.at(-1);
}

// ── Unified registration API (plan-strategy §2 D-1, requirements S11 / AC-24) ─

/**
 * Register an applier for a given domain and op kind.
 * This is the single entry point for all three domains — domain information is
 * a field on the entry, not derived from which table the applier is in (SSOT §1).
 *
 * Re-registering an already-registered kind in a different domain throws
 * OpRegistrationError with code 'OP_ID_CONFLICT'. Re-registering the same
 * domain+kind installs a scoped replacement whose disposer restores the
 * previous entry. That makes tests and host lifecycles reversible without
 * exposing the backing table as a second mutation surface.
 *
 * @param domain  'document' | 'session' | 'transient'
 * @param kind    op kind string
 * @param applier the applier function (ApplierFn for document, SessionApplier for session/transient)
 * @param meta    optional self-description for catalog / listOps
 */
export function registerApplier(
  domain: 'document',
  kind: string,
  applier: ApplierFn,
  meta?: SessionApplierMeta,
): () => void;
export function registerApplier(
  domain: 'session' | 'transient',
  kind: string,
  applier: SessionApplier,
  meta?: SessionApplierMeta,
): () => void;
export function registerApplier(
  domain: OpDomain,
  kind: string,
  applier: ApplierFn | SessionApplier,
  meta?: SessionApplierMeta,
): () => void;
export function registerApplier(
  domain: OpDomain,
  kind: string,
  applier: ApplierFn | SessionApplier,
  meta?: SessionApplierMeta,
): () => void {
  const entries = _applierTable.get(kind) ?? [];
  const existing = entries.at(-1);
  if (existing !== undefined && existing.domain !== domain) {
    throw new OpRegistrationError(
      'OP_ID_CONFLICT',
      `op "${kind}" already registered (domain: ${existing.domain})`,
    );
  }
  const next: ApplierTableEntry = { domain, applier, ...(meta === undefined ? {} : { meta }) };
  entries.push(next);
  _applierTable.set(kind, entries);
  publishApplierRevision();
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    const currentEntries = _applierTable.get(kind);
    if (currentEntries === undefined) return;
    const at = currentEntries.lastIndexOf(next);
    if (at < 0) return;
    const wasActive = at === currentEntries.length - 1;
    currentEntries.splice(at, 1);
    if (currentEntries.length === 0) _applierTable.delete(kind);
    if (wasActive) publishApplierRevision();
  };
}

// ── Seed document appliers (plan-strategy §2 D-1: 9 existing applyCommand cases) ──
// Each kind is registered explicitly via registerApplier — no DOCUMENT_KINDS
// hardcoded array (AC-24). M1 t2: spawnEntity/destroyEntity/rename/reparent
// now have their own per-op applier functions. The remaining 5 kinds
// (setComponent/addComponent/removeComponent/setVisibility/transaction) still
// delegate to applyCommand for now; t3/t4 will replace them.

registerApplier('document', 'spawnEntity', applySpawnEntity as unknown as ApplierFn);
registerApplier('document', 'destroyEntity', applyDestroyEntity as unknown as ApplierFn);
registerApplier('document', 'rename', applyRename as unknown as ApplierFn);
registerApplier('document', 'reparent', applyReparent as unknown as ApplierFn);
registerApplier('document', 'hierarchyGesture', applyHierarchyGesture as unknown as ApplierFn);
registerApplier('document', 'setComponent', applySetComponent as unknown as ApplierFn);
registerApplier('document', 'setSceneOverride', applySetSceneOverride as unknown as ApplierFn);
registerApplier('document', 'removeSceneOverride', applyRemoveSceneOverride as unknown as ApplierFn);
registerApplier('document', 'addComponent', applyAddComponent as unknown as ApplierFn);
registerApplier('document', 'removeComponent', applyRemoveComponent as unknown as ApplierFn);
registerApplier('document', 'setVisibility', applySetVisibility as unknown as ApplierFn);
registerApplier('document', 'instantiateSceneAsset', applyInstantiateSceneAsset as unknown as ApplierFn);
registerApplier('document', 'duplicateEntity', applyDuplicateEntity as unknown as ApplierFn);
registerApplier('document', 'applyVisualQualityPreset', applyVisualQualityPreset as unknown as ApplierFn);

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

/** Return the domain of an op kind from the single registration table. */
export function domainOf(kind: string): OpDomain | null {
  return activeEntry(kind)?.domain ?? null;
}

export function applierFor(kind: string, domain: 'document'): ApplierFn | undefined;
export function applierFor(kind: string, domain: 'session' | 'transient'): SessionApplier | undefined;
export function applierFor(
  kind: string,
  domain: OpDomain,
): ApplierFn | SessionApplier | undefined {
  const entry = activeEntry(kind);
  return entry?.domain === domain ? entry.applier : undefined;
}

export function applierRegistrySnapshot(): ApplierRegistrySnapshot {
  return Object.freeze({
    revision: _applierRevision,
    entries: Object.freeze([..._applierTable].flatMap(([id, registrations]) => {
      const entry = registrations.at(-1);
      if (entry === undefined) return [];
      return [Object.freeze({
        id,
        domain: entry.domain,
        ...(entry.meta?.argsSchema === undefined ? {} : { argsSchema: structuredClone(entry.meta.argsSchema) }),
        ...(entry.meta?.title === undefined ? {} : { title: entry.meta.title }),
        ...(entry.meta?.operationRun === undefined
          ? {}
          : { operationRun: structuredClone(entry.meta.operationRun) }),
      })];
    })),
  });
}

export function subscribeApplierRegistry(listener: (revision: number) => void): () => void {
  _applierListeners.add(listener);
  return () => _applierListeners.delete(listener);
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
// The domain is decided structurally (D-1): the unified registry entry makes the
// kind a session op — same judgement as the builtin session appliers, with no
// parallel label to drift.
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
  /** Gateway-owned async lifecycle contract. A downstream applier that returns
   * a completion Promise declares this once so dispatch can create the same
   * request-correlated OperationRun used by builtin async operations. */
  operationRun?: OperationRunDescriptor;
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
  return registerApplier('session', kind, applier, meta);
}

/** Register a read-only/transient downstream capability with symmetric cleanup. */
export function registerTransientApplier(
  kind: string,
  applier: SessionApplier,
  meta?: SessionApplierMeta,
): () => void {
  const existing = domainOf(kind);
  if (existing !== null) {
    throw new OpRegistrationError(
      'OP_ID_CONFLICT',
      `op "${kind}" already registered (domain: ${existing})`,
    );
  }
  return registerApplier('transient', kind, applier, meta);
}
