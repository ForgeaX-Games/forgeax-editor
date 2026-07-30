// Versioned OperationRun contract and deterministic state reducer.

import type { CommandError } from './error';

export const OPERATION_RUN_SCHEMA_VERSION = 'operation-run/v1' as const;
export const OPERATION_REQUEST_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' as const;
const operationRequestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type OperationRunStatus = 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type TerminalRunStatus = Extract<OperationRunStatus, 'succeeded' | 'failed' | 'cancelled'>;

export interface RunActor {
  readonly id: string;
  readonly kind: 'human' | 'ai' | 'system' | (string & {});
}

export interface RunProgress {
  readonly fraction: number;
  readonly stage: string;
  readonly completed?: number;
  readonly total?: number;
}

export interface OperationRunRequest {
  readonly runId: string;
  /** Caller-owned correlation identity; runId remains journal-owned. */
  readonly requestId?: string;
  readonly operationId: string;
  readonly actor: RunActor;
  readonly sessionId: string;
  readonly scope: string;
  readonly input?: unknown;
  readonly parentRunId?: string;
  readonly traceId?: string;
  readonly idempotencyKey?: string;
  readonly attempt?: number;
  readonly cancellable?: boolean;
  readonly retryable?: boolean;
}

export interface OperationRun {
  readonly schemaVersion: typeof OPERATION_RUN_SCHEMA_VERSION;
  readonly runId: string;
  readonly requestId?: string;
  readonly operationId: string;
  readonly status: OperationRunStatus;
  readonly actor: RunActor;
  readonly sessionId: string;
  readonly scope: string;
  readonly input?: unknown;
  readonly parentRunId?: string;
  readonly traceId: string;
  readonly idempotencyKey?: string;
  readonly attempt: number;
  readonly cancellable: boolean;
  readonly retryable: boolean;
  readonly progress: RunProgress;
  readonly result?: unknown;
  readonly error?: CommandError;
  readonly recoveryActions: readonly string[];
  readonly effectResults: Readonly<Record<string, unknown>>;
  readonly acceptedAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly sequence: number;
}

/** Read result for a request-correlated operation run. */
export type OperationRunReadResult<T = OperationRun> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CommandError };

/** Acceptance result returned by the canonical save operation-run owner. */
export type OperationRunAcceptResult =
  | { readonly ok: true; readonly runId: string; readonly reused: boolean; readonly run: OperationRun }
  | { readonly ok: false; readonly error: CommandError };

/** Projection port used by product transport; the Gateway remains the owner. */
export interface SaveOperationRunPort {
  dispatchSave(requestId: string, input: unknown, actor: RunActor): OperationRunAcceptResult;
  get(requestId: string): OperationRunReadResult;
  wait(requestId: string): Promise<OperationRunReadResult>;
  subscribe?(requestId: string, listener: (run: OperationRun) => void): () => void;
  cancel(requestId: string): OperationRunReadResult<never>;
  retry(requestId: string, retryRequestId: string, actor: RunActor): OperationRunAcceptResult;
}

interface RunEventBase {
  readonly runId: string;
  readonly sequence: number;
  readonly at: number;
}

export type OperationRunEvent =
  | (RunEventBase & { readonly type: 'accepted'; readonly requestId?: string; readonly operationId: string; readonly actor: RunActor; readonly sessionId: string; readonly scope: string; readonly input?: unknown; readonly parentRunId?: string; readonly traceId: string; readonly idempotencyKey?: string; readonly attempt: number; readonly cancellable: boolean; readonly retryable: boolean })
  | (RunEventBase & { readonly type: 'running' })
  | (RunEventBase & { readonly type: 'progress'; readonly progress: RunProgress })
  | (RunEventBase & { readonly type: 'succeeded'; readonly result?: unknown })
  | (RunEventBase & { readonly type: 'failed'; readonly error: CommandError })
  | (RunEventBase & { readonly type: 'cancelled'; readonly error?: CommandError })
  | (RunEventBase & { readonly type: 'effect-result'; readonly effectKey: string; readonly result?: unknown })
  | (RunEventBase & { readonly type: 'assert-terminal' });

export type OperationRunEventInput = {
  [Type in OperationRunEvent['type']]: Omit<Extract<OperationRunEvent, { readonly type: Type }>, 'sequence'> & { readonly sequence?: number }
}[OperationRunEvent['type']];

export type RunReducerResult =
  | { readonly ok: true; readonly value: OperationRun }
  | { readonly ok: false; readonly error: CommandError };

