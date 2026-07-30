// Game-scoped, schema-versioned, append-only OperationRun journal.

import type { CommandError } from '../contracts/error';
import {
  acceptedEvent,
  createOperationRun,
  reduceOperationRun,
  type OperationRun,
  type OperationRunEvent,
  type OperationRunRequest,
  type OperationRunEventInput,
  type RunProgress,
} from '../contracts/run';
import { RunIndex } from './run-index';
import {
  reconcileOperationRuns,
  type ReconciliationResolution,
} from './run-reconciliation';

export type RunJournalRecord = OperationRunEvent;
export type RunJournalEventInput = OperationRunEventInput;

export interface RunJournalOptions {
  readonly scope: string;
  readonly now?: () => number;
  readonly retention?: { readonly maxRuns?: number };
}

export interface RunJournalFromRecordsOptions extends RunJournalOptions {
  readonly records: readonly unknown[];
}

export type RunJournalAcceptResult =
  | { readonly ok: true; readonly runId: string; readonly reused: boolean; readonly run: OperationRun }
  | { readonly ok: false; readonly error: CommandError };

export type RunJournalResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CommandError };

function failure(code: string, hint: string, recoveryActions: readonly string[] = []): { readonly ok: false; readonly error: CommandError } {
  return { ok: false, error: { code, hint, retryable: false, recoveryActions } };
}

function stable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

function isRunEvent(value: unknown): value is OperationRunEvent {
  if (value === null || typeof value !== 'object') return false;
  const event = value as Partial<OperationRunEvent>;
  return typeof event.type === 'string' && typeof event.runId === 'string' && typeof event.sequence === 'number' && typeof event.at === 'number';
}

function eventKey(event: OperationRunEvent): string {
  return `${event.runId}:${event.sequence}`;
}

export class RunJournal {
  private readonly scope: string;
  private readonly now: () => number;
  private readonly maxRuns: number | undefined;
  private readonly records: RunJournalRecord[] = [];
  private readonly index = new RunIndex();
  private readonly idempotency = new Map<string, { readonly operationId: string; readonly input: string; readonly runId: string }>();
  private readonly expiredRuns = new Set<string>();
  private isolatedRecordCount = 0;

  constructor(options: RunJournalOptions) {
    this.scope = options.scope;
    this.now = options.now ?? (() => Date.now());
    this.maxRuns = options.retention?.maxRuns;
  }

  static fromRecords(options: RunJournalFromRecordsOptions): RunJournal {
    const journal = new RunJournal(options);
    for (const raw of options.records) journal.restore(raw);
    journal.prune();
    return journal;
  }

  accept(request: OperationRunRequest): RunJournalAcceptResult {
    if (request.scope !== this.scope) return failure('scope-mismatch', 'A run must be accepted in the journal scope.') as RunJournalAcceptResult;
    const key = request.idempotencyKey;
    if (key !== undefined) {
      const identity = this.idempotency.get(`${request.operationId}:${key}`);
      if (identity !== undefined) {
        if (identity.input !== stable(request.input)) return failure('idempotency-conflict', 'The idempotency key was reused with a different payload.') as RunJournalAcceptResult;
        const existing = this.index.get(identity.runId);
        if (existing !== undefined) return { ok: true, runId: existing.runId, reused: true, run: existing };
        if (this.expiredRuns.has(identity.runId)) return failure('run-expired', 'The idempotent run has expired from the derived index.', ['run.list']) as RunJournalAcceptResult;
      }
    }
    const created = createOperationRun(request, this.now());
    if (!created.ok) return created;
    const appended = this.appendRecord(acceptedEvent(created.value));
    if (!appended.ok) return appended as RunJournalAcceptResult;
    if (key !== undefined) this.idempotency.set(`${request.operationId}:${key}`, { operationId: request.operationId, input: stable(request.input), runId: created.value.runId });
    this.prune();
    return { ok: true, runId: created.value.runId, reused: false, run: this.index.get(created.value.runId) ?? created.value };
  }

  append(input: RunJournalEventInput): RunJournalResult<OperationRun> {
    const run = this.index.get(input.runId);
    if (run === undefined) return failure('run-not-found', `run "${input.runId}" is not known.`, ['run.list']);
    const event = { ...input, sequence: input.sequence ?? run.sequence + 1 } as OperationRunEvent;
    if (event.type === 'accepted') return failure('invalid-run-transition', 'An accepted record can only be written once.');
    const result = reduceOperationRun(run, event);
    if (!result.ok) return result;
    const appended = this.appendRecord(event);
    if (!appended.ok) return appended;
    return result;
  }

  getRun(runId: string): OperationRun | undefined {
    return this.index.get(runId);
  }

  getRunResult(runId: string): RunJournalResult<OperationRun> {
    if (this.index.has(runId)) return { ok: true, value: this.index.get(runId)! };
    const expired = this.expiredRuns.has(runId) || this.records.some((record) => record.runId === runId);
    return failure(expired ? 'run-expired' : 'run-not-found', `run "${runId}" is ${expired ? 'expired' : 'unknown'}.`, ['run.list']);
  }

