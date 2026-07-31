// Gateway-owned OperationRun read/coordination surface.
//
// This module deliberately reuses the product OperationRun/RunJournal contract.
// It owns no save-specific status type: save is only the first adopter of this
// request-correlated run surface.

import {
  isCommandError,
  isTerminalRunStatus,
  RunJournal,
  type CommandError,
  type OperationRun,
  type RunActor,
  type RunJournalAcceptResult,
  type RunJournalResult,
  type RunProgress,
} from '@forgeax/editor-product';

export type { OperationRun } from '@forgeax/editor-product';

export type OperationRunReadResult<T = OperationRun> = RunJournalResult<T>;
/** Listener for a Gateway-owned run projection update. */
export type OperationRunListener = (run: OperationRun) => void;
export type OperationRunCancelResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: CommandError };
export type OperationRunCancelHandler = () => OperationRunCancelResult;

/**
 * Consistent read of the bounded run index. `revision` changes whenever the
 * index publishes a new accepted/running/progress/terminal fact, so UI and AI
 * projections can detect a newer snapshot without owning a second status map.
 */
export interface OperationRunSnapshot {
  readonly revision: number;
  readonly runs: readonly OperationRun[];
}

export interface OperationRunRegistryOptions {
  readonly scope?: string;
  readonly now?: () => number;
  readonly maxTerminalRuns?: number;
}

export interface SaveRunAcceptOptions {
  readonly parentRunId?: string;
  readonly attempt?: number;
}

export interface OperationRunAcceptOptions {
  readonly operationId: string;
  readonly cancellable: boolean;
  readonly retryable: boolean;
  readonly parentRunId?: string;
  readonly attempt?: number;
}

function failure(
  code: string,
  hint: string,
  options: {
    readonly current?: unknown;
    readonly recoveryActions?: readonly string[];
    readonly retryable?: boolean;
  } = {},
): { readonly ok: false; readonly error: CommandError } {
  return {
    ok: false,
    error: {
      code,
      hint,
      current: options.current,
      retryable: options.retryable ?? false,
      recoveryActions: options.recoveryActions ?? [],
    },
  };
}

function effectError(cause: unknown): CommandError {
  if (isCommandError(cause)) return cause;
  return {
    code: 'operation-failed',
    hint: cause instanceof Error ? cause.message : 'The operation effect failed.',
    retryable: true,
    recoveryActions: ['operation.retry'],
  };
}

function isEffectFailure(value: unknown): value is { readonly ok: false; readonly error: CommandError } {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { readonly ok?: unknown; readonly error?: unknown };
  return candidate.ok === false && isCommandError(candidate.error);
}

function isEffectSuccess(value: unknown): value is { readonly ok: true; readonly result: unknown } {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { readonly ok?: unknown; readonly result?: unknown };
  return candidate.ok === true && Object.prototype.hasOwnProperty.call(candidate, 'result');
}

export class OperationRunRegistry {
  private readonly journal: RunJournal;
  private readonly scope: string;
  private readonly now: () => number;
  private readonly listeners = new Map<string, Set<OperationRunListener>>();
  private readonly allListeners = new Set<OperationRunListener>();
  private readonly cancelHandlers = new Map<string, OperationRunCancelHandler>();
  private activeSaveRunId: string | null = null;
  private nextRun = 0;
  private _revision = 0;

  constructor(options: OperationRunRegistryOptions = {}) {
    this.scope = options.scope ?? 'editor';
    this.now = options.now ?? (() => Date.now());
    this.journal = new RunJournal({
      scope: this.scope,
      now: this.now,
      retention: { maxTerminalRuns: options.maxTerminalRuns ?? 64 },
    });
  }

  /** Monotonic revision for projections that observe the complete run list. */
  get revision(): number {
    return this._revision;
  }

  /** Return one versioned, bounded read of every retained Gateway-owned run. */
  snapshot(): OperationRunSnapshot {
    return Object.freeze({
      revision: this._revision,
      runs: this.journal.listRuns(),
    });
  }

