// Versioned OperationRun contract and deterministic state reducer.

import { isCommandError, type CommandError } from './error';

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

export type OperationRunSchemaResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: { readonly issues: readonly string[] } };

export interface OperationRunSchemaContract<T> {
  safeParse(value: unknown): OperationRunSchemaResult<T>;
}

const operationRunStatuses: readonly OperationRunStatus[] = Object.freeze([
  'accepted', 'running', 'succeeded', 'failed', 'cancelled',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function operationRunIssues(value: unknown): readonly string[] {
  if (!isRecord(value)) return ['OperationRun must be an object.'];
  const candidate = value as Partial<OperationRun>;
  const issues: string[] = [];
  const requiredString = (name: string): void => {
    if (typeof candidate[name as keyof OperationRun] !== 'string' || (candidate[name as keyof OperationRun] as string).trim() === '') {
      issues.push(`${name} must be a non-empty string.`);
    }
  };

  if (candidate.schemaVersion !== OPERATION_RUN_SCHEMA_VERSION) issues.push(`schemaVersion must be ${OPERATION_RUN_SCHEMA_VERSION}.`);
  requiredString('runId');
  if (candidate.requestId !== undefined && !operationRequestIdPattern.test(candidate.requestId)) issues.push('requestId has an invalid format.');
  requiredString('operationId');
  if (typeof candidate.status !== 'string' || !(operationRunStatuses as readonly string[]).includes(candidate.status)) issues.push('status is not a supported OperationRun status.');
  if (!isRecord(candidate.actor) || typeof candidate.actor.id !== 'string' || candidate.actor.id.trim() === '' || typeof candidate.actor.kind !== 'string' || candidate.actor.kind.trim() === '') issues.push('actor must contain non-empty id and kind strings.');
  requiredString('sessionId');
  requiredString('scope');
  for (const name of ['parentRunId', 'traceId', 'idempotencyKey'] as const) {
    if (candidate[name] !== undefined && typeof candidate[name] !== 'string') issues.push(`${name} must be a string when provided.`);
  }
  if (typeof candidate.traceId !== 'string' || candidate.traceId.trim() === '') issues.push('traceId must be a non-empty string.');
  const attempt = candidate.attempt;
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) issues.push('attempt must be a positive integer.');
  if (typeof candidate.cancellable !== 'boolean') issues.push('cancellable must be a boolean.');
  if (typeof candidate.retryable !== 'boolean') issues.push('retryable must be a boolean.');
  if (!isRecord(candidate.progress) || !isFiniteNumber(candidate.progress.fraction) || candidate.progress.fraction < 0 || candidate.progress.fraction > 1 || typeof candidate.progress.stage !== 'string') {
    issues.push('progress must contain a finite fraction between 0 and 1 and a stage string.');
  }
  if (!Array.isArray(candidate.recoveryActions) || !candidate.recoveryActions.every((action) => typeof action === 'string')) issues.push('recoveryActions must be a string array.');
  if (!isRecord(candidate.effectResults)) issues.push('effectResults must be an object.');
  if (!isFiniteNumber(candidate.acceptedAt)) issues.push('acceptedAt must be a finite number.');
  if (candidate.startedAt !== undefined && !isFiniteNumber(candidate.startedAt)) issues.push('startedAt must be a finite number when provided.');
  if (candidate.completedAt !== undefined && !isFiniteNumber(candidate.completedAt)) issues.push('completedAt must be a finite number when provided.');
  const sequence = candidate.sequence;
  if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 1) issues.push('sequence must be a positive integer.');
  if (candidate.error !== undefined && !isCommandError(candidate.error)) issues.push('error must be a structured CommandError.');

  if (candidate.status === 'accepted') {
    if (candidate.startedAt !== undefined || candidate.completedAt !== undefined || candidate.result !== undefined || candidate.error !== undefined) issues.push('accepted runs cannot carry started, completed, result, or error facts.');
  } else if (candidate.status === 'running') {
    if (candidate.startedAt === undefined || candidate.completedAt !== undefined || candidate.result !== undefined || candidate.error !== undefined) issues.push('running runs require startedAt and cannot carry terminal facts.');
  } else if (candidate.status === 'succeeded') {
    if (candidate.startedAt === undefined || candidate.completedAt === undefined || candidate.error !== undefined) issues.push('succeeded runs require startedAt/completedAt and cannot carry an error.');
  } else if (candidate.status === 'failed') {
    if (candidate.startedAt === undefined || candidate.completedAt === undefined || !isCommandError(candidate.error)) issues.push('failed runs require startedAt/completedAt and a structured error.');
  } else if (candidate.status === 'cancelled') {
    if (candidate.startedAt === undefined || candidate.completedAt === undefined || candidate.result !== undefined) issues.push('cancelled runs require startedAt/completedAt and cannot carry a result.');
  }
  return Object.freeze(issues);
}

/** Runtime validator for OperationRun values crossing transport or restore boundaries. */
export const OperationRunSchema: OperationRunSchemaContract<OperationRun> = Object.freeze({
  safeParse(value: unknown): OperationRunSchemaResult<OperationRun> {
    const issues = operationRunIssues(value);
    return issues.length === 0
      ? { success: true, data: value as OperationRun }
      : { success: false, error: { issues } };
  },
});

export function isOperationRun(value: unknown): value is OperationRun {
  return OperationRunSchema.safeParse(value).success;
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

function validatedRun(run: OperationRun): RunReducerResult {
  const parsed = OperationRunSchema.safeParse(run);
  return parsed.success
    ? { ok: true, value: run }
    : failure('invalid-run-schema', parsed.error.issues.join(' '));
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
  return validatedRun(frozenRun(run));
}

function withError(run: OperationRun, error: CommandError): OperationRun {
  return frozenRun({
    ...run,
    status: 'failed',
    progress: frozenProgress({ fraction: 1, stage: 'failed' }),
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
      ? validatedRun(current)
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
  if (event.type === 'running') return validatedRun(frozenRun({ ...next, status: 'running', startedAt: event.at }));
  if (event.type === 'progress') return validatedRun(frozenRun({ ...next, progress: frozenProgress(event.progress) }));
  if (event.type === 'effect-result') return validatedRun(frozenRun({ ...next, effectResults: { ...current.effectResults, [event.effectKey]: event.result } }));
  if (event.type === 'succeeded') {
    return validatedRun(frozenRun({
      ...next,
      status: 'succeeded',
      progress: frozenProgress({ fraction: 1, stage: 'succeeded' }),
      completedAt: event.at,
      result: event.result,
      recoveryActions: [],
    }));
  }
  if (event.type === 'failed') return validatedRun(frozenRun({ ...withError(next, event.error), completedAt: event.at, sequence: event.sequence }));
  if (event.type === 'cancelled') return validatedRun(frozenRun({
      ...next,
      status: 'cancelled',
      progress: frozenProgress({ fraction: 1, stage: 'cancelled' }),
      completedAt: event.at,
      ...(event.error === undefined ? {} : { error: event.error, recoveryActions: event.error.recoveryActions }),
    }));
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
