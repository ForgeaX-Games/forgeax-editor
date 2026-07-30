import {
  type AuthoredCommit,
  type CanonicalEffectContext,
  type CommitEvent,
  type CommitRequest,
  type CommitResult,
  type ResourceCommitResult,
} from '../contracts/commit';
import type { CommandError } from '../contracts/error';
import { OperationRunCoordinator } from './run-coordinator';

export interface CommitCollarOptions {
  readonly now?: () => number;
  readonly coordinator?: OperationRunCoordinator;
  readonly onEvent?: (event: CommitEvent) => void;
}

export interface UndoRedoRequest<TResult = unknown> {
  readonly sourceRunId: string;
  readonly expectedRevision: string;
  readonly run: CommitRequest['run'] & { readonly operationId?: string };
  readonly effect: CommitRequest<unknown, TResult>['effect'];
  readonly authored: CommitRequest<unknown, TResult>['authored'];
  readonly input?: unknown;
}

function failed(hint: string, run?: CommitResult['run']): CommitResult<never> {
  return {
    ok: false,
    error: {
      code: 'commit-collar-failed',
      hint,
      retryable: true,
      recoveryActions: ['operation.retry'],
    },
    ...(run === undefined ? {} : { run }),
  };
}

function revisionConflict(expected: string, actual: string): CommitResult<never> {
  return {
    ok: false,
    error: {
      code: 'revision-conflict',
      hint: `Expected revision "${expected}" but source effect is at "${actual}".`,
      retryable: false,
      recoveryActions: ['operation.rebase'],
    },
  };
}

function asError(cause: unknown): CommandError {
  return {
    code: 'commit-collar-failed',
    hint: cause instanceof Error ? cause.message : String(cause),
    retryable: true,
    recoveryActions: ['operation.retry'],
  };
}

export class CommitCollar {
  readonly coordinator: OperationRunCoordinator;
  private readonly now: () => number;
  private readonly onEvent: (event: CommitEvent) => void;
  private readonly commits = new Map<string, AuthoredCommit>();
  private currentRevision: string | undefined;

  constructor(options: CommitCollarOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.coordinator = options.coordinator ?? new OperationRunCoordinator({ now: this.now });
    this.onEvent = options.onEvent ?? (() => {});
  }

  async dispatch<TInput, TResult>(request: CommitRequest<TInput, TResult>): Promise<CommitResult<TResult>> {
    const accepted = this.coordinator.accept({ ...request.run, operationId: request.operationId, input: request.input });
    if (!accepted.ok) return accepted;
    if (accepted.reused) {
      const commit = this.commits.get(accepted.runId) as AuthoredCommit<TResult> | undefined;
      return commit === undefined ? failed('The idempotent run has no authored commit.', accepted.run) : { ok: true, runId: accepted.runId, reused: true, run: accepted.run, commit, revision: commit.revision };
    }
    const running = this.coordinator.apply({ type: 'running', runId: accepted.runId, at: this.now() });
    if (!running.ok) return running;
    this.onEvent({ schemaVersion: 'authored-commit/v1', phase: 'prepare', runId: accepted.runId, at: this.now() });
    let prepared: Awaited<ReturnType<NonNullable<CommitRequest<TInput, TResult>['resources']>['prepare']>> | undefined;
    try {
      prepared = request.resources === undefined
        ? undefined
        : await request.resources.prepare(request.input, { runId: accepted.runId, operationId: request.operationId, input: request.input });
      const resource = prepared === undefined ? undefined : await prepared.commit();
      this.publishResourceEvent(accepted.runId, resource);
      const context: CanonicalEffectContext<ResourceCommitResult | undefined> = {
        runId: accepted.runId,
        operationId: request.operationId,
        input: request.input,
        resource,
        ...(request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision }),
      };
      const effect = await request.effect.commit(context);
      this.onEvent({ schemaVersion: 'authored-commit/v1', phase: 'effect-committed', runId: accepted.runId, at: this.now(), revision: effect.revision });
      const commit: AuthoredCommit<TResult> = {
        schemaVersion: 'authored-commit/v1',
        runId: accepted.runId,
        operationId: request.operationId,
        actor: accepted.run.actor,
        revision: effect.revision,
        result: effect.result,
        ...(effect.inverse === undefined ? {} : { inverse: effect.inverse }),
        ...(resource === undefined ? {} : { resourceRevision: resource.revision }),
      };
      await request.authored.publish(commit);
      this.commits.set(accepted.runId, commit);
      this.currentRevision = effect.revision;
      this.onEvent({ schemaVersion: 'authored-commit/v1', phase: 'authored-published', runId: accepted.runId, at: this.now(), revision: effect.revision });
      const succeeded = this.coordinator.apply({ type: 'succeeded', runId: accepted.runId, at: this.now(), result: commit });
      if (!succeeded.ok) return succeeded;
      return { ok: true, runId: accepted.runId, reused: false, run: succeeded.value, commit, revision: commit.revision };
    } catch (cause) {
      await this.rollback(prepared);
      const runError = asError(cause);
      this.onEvent({ schemaVersion: 'authored-commit/v1', phase: 'failed', runId: accepted.runId, at: this.now(), error: runError });
      const failedRun = this.coordinator.failRun(accepted.runId, runError);
      return { ok: false, error: runError, ...(failedRun.ok ? { run: failedRun.value } : {}) };
    }
  }

  async undo<TResult>(request: UndoRedoRequest<TResult>): Promise<CommitResult<TResult>> {
    return this.replay('undo', request);
  }

  async redo<TResult>(request: UndoRedoRequest<TResult>): Promise<CommitResult<TResult>> {
    return this.replay('redo', request);
  }

  getRun(runId: string) {
    return this.coordinator.getRun(runId);
  }

  getCommit(runId: string): AuthoredCommit | undefined {
    return this.commits.get(runId);
  }

  private async replay<TResult>(operationId: string, request: UndoRedoRequest<TResult>): Promise<CommitResult<TResult>> {
    const source = this.commits.get(request.sourceRunId);
    if (source === undefined) return failed(`Source run "${request.sourceRunId}" has no committed effect.`);
    const actualRevision = this.currentRevision ?? source.revision;
    if (actualRevision !== request.expectedRevision) return revisionConflict(request.expectedRevision, actualRevision);
    if (operationId === 'undo' && source.inverse === undefined) return failed(`Source run "${request.sourceRunId}" has no inverse effect.`);
    return this.dispatch({
      operationId: request.run.operationId ?? operationId,
      input: request.input === undefined ? source.inverse : request.input,
      run: request.run,
      effect: request.effect,
      authored: request.authored,
      expectedRevision: request.expectedRevision,
    });
  }

  private publishResourceEvent(runId: string, resource: ResourceCommitResult | undefined): void {
    this.onEvent({
      schemaVersion: 'authored-commit/v1',
      phase: 'resource-committed',
      runId,
      at: this.now(),
      ...(resource === undefined ? {} : { revision: resource.revision }),
    });
  }

  private async rollback(prepared: Awaited<ReturnType<NonNullable<CommitRequest['resources']>['prepare']>> | undefined): Promise<void> {
    if (prepared?.rollback === undefined) return;
    try { await prepared.rollback(); } catch { /* recovery is reported by the run */ }
  }
}