  acceptSave(
    requestId: string,
    input: unknown,
    actor: RunActor,
    options: SaveRunAcceptOptions = {},
  ): RunJournalAcceptResult {
    const existing = this.journal.getRunByRequestId(requestId);
    if (existing === undefined && this.activeSaveRunId !== null) {
      const current = this.journal.getRun(this.activeSaveRunId);
      if (current !== undefined && !isTerminalRunStatus(current.status)) {
        return failure('save-already-running', 'A save operation is already running.', {
          current,
          recoveryActions: ['run.wait'],
        });
      }
      this.activeSaveRunId = null;
    }

    return this.acceptOperation(requestId, input, actor, {
      operationId: 'saveDocToDisk',
      cancellable: false,
      retryable: true,
      ...options,
    });
  }

  acceptOperation(
    requestId: string,
    input: unknown,
    actor: RunActor,
    options: OperationRunAcceptOptions,
  ): RunJournalAcceptResult {
    const accepted = this.journal.accept({
      runId: `operation-run-${++this.nextRun}`,
      requestId,
      operationId: options.operationId,
      actor,
      sessionId: this.scope,
      scope: this.scope,
      input,
      ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
      ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
      cancellable: options.cancellable,
      retryable: options.retryable,
    });
    if (!accepted.ok) return accepted;
    if (!accepted.reused) {
      if (options.operationId === 'saveDocToDisk') this.activeSaveRunId = accepted.runId;
      this.notify(accepted.run);
    }
    return accepted;
  }

  markRunning(runId: string): OperationRunReadResult {
    const result = this.journal.append({ type: 'running', runId, at: this.now() });
    if (result.ok) this.notify(result.value);
    return result;
  }

  reportProgress(runId: string, progress: RunProgress): OperationRunReadResult {
    const result = this.journal.updateProgress(runId, progress);
    if (result.ok) this.notify(result.value);
    return result;
  }

  /** Register the effect-owned policy for cancelling an accepted run. */
  registerCancelHandler(runId: string, handler: OperationRunCancelHandler): void {
    this.cancelHandlers.set(runId, handler);
  }

  bindCompletion(
    runId: string,
    completion: Promise<unknown>,
    onTerminal?: (run: OperationRun) => void,
  ): void {
    void completion.then(
      (value) => this.finish(
        runId,
        isEffectFailure(value)
          ? { ok: false, error: value.error }
          : { ok: true, result: isEffectSuccess(value) ? value.result : value },
        onTerminal,
      ),
      (cause: unknown) => this.finish(runId, { ok: false, error: effectError(cause) }, onTerminal),
    );
  }

  fail(runId: string, error: CommandError): OperationRunReadResult {
    const normalizedError: CommandError = {
      ...error,
      retryable: error.retryable ?? false,
      recoveryActions: error.recoveryActions ?? [],
    };
    const result = this.journal.append({ type: 'failed', runId, at: this.now(), error: normalizedError });
    if (result.ok) {
      this.cancelHandlers.delete(runId);
      if (this.activeSaveRunId === runId) this.activeSaveRunId = null;
      this.notify(result.value);
    }
    return result;
  }

  getRun(requestId: string): OperationRun | undefined {
    return this.journal.getRunByRequestId(requestId);
  }

  listRuns(): readonly OperationRun[] {
    return this.journal.listRuns();
  }

  getRunResult(requestId: string): OperationRunReadResult {
    return this.journal.getRunResultByRequestId(requestId);
  }

  subscribe(requestId: string, listener: OperationRunListener): () => void {
    const current = this.getRun(requestId);
    if (current !== undefined) listener(current);
    if (current === undefined) return () => undefined;
    return this.subscribeRun(current.runId, listener);
  }

  /** Subscribe to every Gateway-owned run fact, including terminal updates. */
  subscribeAll(listener: OperationRunListener): () => void {
    this.allListeners.add(listener);
    return () => this.allListeners.delete(listener);
  }

