// In-memory OperationRun coordinator. Durable records are supplied by RunJournal.

import {
  acceptedEvent,
  createOperationRun,
  isTerminalRunStatus,
  reduceOperationRun,
  type OperationRun,
  type OperationRunEvent,
  type OperationRunEventInput,
  type OperationRunRequest,
  type RunActor,
  type RunProgress,
  type RunReducerResult,
} from '../contracts/run';
import type { CommandError } from '../contracts/error';

export const REPRESENTATIVE_OPERATION_IDS = [
  'createAsset',
  'renameAsset',
  'duplicateAsset',
  'destroyAsset',
  'saveDocToDisk',
  'importAsset',
  'deleteSourceFile',
  'addSceneAssetToScene',
  'bindAssetRef',
  'play',
] as const;

export interface RunCoordinatorOptions {
  readonly now?: () => number;
  readonly idFactory?: (operationId: string) => string;
}

export interface OperationDefinition {
  readonly operationId: string;
  readonly cancellable?: boolean;
  readonly retryable?: boolean;
  readonly execute: (input: unknown) => unknown | Promise<unknown>;
}

export type RunCoordinatorEvent = OperationRunEvent;
export type RunEventInput = OperationRunEventInput;
export type RunAcceptedResult =
  | { readonly ok: true; readonly runId: string; readonly reused: boolean; readonly run: OperationRun }
  | { readonly ok: false; readonly error: CommandError };

function error(code: string, hint: string, recoveryActions: readonly string[] = []): { readonly ok: false; readonly error: CommandError } {
  return { ok: false, error: { code, hint, retryable: false, recoveryActions } };
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}

function executorError(cause: unknown, retryable: boolean): CommandError {
  return {
    code: 'operation-executor-failed',
    hint: cause instanceof Error ? cause.message : String(cause),
    retryable,
    recoveryActions: retryable ? ['operation.retry'] : [],
  };
}

export class OperationRunCoordinator {
  private readonly runs = new Map<string, OperationRun>();
  private readonly events = new Map<string, OperationRunEvent[]>();
  private readonly operations = new Map<string, OperationDefinition>();
  private readonly idempotency = new Map<string, { readonly input: string; readonly runId: string }>();
  private readonly now: () => number;
  private readonly idFactory: (operationId: string) => string;

  constructor(options: RunCoordinatorOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? ((operationId) => `${operationId}-${this.now()}`);
  }

  registerOperation(definition: OperationDefinition): void {
    if (this.operations.has(definition.operationId)) throw new Error(`operation already registered: ${definition.operationId}`);
    this.operations.set(definition.operationId, Object.freeze({ ...definition }));
  }

  accept(request: OperationRunRequest): RunAcceptedResult {
    if (request.idempotencyKey !== undefined) {
      const key = `${request.scope}:${request.operationId}:${request.idempotencyKey}`;
      const existing = this.idempotency.get(key);
      if (existing !== undefined) {
        if (existing.input !== stableInput(request.input)) return error('idempotency-conflict', 'The idempotency key was reused with a different payload.');
        const run = this.runs.get(existing.runId);
        if (run !== undefined) return { ok: true, runId: run.runId, reused: true, run };
      }
    }
    if (this.runs.has(request.runId)) return error('run-id-conflict', `runId "${request.runId}" is already in use.`) as RunAcceptedResult;
    const created = createOperationRun(request, this.now());
    if (!created.ok) return created;
    const run = created.value;
    this.runs.set(run.runId, run);
    this.events.set(run.runId, [acceptedEvent(run)]);
    if (request.idempotencyKey !== undefined) {
      this.idempotency.set(`${request.scope}:${request.operationId}:${request.idempotencyKey}`, { input: stableInput(request.input), runId: run.runId });
    }
    return { ok: true, runId: run.runId, reused: false, run };
  }

