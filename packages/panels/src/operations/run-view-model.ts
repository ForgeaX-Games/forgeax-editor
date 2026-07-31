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

export type OperationCenterAction = 'retry' | 'cancel' | 'undo' | 'inspect' | 'reveal-source';

export interface OperationAssetContext {
  readonly guid: string;
  readonly kind: string;
  readonly name: string;
  readonly sourcePath?: string;
}

export interface OperationSubjectProjection {
  readonly kind: 'placement' | 'binding' | 'generic';
  readonly name?: string;
  readonly sceneGuid?: string;
  readonly entity?: number;
  readonly component?: string;
  readonly field?: string;
  readonly wrapper?: number;
  readonly root?: number;
  readonly selectableEntity?: number;
  readonly assetGuids: readonly string[];
  readonly assets: readonly OperationAssetContext[];
  readonly sourcePaths: readonly string[];
  readonly cleanup?: {
    readonly attempted: boolean;
    readonly ok?: boolean;
    readonly wrapper?: number;
    readonly errorCode?: string;
  };
}

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
  readonly subject?: OperationSubjectProjection;
  readonly actions: OperationCenterAction[];
}

export interface OperationCenterProjectionInput {
  readonly run: OperationRun;
  readonly commit?: AuthoredCommit;
  readonly resolveAsset?: (guid: string) => OperationAssetContext | undefined;
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
  readonly resolveAsset?: (guid: string) => OperationAssetContext | undefined;
  readonly dispatchRecovery?: (action: OperationCenterAction, runId: string, row: OperationCenterRow) => void;
}

export interface OperationCenterRow extends OperationRunFactProjection {
  readonly commit?: AuthoredCommit;
}

function inputSubjectId(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>).subjectId;
  return typeof value === 'string' ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function numberValue(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function stringList(...values: unknown[]): string[] {
  const output: string[] = [];
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === 'string' && item.length > 0 && !output.includes(item)) output.push(item);
    }
  }
  return output;
}

function projectSubject(
  run: OperationRun,
  resolveAsset: OperationCenterProjectionInput['resolveAsset'],
): OperationSubjectProjection | undefined {
  const input = record(run.input);
  const result = record(run.result);
  const current = record(run.error?.current);
  const cleanup = record(current?.cleanup);
  const isPlacement = run.operationId === 'addSceneAssetToScene';
  const isBinding = run.operationId === 'bindAssetRef';
  if (!isPlacement && !isBinding) return undefined;

  const sceneGuid = isPlacement ? stringValue(result?.sceneGuid, current?.sceneGuid, input?.sceneGuid) : undefined;
  const assetGuids = stringList(
    sceneGuid === undefined ? undefined : [sceneGuid],
    input?.guids,
    result?.guids,
    current?.guids,
  );
  const entity = isBinding ? numberValue(result?.entity, current?.entity, input?.entity) : undefined;
  const wrapper = isPlacement ? numberValue(result?.wrapper, current?.wrapper, cleanup?.wrapper) : undefined;
  const root = isPlacement ? numberValue(result?.root, current?.root) : undefined;
  const cleanupError = record(cleanup?.error);
  const cleanupProjection = isPlacement && cleanup !== undefined && typeof cleanup.attempted === 'boolean'
    ? {
      attempted: cleanup.attempted,
      ...(typeof cleanup.ok === 'boolean' ? { ok: cleanup.ok } : {}),
      ...(typeof cleanup.wrapper === 'number' ? { wrapper: cleanup.wrapper } : {}),
      ...(typeof cleanupError?.code === 'string' ? { errorCode: cleanupError.code } : {}),
    }
    : undefined;
  const assets = resolveAsset === undefined
    ? []
    : assetGuids.flatMap((guid) => {
      const asset = resolveAsset(guid);
      return asset === undefined ? [] : [asset];
    });
  const sourcePaths = [...new Set(assets.flatMap((asset) => asset.sourcePath === undefined ? [] : [asset.sourcePath]))];
  const selectableEntity = isBinding
    ? entity
    : cleanupProjection?.ok === false
      ? wrapper
      : result?.wrapper === undefined
        ? undefined
        : wrapper;
  const name = stringValue(result?.name, current?.name, input?.name);
  return Object.freeze({
    kind: isPlacement ? 'placement' : 'binding',
    ...(name === undefined ? {} : { name }),
    ...(sceneGuid === undefined ? {} : { sceneGuid }),
    ...(entity === undefined ? {} : { entity }),
    ...(typeof input?.component === 'string' ? { component: input.component } : {}),
    ...(typeof input?.field === 'string' ? { field: input.field } : {}),
    ...(wrapper === undefined ? {} : { wrapper }),
    ...(root === undefined ? {} : { root }),
    ...(selectableEntity === undefined ? {} : { selectableEntity }),
    assetGuids: Object.freeze(assetGuids),
    assets: Object.freeze(assets),
    sourcePaths: Object.freeze(sourcePaths),
    ...(cleanupProjection === undefined ? {} : { cleanup: Object.freeze(cleanupProjection) }),
  });
}

function actionSet(
  run: OperationRun,
  commit: AuthoredCommit | undefined,
  subject: OperationSubjectProjection | undefined,
): readonly OperationCenterAction[] {
  const actions: OperationCenterAction[] = [];
  if (run.status === 'failed' && run.retryable) actions.push('retry');
  if ((run.status === 'accepted' || run.status === 'running') && run.cancellable) actions.push('cancel');
  if (run.status === 'succeeded' && commit?.runId === run.runId) actions.push('undo');
  if (subject?.selectableEntity !== undefined || subject?.assets[0] !== undefined) actions.push('inspect');
  if (subject !== undefined && subject.sourcePaths.length > 0) actions.push('reveal-source');
  return Object.freeze(actions);
}

export function projectRunFacts(input: OperationCenterProjectionInput): OperationRunFactProjection {
  const { run, commit } = input;
  const subject = projectSubject(run, input.resolveAsset);
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
    ...(subject === undefined ? {} : { subject }),
    actions: actionSet(run, commit, subject) as OperationCenterAction[],
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
  resolveAsset?: OperationCenterProjectionInput['resolveAsset'],
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
      ...projectRunFacts({ run, ...(commit === undefined ? {} : { commit }), resolveAsset }),
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
  readonly resolveAsset?: OperationProjectionSource['resolveAsset'];
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
    && rowsCache.resolveAsset === source.resolveAsset
  ) {
    return rowsCache.rows;
  }
  const rows = buildOperationCenterRows(runs, commits, source.resolveAsset);
  rowsCache = { source, revision, resolveAsset: source.resolveAsset, rows };
  return rows;
}

export function subscribeOperationProjection(listener: () => void): () => void {
  return activeSource.subscribe?.(listener) ?? (() => {});
}
