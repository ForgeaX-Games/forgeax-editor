// io/diagnostics — bounded, read-only diagnostics aggregation (R0-07C).
//
// The Gateway exposes one snapshot assembled from facts that already have an
// owner: trace owns span retention, the ledger owns scan-validation results,
// the asset-error bus owns asynchronous asset notifications, and the
// OperationRun registry owns request-correlated lifecycle state. This module
// does not intercept console output and does not create a second terminal
// status map.
//
// Dedupe is source-specific and latest-wins. Retention is explicit in the
// public snapshot so a consumer can distinguish "not present" from "evicted".
// The aggregator's bounded views never enlarge the owning source's retention.

import type { ScanDiagnostic } from '../scan/scan-diagnostic';
import type { EditorOp } from '../types';
import type { AssetsErrorPayload } from '../store/assets-error-bus';
import type { ErrorObjectRefs, ErrorSubjectRef } from '@forgeax/editor-product';
import type { OperationRun, OperationRunSnapshot } from './operation-runs';
import type { SpanNode } from './trace';
import type { RuntimeReadiness } from './vfx-runtime-readiness';

export const DIAGNOSTICS_SCHEMA_VERSION = 'diagnostics/v1' as const;

export interface DiagnosticsRetention {
  readonly traceRoots: number;
  readonly scanDiagnostics: number;
  readonly assetErrors: number;
  readonly operationRuns: number;
  readonly runtimeFacts: number;
}

export const DIAGNOSTICS_RETENTION: Readonly<DiagnosticsRetention> = Object.freeze({
  traceRoots: 64,
  scanDiagnostics: 128,
  assetErrors: 64,
  operationRuns: 64,
  runtimeFacts: 128,
});

export const DIAGNOSTICS_DEDUPE = Object.freeze({
  traceRoots: 'traceId',
  scanDiagnostics: 'file+severity+code+message+suggestion',
  assetErrors: 'op+path+hint',
  operationRuns: 'runId',
  runtimeFacts: 'providerId+id',
});

export type DiagnosticsDedupe = typeof DIAGNOSTICS_DEDUPE;

export interface DiagnosticsReadModelOptions {
  readonly retention?: Partial<DiagnosticsRetention>;
}

export interface DiagnosticsTraceSource {
  readonly roots: readonly SpanNode[];
  /** Producer-owned trace evictions; the trace ring is the retention SSOT. */
  readonly dropped: number;
  readonly deduplicated: number;
}

export interface DiagnosticsScanSource {
  readonly diagnostics: readonly ScanDiagnostic[];
  readonly dropped: number;
  readonly deduplicated: number;
}

export interface DiagnosticsAssetSource {
  readonly errors: readonly AssetsErrorPayload[];
  readonly dropped: number;
  readonly deduplicated: number;
}

export interface DiagnosticsOperationRunSource {
  readonly runs: readonly OperationRun[];
  readonly registryRevision: number;
  /** Runs evicted by this bounded projection; the journal owns its own expiry. */
  readonly dropped: number;
  readonly deduplicated: number;
}

/**
 * A producer-owned, JSON-safe runtime fact projected through the Gateway.
 * Runtime owners retain their own state; the Gateway only bounds and indexes
 * the current read projection.
 */
