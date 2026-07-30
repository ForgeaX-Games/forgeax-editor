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
  readonly requestId?: string;
  readonly operationId: string;
  readonly status: OperationRun['status'];
  readonly actor: OperationRun['actor'];
  readonly sessionId: string;
  readonly scope: string;
  readonly traceId: string;
  readonly parentRunId?: string;
  readonly attempt: number;
  readonly sequence: number;
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

/**
 * Versioned read model shared by human UI and AI/eval callers. This is the
 * only terminal input accepted by the projection boundary (R0-X03).
 */
export interface OperationRunProjectionSnapshot {
  readonly revision: number;
  readonly runs: readonly OperationRun[];
}

export interface OperationProjectionSource {
  readonly getSnapshot: () => OperationRunProjectionSnapshot;
  readonly getCommits?: () => readonly AuthoredCommit[];
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
    ...(run.requestId === undefined ? {} : { requestId: run.requestId }),
    operationId: run.operationId,
    status: run.status,
    actor: run.actor,
    sessionId: run.sessionId,
    scope: run.scope,
    traceId: run.traceId,
    ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
    attempt: run.attempt,
    sequence: run.sequence,
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

export type SaveRunDirtyState = 'clean' | 'pending' | 'failed' | 'unavailable';

export interface SaveRunProjection {
  readonly requestId?: string;
  readonly runId?: string;
  readonly operationId: 'saveDocToDisk';
  readonly status: OperationRun['status'] | 'unavailable';
  readonly dirty: boolean;
  readonly dirtyState: SaveRunDirtyState;
  readonly retryable: boolean;
  readonly recoveryActions: readonly string[];
  readonly sequence?: number;
  readonly isTerminal: boolean;
  readonly isSuccess: boolean;
  readonly error?: CommandError;
  readonly run?: OperationRun;
}

export function projectSaveRun(input: {
  readonly run?: OperationRun;
  readonly dirty: boolean;
  readonly error?: CommandError;
}): SaveRunProjection {
  const run = input.run;
  if (run === undefined) {
    return Object.freeze({
      operationId: 'saveDocToDisk',
      status: 'unavailable',
      dirty: input.dirty,
      dirtyState: 'unavailable',
      retryable: false,
      recoveryActions: Object.freeze([...(input.error?.recoveryActions ?? ['editor.discover'])]),
      isTerminal: false,
      isSuccess: false,
      ...(input.error === undefined ? {} : { error: input.error }),
    });
  }
  const dirtyState: SaveRunDirtyState = !input.dirty
    ? 'clean'
    : run.status === 'failed'
      ? 'failed'
      : 'pending';
  return Object.freeze({
    operationId: 'saveDocToDisk',
    requestId: run.requestId,
    runId: run.runId,
    status: run.status,
    dirty: input.dirty,
    dirtyState,
    retryable: run.retryable,
    recoveryActions: Object.freeze([...run.recoveryActions]),
    sequence: run.sequence,
    isTerminal: run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled',
    isSuccess: run.status === 'succeeded',
    ...(run.error === undefined ? {} : { error: run.error }),
    run,
  });
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

const EMPTY_SNAPSHOT: OperationRunProjectionSnapshot = Object.freeze({
  revision: 0,
  runs: Object.freeze([]),
});
const EMPTY_COMMITS: readonly AuthoredCommit[] = Object.freeze([]);
const EMPTY_SOURCE: OperationProjectionSource = Object.freeze({
  getSnapshot: () => EMPTY_SNAPSHOT,
  getCommits: () => EMPTY_COMMITS,
});

let activeSource: OperationProjectionSource = EMPTY_SOURCE;
let rowsCache: {
  readonly source: OperationProjectionSource;
  readonly revision: number;
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
  const snapshot = source.getSnapshot();
  const runs = snapshot.runs;
  const commits = source.getCommits?.() ?? EMPTY_COMMITS;
  const revision = snapshot.revision;
  if (
    rowsCache?.source === source
    && rowsCache.revision === revision
  ) {
    return rowsCache.rows;
  }
  const rows = buildOperationCenterRows(runs, commits);
  rowsCache = { source, revision, rows };
  return rows;
}

export function subscribeOperationProjection(listener: () => void): () => void {
  return activeSource.subscribe?.(listener) ?? (() => {});
}