  wait(requestId: string): Promise<OperationRunReadResult> {
    const current = this.getRunResult(requestId);
    if (!current.ok || isTerminalRunStatus(current.value.status)) return Promise.resolve(current);
    return new Promise((resolve) => {
      const unsubscribe = this.subscribeRun(current.value.runId, (run) => {
        if (!isTerminalRunStatus(run.status)) return;
        unsubscribe();
        resolve({ ok: true, value: run });
      });
    });
  }

  cancel(requestId: string): OperationRunReadResult<never> {
    const current = this.getRunResult(requestId);
    if (!current.ok) return current;
    if (!current.value.cancellable) {
      return failure('run-not-cancellable', `${current.value.operationId} cannot be cancelled at this phase.`, {
        current: current.value,
        recoveryActions: ['run.wait'],
      });
    }
    if (isTerminalRunStatus(current.value.status)) {
      return failure('run-terminal', `${current.value.operationId} is already terminal.`, {
        current: current.value,
        recoveryActions: ['run.get'],
      });
    }
    const handler = this.cancelHandlers.get(current.value.runId);
    const decision = handler?.() ?? { ok: true as const };
    if (!decision.ok) {
      return failure(decision.error.code, decision.error.hint, {
        current: current.value,
        recoveryActions: decision.error.recoveryActions,
        retryable: decision.error.retryable,
      });
    }
    const result = this.journal.append({
      type: 'cancelled',
      runId: current.value.runId,
      at: this.now(),
      error: {
        code: 'run-cancelled',
        hint: `${current.value.operationId} was cancelled before its next write boundary.`,
        retryable: false,
        recoveryActions: ['run.get'],
      },
    });
    if (result.ok) {
      this.cancelHandlers.delete(current.value.runId);
      if (this.activeSaveRunId === current.value.runId) this.activeSaveRunId = null;
      this.notify(result.value);
    }
    return result as OperationRunReadResult<never>;
  }

  retry(
    requestId: string,
    retryRequestId: string,
    actor: RunActor,
  ): RunJournalAcceptResult {
    const current = this.getRunResult(requestId);
    if (!current.ok) return current;
    if (current.value.status !== 'failed' || !current.value.retryable) {
      return failure('operation-not-retryable', 'Only a retryable failed run can be retried.', {
        current: current.value,
        recoveryActions: ['run.get'],
      });
    }
    if (current.value.operationId === 'saveDocToDisk') {
      return this.acceptSave(retryRequestId, current.value.input, actor, {
        parentRunId: current.value.runId,
        attempt: current.value.attempt + 1,
      });
    }
    if (current.value.input === null || typeof current.value.input !== 'object' || Array.isArray(current.value.input)) {
      return failure('operation-not-retryable', 'The failed operation did not retain replayable input.', {
        current: current.value,
      });
    }
    return this.acceptOperation(
      retryRequestId,
      { ...(current.value.input as Record<string, unknown>), requestId: retryRequestId },
      actor,
      {
        operationId: current.value.operationId,
        cancellable: current.value.cancellable,
        retryable: current.value.retryable,
        parentRunId: current.value.runId,
        attempt: current.value.attempt + 1,
      },
    );
  }

  private subscribeRun(runId: string, listener: OperationRunListener): () => void {
    const listeners = this.listeners.get(runId) ?? new Set<OperationRunListener>();
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(runId);
    };
  }

  private finish(
    runId: string,
    outcome: { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: CommandError },
    onTerminal?: (run: OperationRun) => void,
  ): void {
    const result = outcome.ok
      ? this.journal.append({ type: 'succeeded', runId, at: this.now(), result: outcome.result })
      : this.journal.append({ type: 'failed', runId, at: this.now(), error: outcome.error });
    if (!result.ok) return;
    this.cancelHandlers.delete(runId);
    if (this.activeSaveRunId === runId) this.activeSaveRunId = null;
    this.notify(result.value);
    onTerminal?.(result.value);
  }

  private notify(run: OperationRun): void {
    this._revision += 1;
    const listeners = this.listeners.get(run.runId);
    if (listeners !== undefined) {
      for (const listener of listeners) listener(run);
    }
    for (const listener of this.allListeners) listener(run);
  }
}