export interface RuntimeDiagnosticFact {
  readonly id: string;
  readonly severity: DiagnosticsSeverity;
  readonly code: string;
  readonly title: string;
  readonly message: string;
  readonly path?: string;
  readonly requestId?: string;
  readonly assetGuid?: string;
  readonly subjectRef?: ErrorSubjectRef;
  readonly objectRefs?: ErrorObjectRefs;
  readonly retryable: boolean;
  readonly recoveryActions: readonly string[];
  /** Producer-owned JSON-safe facts; consumers must not use this as control. */
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface RuntimeDiagnosticProjectionFact extends RuntimeDiagnosticFact {
  readonly providerId: string;
}

/** Runtime owners register one read-only provider instead of creating a store. */
export interface RuntimeDiagnosticsProvider {
  readonly id: string;
  readonly snapshot: () => readonly RuntimeDiagnosticFact[];
  readonly subscribe?: (listener: () => void) => () => void;
}

export interface DiagnosticsSnapshot {
  readonly schemaVersion: typeof DIAGNOSTICS_SCHEMA_VERSION;
  /** Monotonic composite of session, run-registry, and asset-bus revisions. */
  readonly revision: number;
  readonly trace: DiagnosticsTraceSource;
  readonly scan: DiagnosticsScanSource;
  readonly assets: DiagnosticsAssetSource;
  readonly operationRuns: DiagnosticsOperationRunSource;
  readonly runtime: {
    readonly facts: readonly RuntimeDiagnosticProjectionFact[];
    readonly dropped: number;
    readonly deduplicated: number;
  };
  readonly policy: {
    readonly retention: DiagnosticsRetention;
    readonly dedupe: DiagnosticsDedupe;
  };
}

export type DiagnosticsSource = 'trace' | 'scan' | 'assets' | 'operationRuns' | 'runtime';
export type DiagnosticsSeverity = 'error' | 'warn' | 'info';

export interface RuntimeReadinessDiagnostic {
  readonly source: 'operationRuns';
  readonly severity: 'info' | 'warn';
  readonly code: 'runtime-readiness';
  readonly requestId: string;
  readonly assetGuid: string;
  readonly revision: RuntimeReadiness['residentRevision'];
  readonly state: RuntimeReadiness['state'];
  readonly hint: string;
  readonly retryable: boolean;
}

export function runtimeReadinessDiagnostic(readiness: RuntimeReadiness): RuntimeReadinessDiagnostic {
  return Object.freeze({
    source: 'operationRuns',
    severity: readiness.state === 'render-unavailable' ? 'warn' as const : 'info' as const,
    code: 'runtime-readiness' as const,
    requestId: readiness.requestId,
    assetGuid: readiness.assetGuid,
    revision: readiness.residentRevision ?? readiness.committedRevision,
    state: readiness.state,
    hint: readiness.hint,
    retryable: readiness.state === 'render-unavailable',
  });
}

export interface DiagnosticsQueryRequest {
  readonly query?: string;
  readonly sources?: readonly DiagnosticsSource[];
  readonly severities?: readonly DiagnosticsSeverity[];
  /** Maximum returned items. Results are always bounded by this limit. */
  readonly limit?: number;
}

export interface DiagnosticsQueryItem {
  readonly id: string;
  readonly source: DiagnosticsSource;
  readonly severity: DiagnosticsSeverity;
  readonly code: string;
  readonly title: string;
  readonly message: string;
  readonly path?: string;
  readonly runId?: string;
  readonly requestId?: string;
  readonly operationId?: string;
  readonly traceId?: string;
  readonly providerId?: string;
  readonly assetGuid?: string;
  readonly subjectRef?: ErrorSubjectRef;
  readonly objectRefs?: ErrorObjectRefs;
  readonly retryable: boolean;
  readonly recoveryActions: readonly string[];
  /** Source-owned JSON-safe facts; consumers must not use detail as a control signal. */
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface DiagnosticsQueryResult {
  readonly schemaVersion: 'diagnostics-query/v1';
  readonly revision: number;
  readonly items: readonly DiagnosticsQueryItem[];
  /** Number of matching items before the result limit was applied. */
  readonly matched: number;
  readonly truncated: boolean;
}

export interface DiagnosticsReadModel {
  snapshot(): DiagnosticsSnapshot;
  query(request?: DiagnosticsQueryRequest): DiagnosticsQueryResult;
}

export interface CreateDiagnosticsReadModelDeps {
  readonly getRevision: () => number;
  readonly getLedger: () => readonly EditorOp[];
  readonly getTraceRoots: (limit: number) => readonly SpanNode[];
  readonly getDroppedTraceCount: () => number;
  readonly getAssetErrors: () => readonly AssetsErrorPayload[];
  readonly getAssetErrorRevision?: () => number;
  readonly getOperationRunSnapshot: () => OperationRunSnapshot;
  readonly getRuntimeDiagnosticsProviders?: () => readonly RuntimeDiagnosticsProvider[];
  readonly getRuntimeDiagnosticsRevision?: () => number;
}

interface DedupeResult<T> {
  readonly items: readonly T[];
  readonly deduplicated: number;
  readonly dropped: number;
}

function dedupeLatest<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  limit: number,
): DedupeResult<T> {
  const byKey = new Map<string, T>();
  let deduplicated = 0;
  let dropped = 0;

  for (const value of values) {
    const key = keyOf(value);
    if (byKey.has(key)) {
      deduplicated += 1;
      byKey.delete(key);
    }
    byKey.set(key, value);
    while (byKey.size > limit) {
      const oldest = byKey.keys().next();
      if (oldest.done) break;
      byKey.delete(oldest.value);
      dropped += 1;
    }
  }

  return {
    items: Object.freeze([...byKey.values()]),
    deduplicated,
    dropped,
  };
}

function isScanDiagnostic(value: unknown): value is ScanDiagnostic {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<ScanDiagnostic>;
  return (
    typeof candidate.file === 'string' &&
    (candidate.severity === 'warn' || candidate.severity === 'error') &&
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string' &&
    (candidate.suggestion === undefined || typeof candidate.suggestion === 'string')
  );
}

function scanDiagnosticsFromLedger(ledger: readonly EditorOp[]): readonly ScanDiagnostic[] {
  const diagnostics: ScanDiagnostic[] = [];
  for (const op of ledger) {
    if (op.kind !== 'assetValidationFailed') continue;
    const candidate = (op as { readonly diagnostics?: unknown }).diagnostics;
    if (!Array.isArray(candidate)) continue;
    for (const value of candidate) {
      if (!isScanDiagnostic(value)) continue;
      diagnostics.push({
        file: value.file,
        severity: value.severity,
        code: value.code,
        message: value.message,
        ...(value.suggestion === undefined ? {} : { suggestion: value.suggestion }),
      });
    }
  }
  return diagnostics;
}

function scanKey(diagnostic: ScanDiagnostic): string {
  return [
    diagnostic.file,
    diagnostic.severity,
    diagnostic.code,
    diagnostic.message,
    diagnostic.suggestion ?? '',
  ].join('\u001f');
}

function assetErrorKey(error: AssetsErrorPayload): string {
  return [error.op, error.path ?? '', error.hint].join('\u001f');
}

function retentionFrom(options: DiagnosticsReadModelOptions): DiagnosticsRetention {
  const requested = options.retention ?? {};
  return Object.freeze({
    traceRoots: Math.max(1, Math.floor(requested.traceRoots ?? DIAGNOSTICS_RETENTION.traceRoots)),
    scanDiagnostics: Math.max(1, Math.floor(requested.scanDiagnostics ?? DIAGNOSTICS_RETENTION.scanDiagnostics)),
    assetErrors: Math.max(1, Math.floor(requested.assetErrors ?? DIAGNOSTICS_RETENTION.assetErrors)),
    operationRuns: Math.max(1, Math.floor(requested.operationRuns ?? DIAGNOSTICS_RETENTION.operationRuns)),
    runtimeFacts: Math.max(1, Math.floor(requested.runtimeFacts ?? DIAGNOSTICS_RETENTION.runtimeFacts)),
  });
}

const DIAGNOSTICS_QUERY_SCHEMA_VERSION = 'diagnostics-query/v1' as const;
const DIAGNOSTICS_QUERY_MAX_LIMIT = 512;

function queryLimit(snapshot: DiagnosticsSnapshot, requested: number | undefined): number {
  const fallback = Math.min(
    DIAGNOSTICS_QUERY_MAX_LIMIT,
    snapshot.policy.retention.traceRoots
      + snapshot.policy.retention.scanDiagnostics
      + snapshot.policy.retention.assetErrors
      + snapshot.policy.retention.operationRuns
      + snapshot.policy.retention.runtimeFacts,
  );
  if (requested === undefined || !Number.isFinite(requested)) return Math.max(1, fallback);
  return Math.max(1, Math.min(DIAGNOSTICS_QUERY_MAX_LIMIT, Math.floor(requested)));
}

function sourceSubject(kind: string, id: string): ErrorSubjectRef {
  return Object.freeze({ kind, id });
}

function traceQueryItems(snapshot: DiagnosticsSnapshot): DiagnosticsQueryItem[] {
  return snapshot.trace.roots
    .filter((root) => root.status === 'ERROR')
    .map((root) => Object.freeze({
      id: `trace:${root.traceId}`,
      source: 'trace' as const,
      severity: 'error' as const,
      code: 'trace-error',
      title: root.name,
      message: `Trace ${root.name} failed.`,
      traceId: root.traceId,
      retryable: false,
      recoveryActions: Object.freeze([]),
      detail: Object.freeze({ source: 'trace', root }),
    }));
}

function scanQueryItems(snapshot: DiagnosticsSnapshot): DiagnosticsQueryItem[] {
  return snapshot.scan.diagnostics.map((diagnostic) => Object.freeze({
    id: `scan:${diagnostic.file}:${diagnostic.severity}:${diagnostic.code}:${diagnostic.message}:${diagnostic.suggestion ?? ''}`,
    source: 'scan' as const,
    severity: diagnostic.severity,
    code: diagnostic.code,
    title: diagnostic.file,
    message: diagnostic.message,
    path: diagnostic.file,
    subjectRef: sourceSubject('source-file', diagnostic.file),
    retryable: false,
    recoveryActions: Object.freeze([]),
    detail: Object.freeze({ source: 'scan', diagnostic }),
  }));
}

function assetQueryItems(snapshot: DiagnosticsSnapshot): DiagnosticsQueryItem[] {
  return snapshot.assets.errors.map((error) => Object.freeze({
    id: `asset:${error.op}:${error.path ?? ''}:${error.hint}`,
    source: 'assets' as const,
    severity: 'error' as const,
    code: `asset-${error.op}`,
    title: error.path ?? error.op,
    message: error.hint,
    ...(error.path === undefined ? {} : {
      path: error.path,
      subjectRef: sourceSubject('file', error.path),
    }),
    retryable: false,
    recoveryActions: Object.freeze([]),
    detail: Object.freeze({ source: 'assets', error }),
  }));
}

function operationQueryItems(snapshot: DiagnosticsSnapshot): DiagnosticsQueryItem[] {
  return snapshot.operationRuns.runs
    .filter((run) => run.error !== undefined || run.status === 'accepted' || run.status === 'running')
    .map((run) => {
      const error = run.error;
      const recoveryActions = error?.recoveryActions ?? run.recoveryActions;
      return Object.freeze({
        id: `operation:${run.runId}`,
        source: 'operationRuns' as const,
        severity: error === undefined ? 'info' as const : 'error' as const,
        code: error?.code ?? `operation-${run.status}`,
        title: error === undefined ? run.operationId : `${run.operationId} failed`,
        message: error?.hint ?? `${run.operationId} is ${run.status}.`,
        ...(error?.objectRefs?.file === undefined ? {} : { path: error.objectRefs.file.id }),
        runId: run.runId,
        ...(run.requestId === undefined ? {} : { requestId: run.requestId }),
        operationId: run.operationId,
        traceId: run.traceId,
        ...(error?.subjectRef === undefined ? {} : { subjectRef: error.subjectRef }),
        ...(error?.objectRefs === undefined ? {} : { objectRefs: error.objectRefs }),
        retryable: run.retryable === true && error?.retryable === true,
        recoveryActions: Object.freeze([...recoveryActions]),
        detail: Object.freeze({ source: 'operationRuns', run }),
      });
    });
}

function runtimeQueryItems(snapshot: DiagnosticsSnapshot): DiagnosticsQueryItem[] {
  return snapshot.runtime.facts.map((fact) => Object.freeze({
    id: `runtime:${fact.providerId}:${fact.id}`,
    source: 'runtime' as const,
    severity: fact.severity,
    code: fact.code,
    title: fact.title,
    message: fact.message,
    ...(fact.path === undefined ? {} : { path: fact.path }),
    ...(fact.requestId === undefined ? {} : { requestId: fact.requestId }),
    ...(fact.assetGuid === undefined ? {} : { assetGuid: fact.assetGuid }),
    providerId: fact.providerId,
    ...(fact.subjectRef === undefined ? {} : { subjectRef: fact.subjectRef }),
    ...(fact.objectRefs === undefined ? {} : { objectRefs: fact.objectRefs }),
    retryable: fact.retryable,
    recoveryActions: Object.freeze([...fact.recoveryActions]),
    detail: Object.freeze({ source: 'runtime', providerId: fact.providerId, fact: fact.detail }),
  }));
}

function queryText(item: DiagnosticsQueryItem): readonly string[] {
  return [
    item.source,
    item.code,
    item.title,
    item.message,
    item.path,
    item.runId,
    item.requestId,
    item.operationId,
    item.traceId,
    item.providerId,
    item.assetGuid,
    item.subjectRef?.id,
    ...Object.values(item.objectRefs ?? {}).map((ref): string | undefined => ref?.id),
    ...item.recoveryActions,
  ].filter((value): value is string => value !== undefined);
}

/** Flatten one snapshot for AI callers and UI projections without new state. */
export function queryDiagnosticsSnapshot(
  snapshot: DiagnosticsSnapshot,
  request: DiagnosticsQueryRequest = {},
): DiagnosticsQueryResult {
  const query = request.query?.trim().toLowerCase() ?? '';
  const sources = request.sources === undefined || request.sources.length === 0 ? undefined : new Set(request.sources);
  const severities = request.severities === undefined || request.severities.length === 0 ? undefined : new Set(request.severities);
  const all = [
    ...traceQueryItems(snapshot),
    ...scanQueryItems(snapshot),
    ...assetQueryItems(snapshot),
    ...operationQueryItems(snapshot),
    ...runtimeQueryItems(snapshot),
  ];
  const matchedItems = all.filter((item) => {
    if (sources !== undefined && !sources.has(item.source)) return false;
    if (severities !== undefined && !severities.has(item.severity)) return false;
    return query === '' || queryText(item).some((value) => value.toLowerCase().includes(query));
  });
  const limit = queryLimit(snapshot, request.limit);
  return Object.freeze({
    schemaVersion: DIAGNOSTICS_QUERY_SCHEMA_VERSION,
    revision: snapshot.revision,
    items: Object.freeze(matchedItems.slice(0, limit)),
    matched: matchedItems.length,
    truncated: matchedItems.length > limit,
  });
}

/** Build a Gateway-owned projection without adding another diagnostics fact store. */
export function createDiagnosticsReadModel(
  deps: CreateDiagnosticsReadModelDeps,
  options: DiagnosticsReadModelOptions = {},
): DiagnosticsReadModel {
  const retention = retentionFrom(options);
  const policy = Object.freeze({ retention, dedupe: DIAGNOSTICS_DEDUPE });
  let lastRevisionKey: string | undefined;
  let diagnosticsRevision = 0;

  const readModel: DiagnosticsReadModel = {
    snapshot(): DiagnosticsSnapshot {
      const ledger = deps.getLedger();
      const trace = dedupeLatest(
        deps.getTraceRoots(retention.traceRoots),
        (root) => root.traceId,
        retention.traceRoots,
      );
      const scan = dedupeLatest(
        scanDiagnosticsFromLedger(ledger),
        scanKey,
        retention.scanDiagnostics,
      );
      const assets = dedupeLatest(
        deps.getAssetErrors(),
        assetErrorKey,
        retention.assetErrors,
      );
      const operationSnapshot = deps.getOperationRunSnapshot();
      const operationRuns = dedupeLatest(
        operationSnapshot.runs,
        (run) => run.runId,
        retention.operationRuns,
      );
      const runtime = dedupeLatest(
        (deps.getRuntimeDiagnosticsProviders?.() ?? []).flatMap((provider) => {
          try {
            return provider.snapshot().map((fact) => ({ ...fact, providerId: provider.id }));
          } catch {
            return [];
          }
        }),
        (fact) => `${fact.providerId}:${fact.id}`,
        retention.runtimeFacts,
      );
      const revisionParts = [
        deps.getRevision(),
        ledger.length,
        operationSnapshot.revision,
        deps.getAssetErrorRevision?.() ?? 0,
        deps.getRuntimeDiagnosticsRevision?.() ?? 0,
      ];
      const revisionKey = revisionParts.join(':');
      if (revisionKey !== lastRevisionKey) {
        diagnosticsRevision = Math.max(diagnosticsRevision + 1, ...revisionParts);
        lastRevisionKey = revisionKey;
      }

      return Object.freeze({
        schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
        revision: diagnosticsRevision,
        trace: Object.freeze({
          roots: trace.items,
          deduplicated: trace.deduplicated,
          dropped: deps.getDroppedTraceCount() + trace.dropped,
        }),
        scan: Object.freeze({
          diagnostics: scan.items,
          deduplicated: scan.deduplicated,
          dropped: scan.dropped,
        }),
        assets: Object.freeze({
          errors: assets.items,
          deduplicated: assets.deduplicated,
          dropped: assets.dropped,
        }),
        operationRuns: Object.freeze({
          runs: operationRuns.items,
          registryRevision: operationSnapshot.revision,
          deduplicated: operationRuns.deduplicated,
          dropped: operationRuns.dropped,
        }),
        runtime: Object.freeze({
          facts: runtime.items,
          deduplicated: runtime.deduplicated,
          dropped: runtime.dropped,
        }),
        policy,
      });
    },
    query(request: DiagnosticsQueryRequest = {}): DiagnosticsQueryResult {
      return queryDiagnosticsSnapshot(readModel.snapshot(), request);
    },
  };
  return readModel;
}
