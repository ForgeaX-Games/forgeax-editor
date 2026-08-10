// Diagnostics panel projection (R0-07D/R0-07E).
//
// This is a read-only adapter over the Gateway diagnostics snapshot/query. It
// owns no failure state and no repair implementation. The host injects the
// live snapshot/subscription and handles locate/retry/open-source actions; the
// panel only adds UI action labels and filters this projection.

import type {
  DiagnosticsQueryItem,
  DiagnosticsSeverity,
  DiagnosticsSource,
  DiagnosticsSnapshot,
  ErrorObjectRefs,
  ErrorSubjectRef,
} from '@forgeax/editor-core';
import { queryDiagnosticsSnapshot } from '@forgeax/editor-core';

export type DiagnosticsPanelSource = DiagnosticsSource;
export type DiagnosticsPanelSeverity = DiagnosticsSeverity;
export type DiagnosticsPanelAction = 'locate' | 'copy' | 'retry' | 'open-source';

export interface DiagnosticsLocation {
  readonly kind: 'file' | 'asset';
  readonly id: string;
}

export interface DiagnosticsPanelRow {
  readonly id: string;
  readonly source: DiagnosticsPanelSource;
  readonly severity: DiagnosticsPanelSeverity;
  readonly code: string;
  readonly title: string;
  readonly message: string;
  readonly path?: string;
  readonly runId?: string;
  readonly requestId?: string;
  readonly operationId?: string;
  readonly traceId?: string;
  readonly location?: DiagnosticsLocation;
  readonly subjectRef?: ErrorSubjectRef;
  readonly objectRefs?: ErrorObjectRefs;
  readonly retryable: boolean;
  readonly actions: readonly DiagnosticsPanelAction[];
  /** JSON-safe source facts for copy/details; never used as a control signal. */
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface DiagnosticsPanelFilters {
  readonly query?: string;
  readonly sources?: readonly DiagnosticsPanelSource[];
  readonly severities?: readonly DiagnosticsPanelSeverity[];
}

export interface DiagnosticsProjectionSource {
  readonly getSnapshot: () => DiagnosticsSnapshot;
  readonly subscribe?: (listener: () => void) => () => void;
  readonly dispatchAction?: (action: Exclude<DiagnosticsPanelAction, 'copy'>, row: DiagnosticsPanelRow) => void;
}

const EMPTY_SNAPSHOT: DiagnosticsSnapshot = Object.freeze({
  schemaVersion: 'diagnostics/v1',
  revision: 0,
  trace: Object.freeze({ roots: Object.freeze([]), dropped: 0, deduplicated: 0 }),
  scan: Object.freeze({ diagnostics: Object.freeze([]), dropped: 0, deduplicated: 0 }),
  assets: Object.freeze({ errors: Object.freeze([]), dropped: 0, deduplicated: 0 }),
  operationRuns: Object.freeze({ runs: Object.freeze([]), registryRevision: 0, dropped: 0, deduplicated: 0 }),
  runtime: Object.freeze({ facts: Object.freeze([]), dropped: 0, deduplicated: 0 }),
  policy: Object.freeze({
    retention: Object.freeze({ traceRoots: 64, scanDiagnostics: 128, assetErrors: 64, operationRuns: 64, runtimeFacts: 128 }),
    dedupe: Object.freeze({
      traceRoots: 'traceId',
      scanDiagnostics: 'file+severity+code+message+suggestion',
      assetErrors: 'op+path+hint',
      operationRuns: 'runId',
      runtimeFacts: 'providerId+id',
    }),
  }),
});

const EMPTY_SOURCE: DiagnosticsProjectionSource = Object.freeze({
  getSnapshot: () => EMPTY_SNAPSHOT,
});

let activeSource: DiagnosticsProjectionSource = EMPTY_SOURCE;

export function installDiagnosticsProjectionSource(source: DiagnosticsProjectionSource): () => void {
  const previous = activeSource;
  activeSource = source;
  return () => {
    if (activeSource === source) activeSource = previous;
  };
}

export function getDiagnosticsProjectionSource(): DiagnosticsProjectionSource {
  return activeSource;
}

export function subscribeDiagnosticsProjection(listener: () => void): () => void {
  return activeSource.subscribe?.(listener) ?? (() => {});
}

function locationFromRefs(refs: ErrorObjectRefs | undefined, subjectRef: ErrorSubjectRef | undefined): DiagnosticsLocation | undefined {
  const file = refs?.file ?? (subjectRef?.kind === 'file' || subjectRef?.kind === 'source-file' ? subjectRef : undefined);
  if (file !== undefined) return { kind: 'file', id: file.id };
  const asset = refs?.asset ?? (subjectRef?.kind === 'asset' ? subjectRef : undefined);
  if (asset !== undefined) return { kind: 'asset', id: asset.id };
  return undefined;
}

function actionsFor(input: {
  readonly location?: DiagnosticsLocation;
  readonly retryable?: boolean;
  readonly requestId?: string;
}): readonly DiagnosticsPanelAction[] {
  const actions: DiagnosticsPanelAction[] = ['copy'];
  if (input.location !== undefined) actions.unshift('locate');
  if (input.location?.kind === 'file') actions.push('open-source');
  if (input.retryable === true && input.requestId !== undefined) actions.push('retry');
  return Object.freeze(actions);
}

function queryItemToPanelRow(item: DiagnosticsQueryItem): DiagnosticsPanelRow {
  const location = locationFromRefs(item.objectRefs, item.subjectRef)
    ?? (item.path === undefined ? undefined : { kind: 'file' as const, id: item.path });
  return Object.freeze({
    ...item,
    ...(location === undefined ? {} : { location }),
    actions: actionsFor({
      location,
      retryable: item.retryable,
      requestId: item.requestId,
    }),
  });
}

export function buildDiagnosticsRows(snapshot: DiagnosticsSnapshot): readonly DiagnosticsPanelRow[] {
  return Object.freeze(queryDiagnosticsSnapshot(snapshot).items.map(queryItemToPanelRow));
}

export function filterDiagnosticsRows(
  rows: readonly DiagnosticsPanelRow[],
  filters: DiagnosticsPanelFilters,
): readonly DiagnosticsPanelRow[] {
  const query = filters.query?.trim().toLowerCase() ?? '';
  const sources = filters.sources === undefined || filters.sources.length === 0 ? undefined : new Set(filters.sources);
  const severities = filters.severities === undefined || filters.severities.length === 0 ? undefined : new Set(filters.severities);
  return Object.freeze(rows.filter((row) => {
    if (sources !== undefined && !sources.has(row.source)) return false;
    if (severities !== undefined && !severities.has(row.severity)) return false;
    if (query === '') return true;
    return [row.code, row.title, row.message, row.path, row.runId, row.requestId, row.operationId, row.traceId]
      .filter((value): value is string => value !== undefined)
      .some((value) => value.toLowerCase().includes(query));
  }));
}

export function formatDiagnosticsDetail(row: DiagnosticsPanelRow): string {
  try {
    return JSON.stringify(row.detail, null, 2) ?? '{}';
  } catch {
    return '{"error":"diagnostic details are not serializable"}';
  }
}

export function getDiagnosticsSnapshot(): DiagnosticsSnapshot {
  return activeSource.getSnapshot();
}
