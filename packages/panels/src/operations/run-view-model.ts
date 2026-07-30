// Operation Center projection.
//
// This module is a read-only adapter over product facts. It does not own a run
// registry, a timer, or a mutation path. Hosts inject a product projection
// source when they have one; the empty source keeps the panel mountable before
// the host finishes booting.

import type {
  AuthoredCommit,
  CommandError,
  OperationRun,
  RunProgress,
} from '@forgeax/editor-product';

export type OperationCenterAction = 'retry' | 'cancel' | 'undo';

export interface OperationRunFactProjection {
  readonly runId: string;
  readonly operationId: string;
  readonly status: OperationRun['status'];
  readonly actor: OperationRun['actor'];
  readonly sessionId: string;
  readonly scope: string;
  readonly traceId: string;
  readonly parentRunId?: string;
  readonly attempt: number;
  readonly progress: RunProgress;
  readonly result?: unknown;
  readonly error?: CommandError;
  readonly recoveryActions: readonly string[];
  readonly subjectId?: string;
  readonly revision?: string;
  readonly isTerminal: boolean;
  readonly isSuccess: boolean;
  readonly actions: OperationCenterAction[];
}

export interface OperationCenterProjectionInput {
  readonly run: OperationRun;
  readonly commit?: AuthoredCommit;
}

export interface OperationProjectionSource {
  readonly getRuns: () => readonly OperationRun[];
  readonly getCommits?: () => readonly AuthoredCommit[];
  readonly getRevision?: () => string;
  readonly subscribe?: (listener: () => void) => () => void;
  readonly dispatchRecovery?: (action: OperationCenterAction, runId: string) => void;
}

export interface OperationCenterRow extends OperationRunFactProjection {
  readonly commit?: AuthoredCommit;
}

function inputSubjectId(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>).subjectId;
  return typeof value === 'string' ? value : undefined;
}

function actionSet(run: OperationRun, commit: AuthoredCommit | undefined): readonly OperationCenterAction[] {
  const actions: OperationCenterAction[] = [];
  if (run.status === 'failed' && run.retryable) actions.push('retry');
  if ((run.status === 'accepted' || run.status === 'running') && run.cancellable) actions.push('cancel');
  if (run.status === 'succeeded' && commit?.runId === run.runId) actions.push('undo');
  return Object.freeze(actions);
}

export function projectRunFacts(input: OperationCenterProjectionInput): OperationRunFactProjection {
  const { run, commit } = input;
  const isTerminal = run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled';
  const projection: OperationRunFactProjection = {
    runId: run.runId,
    operationId: run.operationId,
    status: run.status,
    actor: run.actor,
    sessionId: run.sessionId,
    scope: run.scope,
    traceId: run.traceId,
    ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
    attempt: run.attempt,
    progress: Object.freeze({ ...run.progress }),
    ...(run.result === undefined ? {} : { result: run.result }),
    ...(run.error === undefined ? {} : { error: run.error }),
    recoveryActions: Object.freeze([...run.recoveryActions]),
    ...(inputSubjectId(run.input) === undefined ? {} : { subjectId: inputSubjectId(run.input) }),
    ...(commit === undefined ? {} : { revision: commit.revision }),
    isTerminal,
    isSuccess: run.status === 'succeeded',
    actions: actionSet(run, commit) as OperationCenterAction[],
  };
  return Object.freeze(projection);
}

export function buildOperationCenterRows(
  runs: readonly (OperationRun | OperationRunFactProjection)[],
  commits: readonly AuthoredCommit[] = [],
): readonly OperationCenterRow[] {
  const commitsByRun = new Map(commits.map((commit) => [commit.runId, commit]));
  return Object.freeze(runs.map((run) => {
    const commit = commitsByRun.get(run.runId);
    if ('isTerminal' in run) {
      return Object.freeze({
        ...run,
        ...(commit === undefined ? {} : { commit }),
      });
    }
    return Object.freeze({
      ...projectRunFacts({ run, ...(commit === undefined ? {} : { commit }) }),
      ...(commit === undefined ? {} : { commit }),
    });
  }));
}

const EMPTY_RUNS: readonly OperationRun[] = Object.freeze([]);
const EMPTY_COMMITS: readonly AuthoredCommit[] = Object.freeze([]);
const EMPTY_SOURCE: OperationProjectionSource = Object.freeze({
  getRuns: () => EMPTY_RUNS,
  getCommits: () => EMPTY_COMMITS,
  getRevision: () => 'projection:r0',
});

let activeSource: OperationProjectionSource = EMPTY_SOURCE;
let rowsCache: {
  readonly source: OperationProjectionSource;
  readonly revision?: string;
  readonly runs: readonly (OperationRun | OperationRunFactProjection)[];
  readonly commits: readonly AuthoredCommit[];
  readonly rows: readonly OperationCenterRow[];
} | undefined;

export function installOperationProjectionSource(source: OperationProjectionSource): () => void {
  const previous = activeSource;
  activeSource = source;
  return () => {
    if (activeSource === source) activeSource = previous;
  };
}

export function getOperationProjectionSource(): OperationProjectionSource {
  return activeSource;
}

export function getOperationCenterRows(source: OperationProjectionSource = activeSource): readonly OperationCenterRow[] {
  const runs = source.getRuns();
  const commits = source.getCommits?.() ?? EMPTY_COMMITS;
  const revision = source.getRevision?.();
  if (
    rowsCache?.source === source
    && rowsCache.revision === revision
    && (revision !== undefined || (rowsCache.runs === runs && rowsCache.commits === commits))
  ) {
    return rowsCache.rows;
  }
  const rows = buildOperationCenterRows(runs, commits);
  rowsCache = { source, revision, runs, commits, rows };
  return rows;
}

export function subscribeOperationProjection(listener: () => void): () => void {
  return activeSource.subscribe?.(listener) ?? (() => {});
}
