import type { OperationRun } from '@forgeax/editor-product';

export type OperationsPageControl = { readonly kind: 'open-resource'; readonly guid: string };
export interface OperationsPageRun {
  readonly runId: string;
  readonly requestId?: string;
  readonly operationId: string;
  readonly actor: OperationRun['actor'];
  readonly sessionId: string;
  readonly scope: string;
  readonly traceId: string;
  readonly sequence: number;
  readonly progress: OperationRun['progress'];
  readonly subject?: { readonly kind: string; readonly guid: string };
  readonly snapshot?: { readonly revision: number; readonly digest: string };
  readonly terminal?: { readonly status: Extract<OperationRun['status'], 'succeeded' | 'failed' | 'cancelled'>; readonly completedAt?: number };
  readonly artifacts: readonly unknown[];
  readonly diagnostics: readonly unknown[];
  readonly error?: OperationRun['error'];
  readonly controls: readonly OperationsPageControl[];
}
export interface OperationsPageProjection {
  readonly schemaVersion: 'operations-page/v1';
  readonly revision: number;
  readonly runs: readonly OperationsPageRun[];
}
export interface OperationsObserverSource {
  readonly getSnapshot: () => { readonly revision: number; readonly runs: readonly OperationRun[] };
  readonly subscribe?: (listener: () => void) => () => void;
}
let observerSource: OperationsObserverSource = { getSnapshot: () => ({ revision: 0, runs: [] }) };
const observerListeners = new Set<() => void>();
let releaseObserverSource = () => {};
export function installOperationsObserverSource(source: OperationsObserverSource): () => void {
  const previous = observerSource;
  releaseObserverSource();
  observerSource = source;
  releaseObserverSource = source.subscribe?.(() => { for (const listener of [...observerListeners]) listener(); }) ?? (() => {});
  for (const listener of [...observerListeners]) listener();
  return () => {
    if (observerSource !== source) return;
    releaseObserverSource();
    observerSource = previous;
    releaseObserverSource = previous.subscribe?.(() => { for (const listener of [...observerListeners]) listener(); }) ?? (() => {});
    for (const listener of [...observerListeners]) listener();
  };
}
export function getOperationsObserverSource(): OperationsObserverSource { return observerSource; }
export function subscribeOperationsObserver(listener: () => void): () => void {
  observerListeners.add(listener);
  return () => observerListeners.delete(listener);
}
let cachedObserverSource: OperationsObserverSource | undefined;
let cachedObserverRevision = -1;
let cachedObserverSnapshot: { readonly revision: number; readonly runs: readonly OperationRun[] } = { revision: 0, runs: [] };
export function getOperationsObserverSnapshot(): { readonly revision: number; readonly runs: readonly OperationRun[] } {
  const source = observerSource;
  const snapshot = source.getSnapshot();
  if (source !== cachedObserverSource || snapshot.revision !== cachedObserverRevision) {
    cachedObserverSource = source;
    cachedObserverRevision = snapshot.revision;
    cachedObserverSnapshot = snapshot;
  }
  return cachedObserverSnapshot;
}
export const OPERATIONS_PAGE_READONLY_CONTROLS = Object.freeze(['open-resource'] as const);
export function assertOperationsPageReadOnly(controls: readonly string[]): { readonly ok: true } | { readonly ok: false; readonly code: 'operations-page-authority-control'; readonly control: string } {
  const allowed = new Set<string>(OPERATIONS_PAGE_READONLY_CONTROLS);
  const invalid = controls.find((control) => !allowed.has(control));
  return invalid === undefined ? { ok: true } : { ok: false, code: 'operations-page-authority-control', control: invalid };
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function projectionValue(run: OperationRun): Record<string, unknown> { return record(run.result) ?? record(run.input) ?? {}; }
function subject(run: OperationRun): OperationsPageRun['subject'] {
  const value = record(projectionValue(run).subject);
  return typeof value?.guid === 'string' && typeof value.kind === 'string' ? { kind: value.kind, guid: value.guid } : undefined;
}
function snapshot(run: OperationRun): OperationsPageRun['snapshot'] {
  const value = record(projectionValue(run).snapshot);
  return typeof value?.revision === 'number' && Number.isSafeInteger(value.revision) && typeof value.digest === 'string' ? { revision: value.revision, digest: value.digest } : undefined;
}
function list(value: unknown): readonly unknown[] { return Array.isArray(value) ? Object.freeze([...value]) : Object.freeze([]); }
export function projectOperationsPage(input: { readonly revision: number; readonly runs: readonly OperationRun[] }): OperationsPageProjection {
  return Object.freeze({
    schemaVersion: 'operations-page/v1' as const,
    revision: input.revision,
    runs: Object.freeze(input.runs.map((run) => {
      const value = projectionValue(run);
      const runSubject = subject(run);
      const isTerminal = run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled';
      return Object.freeze({
        runId: run.runId, ...(run.requestId === undefined ? {} : { requestId: run.requestId }), operationId: run.operationId,
        actor: run.actor, sessionId: run.sessionId, scope: run.scope, traceId: run.traceId, sequence: run.sequence, progress: run.progress,
        ...(runSubject === undefined ? {} : { subject: runSubject }), ...(snapshot(run) === undefined ? {} : { snapshot: snapshot(run) }),
        ...(isTerminal ? { terminal: { status: run.status, ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }) } } : {}),
        artifacts: list(value.artifacts), diagnostics: list(value.diagnostics), ...(run.error === undefined ? {} : { error: run.error }),
        controls: Object.freeze(runSubject === undefined ? [] : [{ kind: 'open-resource' as const, guid: runSubject.guid }]),
      });
    })),
  });
}