  listRuns(): readonly OperationRun[] {
    return this.index.values();
  }

  getEffectResult(effectKey: string): { readonly runId: string; readonly result: unknown } | undefined {
    for (const run of this.index.values()) {
      if (Object.prototype.hasOwnProperty.call(run.effectResults, effectKey)) return { runId: run.runId, result: run.effectResults[effectKey] };
    }
    return undefined;
  }

  listEvents(runId: string): readonly RunJournalRecord[] {
    return Object.freeze(this.records.filter((record) => record.runId === runId).map((record) => Object.freeze({ ...record })));
  }

  listRecords(): readonly RunJournalRecord[] {
    return Object.freeze(this.records.map((record) => Object.freeze({ ...record })));
  }

  updateProgress(runId: string, progress: RunProgress): RunJournalResult<OperationRun> {
    return this.append({ type: 'progress', runId, at: this.now(), progress });
  }

  reconcile(options: { readonly resolve: (context: { readonly run: OperationRun }) => ReconciliationResolution }): { readonly ok: true; readonly reconciled: readonly string[] } {
    const resolutions = reconcileOperationRuns(this.index.values(), options.resolve);
    const reconciled: string[] = [];
    for (const { run, resolution } of resolutions) {
      const event = resolutionEvent(run, resolution, this.now());
      const result = this.append(event);
      if (result.ok) reconciled.push(run.runId);
    }
    return { ok: true, reconciled: Object.freeze(reconciled) };
  }

  diagnostics(): { readonly isolatedRecords: number } {
    return { isolatedRecords: this.isolatedRecordCount };
  }

  private appendRecord(event: OperationRunEvent): RunJournalResult<OperationRun> {
    if (event.type === 'assert-terminal') return failure('invalid-run-event', 'assert-terminal is a query, not a journal record.');
    const current = this.index.get(event.runId);
    if (event.type !== 'accepted' && current === undefined) return failure('run-not-found', `run "${event.runId}" is not known.`, ['run.list']);
    const next = event.type === 'accepted' ? createOperationRun({
      runId: event.runId,
      operationId: event.operationId,
      actor: event.actor,
      sessionId: event.sessionId,
      scope: event.scope,
      ...(event.input === undefined ? {} : { input: event.input }),
      ...(event.parentRunId === undefined ? {} : { parentRunId: event.parentRunId }),
      traceId: event.traceId,
      ...(event.idempotencyKey === undefined ? {} : { idempotencyKey: event.idempotencyKey }),
      attempt: event.attempt,
      cancellable: event.cancellable,
      retryable: event.retryable,
    }, event.at) : reduceOperationRun(current!, event);
    if (!next.ok) return next;
    this.records.push(Object.freeze({ ...event }));
    this.index.set(next.value);
    return next;
  }

  private restore(raw: unknown): void {
    if (!isRunEvent(raw) || raw.type === 'assert-terminal') {
      this.isolatedRecordCount++;
      return;
    }
    if (raw.type === 'accepted' && raw.scope !== this.scope) {
      this.isolatedRecordCount++;
      return;
    }
    const current = this.index.get(raw.runId);
    if (raw.type !== 'accepted' && current === undefined) {
      this.isolatedRecordCount++;
      return;
    }
    const result = this.appendRecord(raw);
    if (!result.ok) {
      this.isolatedRecordCount++;
      return;
    }
    if (raw.type === 'accepted' && raw.idempotencyKey !== undefined) {
      this.idempotency.set(`${raw.operationId}:${raw.idempotencyKey}`, { operationId: raw.operationId, input: stable(raw.input), runId: raw.runId });
    }
  }

  private prune(): void {
    if (this.maxRuns === undefined || this.maxRuns < 1) return;
    const acceptedRuns = [...new Set(this.records.filter((record) => record.type === 'accepted').map((record) => record.runId))];
    while (acceptedRuns.length > this.maxRuns) {
      const oldest = acceptedRuns.shift();
      if (oldest === undefined) break;
      this.expiredRuns.add(oldest);
      this.index.delete(oldest);
    }
  }
}

function resolutionEvent(run: OperationRun, resolution: ReconciliationResolution, at: number): RunJournalEventInput {
  if (resolution.state === 'succeeded') return { type: 'succeeded', runId: run.runId, at, result: resolution.result };
  if (resolution.state === 'failed') return {
    type: 'failed',
    runId: run.runId,
    at,
    error: resolution.error ?? {
      code: 'reconciliation-failed',
      hint: 'The restart reconciliation did not prove a successful effect.',
      retryable: true,
      recoveryActions: ['operation.retry'],
    },
  };
  return { type: 'cancelled', runId: run.runId, at, error: resolution.error };
}
