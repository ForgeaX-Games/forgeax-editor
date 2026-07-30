import type { CommandError } from './error';
import type { OperationRun, OperationRunRequest, RunActor } from './run';

export const AUTHORED_COMMIT_SCHEMA_VERSION = 'authored-commit/v1' as const;

export type CommitPhase =
  | 'prepare'
  | 'resource-committed'
  | 'effect-committed'
  | 'authored-published'
  | 'failed';

export interface CommitEvent {
  readonly schemaVersion: typeof AUTHORED_COMMIT_SCHEMA_VERSION;
  readonly phase: CommitPhase;
  readonly runId: string;
  readonly at: number;
  readonly revision?: string;
  readonly error?: CommandError;
}

export interface ResourceCommitResult {
  readonly revision: string;
  readonly result?: unknown;
}

export interface PreparedResource {
  readonly commit: () => Promise<ResourceCommitResult>;
  readonly rollback?: () => Promise<void>;
}

export interface ResourcePrepareContext<TInput = unknown> {
  readonly runId: string;
  readonly operationId: string;
  readonly input: TInput;
}

export interface ResourceTransactionPort<TInput = unknown> {
  readonly prepare: (
    input: TInput,
    context: ResourcePrepareContext<TInput>,
  ) => Promise<PreparedResource>;
}

export interface CanonicalEffectContext<TResource = ResourceCommitResult | undefined> {
  readonly runId: string;
  readonly operationId: string;
  readonly input: unknown;
  readonly resource: TResource;
  readonly expectedRevision?: string;
}

export interface CanonicalEffect<TResult = unknown> {
  readonly revision: string;
  readonly result: TResult;
  readonly inverse?: unknown;
}

export interface CanonicalEffectPort<TResult = unknown> {
  readonly commit: (
    context: CanonicalEffectContext,
  ) => Promise<CanonicalEffect<TResult>>;
}

export interface AuthoredCommit<TResult = unknown> {
  readonly schemaVersion: typeof AUTHORED_COMMIT_SCHEMA_VERSION;
  readonly runId: string;
  readonly operationId: string;
  readonly actor: RunActor;
  readonly revision: string;
  readonly result: TResult;
  readonly inverse?: unknown;
  readonly resourceRevision?: string;
}

export interface AuthoredHistoryPort<TResult = unknown> {
  readonly publish: (commit: AuthoredCommit<TResult>) => void | Promise<void>;
}

export type CommitRunRequest = Omit<OperationRunRequest, 'operationId' | 'input'> & {
  readonly runId: string;
};

export interface CommitRequest<TInput = unknown, TResult = unknown> {
  readonly operationId: string;
  readonly input: TInput;
  readonly run: CommitRunRequest;
  readonly resources?: ResourceTransactionPort<TInput>;
  readonly effect: CanonicalEffectPort<TResult>;
  readonly authored: AuthoredHistoryPort<TResult>;
  readonly expectedRevision?: string;
}

export type CommitResult<TResult = unknown> =
  | {
      readonly ok: true;
      readonly runId: string;
      readonly reused: boolean;
      readonly run: OperationRun;
      readonly commit: AuthoredCommit<TResult>;
      readonly revision: string;
    }
  | { readonly ok: false; readonly error: CommandError; readonly run?: OperationRun };