export function isTerminalRunStatus(status: OperationRunStatus): status is TerminalRunStatus {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function frozenProgress(progress: RunProgress): RunProgress {
  return Object.freeze({ ...progress });
}

function frozenRun(run: OperationRun): OperationRun {
  return Object.freeze({
    ...run,
    actor: Object.freeze({ ...run.actor }),
    progress: frozenProgress(run.progress),
    recoveryActions: Object.freeze([...run.recoveryActions]),
    effectResults: Object.freeze({ ...run.effectResults }),
  });
}

function failure(
  code: string,
  hint: string,
  recoveryActions: readonly string[] = [],
): RunReducerResult {
  return {
    ok: false,
    error: Object.freeze({
      code,
      hint,
      retryable: false,
      recoveryActions: Object.freeze([...recoveryActions]),
    }),
  };
}

export function createOperationRun(
  request: OperationRunRequest,
  acceptedAt: number = Date.now(),
): RunReducerResult {
  if (request.runId.trim() === '') return failure('invalid-run-id', 'runId must be non-empty.');
  if (request.requestId !== undefined && !operationRequestIdPattern.test(request.requestId)) {
    return failure('invalid-request-id', `requestId must match ${OPERATION_REQUEST_ID_PATTERN}.`);
  }
  if (request.operationId.trim() === '') return failure('invalid-operation-id', 'operationId must be non-empty.');
  if (request.scope.trim() === '') return failure('invalid-run-scope', 'scope must be non-empty.');
  const run: OperationRun = {
    schemaVersion: OPERATION_RUN_SCHEMA_VERSION,
    runId: request.runId,
    ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
    operationId: request.operationId,
    status: 'accepted',
    actor: Object.freeze({ ...request.actor }),
    sessionId: request.sessionId,
    scope: request.scope,
    ...(request.input === undefined ? {} : { input: request.input }),
    ...(request.parentRunId === undefined ? {} : { parentRunId: request.parentRunId }),
    traceId: request.traceId ?? request.runId,
    ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
    attempt: request.attempt ?? 1,
    cancellable: request.cancellable ?? false,
    retryable: request.retryable ?? false,
    progress: frozenProgress({ fraction: 0, stage: 'accepted' }),
    recoveryActions: Object.freeze([]),
    effectResults: Object.freeze({}),
    acceptedAt,
    sequence: 1,
  };
  return { ok: true, value: frozenRun(run) };
}

function withError(run: OperationRun, error: CommandError): OperationRun {
  return frozenRun({
    ...run,
    status: 'failed',
    error: Object.freeze({ ...error, recoveryActions: Object.freeze([...error.recoveryActions]) }),
    recoveryActions: Object.freeze([...error.recoveryActions]),
  });
}

export function reduceOperationRun(
  current: OperationRun,
  event: OperationRunEvent,
): RunReducerResult {
  if (event.runId.trim() === '' || event.runId !== current.runId) {
    return failure('invalid-run-id', 'The event runId does not identify the current run.');
  }
  if (event.sequence <= current.sequence) {
    return failure('run-event-order', 'Run events must have strictly increasing sequence numbers.');
  }
  if (event.type === 'assert-terminal') {
    return isTerminalRunStatus(current.status)
      ? { ok: true, value: current }
      : failure('run-not-terminal', 'The run has not published a terminal event.', ['run.wait']);
  }
  if (event.type === 'accepted') return failure('invalid-run-transition', 'An accepted event can only be the first event.');
  if (isTerminalRunStatus(current.status)) {
    return failure('run-terminal', 'A terminal run cannot accept another event.');
  }
  if (event.type === 'running' && current.status !== 'accepted') {
    return failure('invalid-run-transition', 'Only an accepted run can enter running.');
  }
  if (event.type === 'progress' && current.status !== 'running') {
    return failure('invalid-run-transition', 'Progress is valid only while a run is running.');
  }
  if (event.type === 'effect-result' && current.status !== 'running') {
    return failure('invalid-run-transition', 'An effect result is valid only while a run is running.');
  }
  if ((event.type === 'succeeded' || event.type === 'failed' || event.type === 'cancelled') && current.status !== 'running') {
    return failure('invalid-run-transition', 'A run must be running before it can publish a terminal event.');
  }

  const next: OperationRun = { ...current, sequence: event.sequence };
  if (event.type === 'running') return { ok: true, value: frozenRun({ ...next, status: 'running', startedAt: event.at }) };
  if (event.type === 'progress') return { ok: true, value: frozenRun({ ...next, progress: frozenProgress(event.progress) }) };
  if (event.type === 'effect-result') return { ok: true, value: frozenRun({ ...next, effectResults: { ...current.effectResults, [event.effectKey]: event.result } }) };
  if (event.type === 'succeeded') {
    return {
      ok: true,
      value: frozenRun({ ...next, status: 'succeeded', completedAt: event.at, result: event.result, recoveryActions: [] }),
    };
  }
  if (event.type === 'failed') return { ok: true, value: frozenRun({ ...withError(next, event.error), completedAt: event.at, sequence: event.sequence }) };
  if (event.type === 'cancelled') return {
    ok: true,
    value: frozenRun({
      ...next,
      status: 'cancelled',
      completedAt: event.at,
      ...(event.error === undefined ? {} : { error: event.error, recoveryActions: event.error.recoveryActions }),
    }),
  };
  return failure('invalid-run-event', 'The event type cannot change a run.');
}

export function acceptedEvent(run: OperationRun): OperationRunEvent {
  return {
    type: 'accepted',
    runId: run.runId,
    sequence: 1,
    at: run.acceptedAt,
    ...(run.requestId === undefined ? {} : { requestId: run.requestId }),
    operationId: run.operationId,
    actor: run.actor,
    sessionId: run.sessionId,
    scope: run.scope,
    ...(run.input === undefined ? {} : { input: run.input }),
    ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
    traceId: run.traceId,
    ...(run.idempotencyKey === undefined ? {} : { idempotencyKey: run.idempotencyKey }),
    attempt: run.attempt,
    cancellable: run.cancellable,
    retryable: run.retryable,
  };
}