  dispatchOperation(
    operationId: string,
    input: unknown,
    request: Omit<OperationRunRequest, 'operationId' | 'input' | 'runId'> & Partial<Pick<OperationRunRequest, 'runId' | 'input'>>,
  ): RunAcceptedResult {
    const definition = this.operations.get(operationId);
    if (!definition) return error('not-supported', `operation "${operationId}" is not registered.`, ['editor.discover']) as RunAcceptedResult;
    const accepted = this.accept({
      ...request,
      operationId,
      input,
      runId: request.runId ?? this.idFactory(operationId),
      cancellable: request.cancellable ?? definition.cancellable,
      retryable: request.retryable ?? definition.retryable,
    });
    if (!accepted.ok) return accepted;
    if (accepted.reused) return accepted;
    const running = this.apply({ type: 'running', runId: accepted.runId, at: this.now() });
    if (!running.ok) return running as RunAcceptedResult;
    this.apply({ type: 'progress', runId: accepted.runId, at: this.now(), progress: { fraction: 1, stage: 'complete' } });
    let result: unknown;
    try {
      result = definition.execute(input);
    } catch (cause) {
      this.failRun(accepted.runId, executorError(cause, definition.retryable ?? false));
      return accepted;
    }
    if (isPromiseLike(result)) {
      void result.then(
        (value) => this.apply({ type: 'succeeded', runId: accepted.runId, at: this.now(), result: value }),
        (cause) => this.failRun(accepted.runId, executorError(cause, definition.retryable ?? false)),
      );
    } else if (typeof result === 'object' && result !== null && 'ok' in result && (result as { ok?: unknown }).ok === false) {
      const failed = result as { error?: CommandError };
      this.failRun(accepted.runId, failed.error ?? {
        code: 'operation-failed',
        hint: 'The operation returned a failed result.',
        retryable: definition.retryable ?? false,
        recoveryActions: definition.retryable ? ['operation.retry'] : [],
      });
    } else {
      this.apply({ type: 'succeeded', runId: accepted.runId, at: this.now(), result });
    }
    return accepted;
  }

  apply(input: RunEventInput): RunReducerResult {
    const current = this.runs.get(input.runId);
    if (!current) return error('run-not-found', `run "${input.runId}" is not known.`, ['run.list']);
    const event = { ...input, sequence: input.sequence ?? current.sequence + 1 } as OperationRunEvent;
    const next = reduceOperationRun(current, event);
    if (!next.ok) return next;
    this.runs.set(input.runId, next.value);
    this.events.get(input.runId)?.push(Object.freeze(event));
    return next;
  }

  updateProgress(runId: string, progress: RunProgress): RunReducerResult {
    return this.apply({ type: 'progress', runId, at: this.now(), progress });
  }

  failRun(runId: string, runError: CommandError): RunReducerResult {
    return this.apply({ type: 'failed', runId, at: this.now(), error: runError });
  }

  cancelRun(runId: string): RunReducerResult {
    const run = this.runs.get(runId);
    if (!run) return error('run-not-found', `run "${runId}" is not known.`, ['run.list']);
    if (!run.cancellable) return error('run-not-cancellable', 'The operation cannot be cancelled at this phase.');
    return this.apply({ type: 'cancelled', runId, at: this.now() });
  }

  retryRun(runId: string, retryRunId: string): RunAcceptedResult {
    const run = this.runs.get(runId);
    if (!run) return error('run-not-found', `run "${runId}" is not known.`, ['run.list']) as RunAcceptedResult;
    if (run.status !== 'failed' || !run.retryable) return error('run-not-retryable', 'Only retryable failed runs can create a new attempt.');
    return this.accept({
      runId: retryRunId,
      operationId: run.operationId,
      actor: run.actor,
      sessionId: run.sessionId,
      scope: run.scope,
      ...(run.input === undefined ? {} : { input: run.input }),
      parentRunId: run.runId,
      traceId: run.traceId,
      idempotencyKey: run.idempotencyKey === undefined ? undefined : `${run.idempotencyKey}:attempt:${run.attempt + 1}`,
      attempt: run.attempt + 1,
      cancellable: run.cancellable,
      retryable: run.retryable,
    });
  }

  getRun(runId: string): OperationRun | undefined {
    return this.runs.get(runId);
  }

  listEvents(runId: string): RunCoordinatorEvent[] {
    return [...(this.events.get(runId) ?? [])];
  }

  isTerminal(runId: string): boolean {
    const run = this.runs.get(runId);
    return run !== undefined && isTerminalRunStatus(run.status);
  }
}

export { OperationRunCoordinator as RunCoordinator };

function stableInput(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableInput).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableInput(record[key])}`).join(',')}}`;
}
