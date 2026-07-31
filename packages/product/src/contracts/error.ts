// Structured capability and command errors.
//
// Callers branch on fields, never on the human-readable message. Optional
// fields are omitted when a failure does not have that kind of context.

/** Stable machine-readable error code; unknown extensions remain forward-safe. */
export type CommandErrorCode =
  | 'permission-denied'
  | 'confirmation-required'
  | 'revision-conflict'
  | 'executor-unavailable'
  | 'host-unavailable'
  | 'not-supported'
  | 'wave1-input-blocked'
  | 'invalid-run-id'
  | 'invalid-operation-id'
  | 'invalid-run-scope'
  | 'invalid-run-transition'
  | 'run-event-order'
  | 'run-terminal'
  | 'run-not-terminal'
  | 'run-not-found'
  | 'run-expired'
  | 'run-not-cancellable'
  | 'idempotency-conflict'
  | 'scope-mismatch'
  | 'host-restarted'
  | (string & {});

/** Owning layer that produced a structured failure. */
export type ErrorOwner =
  | 'editor-core'
  | 'engine'
  | 'platform-io'
  | 'host'
  | 'transport'
  | (string & {});

/** Stable recovery taxonomy; the code remains the fine-grained discriminator. */
export type ErrorCategory =
  | 'validation'
  | 'state'
  | 'resource'
  | 'transport'
  | 'runtime'
  | 'authorization'
  | 'unknown'
  | (string & {});

/** Stable subject identity associated with the failed command. */
export interface ErrorEntityLocator {
  /** The locator is only valid after the owning world/epoch is revalidated. */
  readonly kind: 'entity-handle';
  readonly handle: number;
  readonly worldRef: number;
  readonly epoch: number;
}

export interface ErrorSubjectRef {
  readonly kind: string;
  readonly id: string;
  /** Optional world-bound locator; stable refs without it are not selectable. */
  readonly locator?: ErrorEntityLocator;
}

/** Stable location references carried by an error without requiring live handles. */
export interface ErrorObjectRefs {
  readonly scene?: ErrorSubjectRef;
  readonly entity?: ErrorSubjectRef;
  readonly component?: ErrorSubjectRef;
  readonly asset?: ErrorSubjectRef;
  readonly file?: ErrorSubjectRef;
  readonly project?: ErrorSubjectRef;
  readonly operation?: ErrorSubjectRef;
}

/** JSON-safe causal link; callers must not recover control flow from hint text. */
export interface ErrorCause {
  readonly code: string;
  readonly owner?: ErrorOwner;
  readonly operationId?: string;
  readonly requestId?: string;
  readonly hint?: string;
  readonly details?: unknown;
}

/** Context shared by Gateway and UI-free domain error carriers. */
export interface CommandErrorContext {
  readonly owner?: ErrorOwner;
  readonly category?: ErrorCategory;
  readonly operationId?: string;
  readonly requestId?: string;
  readonly objectRefs?: ErrorObjectRefs;
  readonly cause?: ErrorCause;
}

/** Confirmation state required to retry a command safely. */
export interface ErrorConfirmation {
  readonly required: boolean;
  readonly token?: string;
}

/**
 * Structured command failure returned to every host.
 *
 * Consumers branch on `code`, `subjectRef`, and recovery fields. They must not
 * parse `message` or `hint` to decide control flow.
 */
export interface CommandError extends CommandErrorContext {
  /** Stable failure category used for branching and telemetry. */
  readonly code: CommandErrorCode;
  /** Human-readable context for logs and an AI explanation. */
  readonly hint: string;
  /** Expected value or shape when the command was rejected by validation. */
  readonly expected?: unknown;
  /** Current value or revision observed by the rejecting host. */
  readonly current?: unknown;
  /** Entity, asset, or other subject affected by the command. */
  readonly subjectRef?: ErrorSubjectRef;
  /** Whether the same request can be retried without changing its intent. */
  readonly retryable: boolean;
  /** Approval state when the command requires explicit confirmation. */
  readonly confirmation?: ErrorConfirmation;
  /** Canonical capability ids or actions that can help recover. */
  readonly recoveryActions: readonly string[];
  /** Optional display text; never use this field as a protocol discriminator. */
  readonly message?: string;
}

/** Input shape for creating an immutable command error. */
export interface CommandErrorInput extends Omit<CommandError, 'message'> {
  readonly message?: string;
}

/** Build the one entity reference shape shared by errors and UI locating. */
export function createEntityObjectRef(input: {
  readonly handle: number;
  readonly worldRef?: number;
  readonly epoch?: number;
}): ErrorSubjectRef {
  const locator = input.worldRef === undefined || input.epoch === undefined
    ? undefined
    : {
      kind: 'entity-handle' as const,
      handle: input.handle,
      worldRef: input.worldRef,
      epoch: input.epoch,
    };
  return {
    kind: 'entity',
    id: String(input.handle),
    ...(locator === undefined ? {} : { locator }),
  };
}

/** Create a frozen error value with a frozen recovery action list. */
export function createCommandError(input: CommandErrorInput): CommandError {
  return Object.freeze({
    ...input,
    recoveryActions: Object.freeze([...input.recoveryActions]),
    ...(input.objectRefs === undefined ? {} : { objectRefs: Object.freeze({ ...input.objectRefs }) }),
    ...(input.cause === undefined ? {} : { cause: Object.freeze({ ...input.cause }) }),
    ...(input.message === undefined ? {} : { message: input.message }),
  });
}

/** Add stable execution context without rewriting the human-readable hint. */
export function withCommandErrorContext(
  error: CommandError,
  context: CommandErrorContext,
): CommandError {
  return createCommandError({
    ...error,
    ...(context.owner === undefined ? {} : { owner: context.owner }),
    ...(context.category === undefined ? {} : { category: context.category }),
    ...(context.operationId === undefined ? {} : { operationId: context.operationId }),
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
    ...(context.objectRefs === undefined ? {} : { objectRefs: context.objectRefs }),
    ...(context.cause === undefined ? {} : { cause: context.cause }),
  });
}

/** Convert an exception into a stable causal link; no caller needs to parse it. */
export function createErrorCause(cause: unknown, owner?: ErrorOwner): ErrorCause {
  if (isCommandError(cause)) {
    return Object.freeze({
      code: cause.code,
      ...(owner === undefined && cause.owner === undefined ? {} : { owner: owner ?? cause.owner }),
      ...(cause.operationId === undefined ? {} : { operationId: cause.operationId }),
      ...(cause.requestId === undefined ? {} : { requestId: cause.requestId }),
      hint: cause.hint,
    });
  }
  if (cause instanceof Error) {
    return Object.freeze({ code: 'exception', ...(owner === undefined ? {} : { owner }), hint: cause.message });
  }
  return Object.freeze({ code: 'unknown-cause', ...(owner === undefined ? {} : { owner }), hint: 'The operation threw a non-error value.' });
}

/** Create a structured unavailable or rejected command result. */
export function unavailable(
  code: CommandErrorCode,
  options: {
    readonly hint: string;
    readonly recoveryActions?: readonly string[];
    readonly expected?: unknown;
    readonly current?: unknown;
    readonly subjectRef?: ErrorSubjectRef;
    readonly retryable?: boolean;
    readonly confirmation?: ErrorConfirmation;
    readonly message?: string;
  },
): CommandError {
  return createCommandError({
    code,
    hint: options.hint,
    expected: options.expected,
    current: options.current,
    subjectRef: options.subjectRef,
    retryable: options.retryable ?? false,
    confirmation: options.confirmation,
    recoveryActions: options.recoveryActions ?? [],
    message: options.message ?? options.hint,
  });
}

/** Narrow unknown transport data to a minimally valid command error. */
export function isCommandError(value: unknown): value is CommandError {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<CommandError>;
  const refs = candidate.objectRefs;
  const cause = candidate.cause;
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.hint === 'string' &&
    typeof candidate.retryable === 'boolean' &&
    Array.isArray(candidate.recoveryActions) &&
    (candidate.operationId === undefined || typeof candidate.operationId === 'string') &&
    (candidate.requestId === undefined || typeof candidate.requestId === 'string') &&
    (refs === undefined || (typeof refs === 'object' && refs !== null && !Array.isArray(refs))) &&
    (cause === undefined || (typeof cause === 'object' && cause !== null && typeof cause.code === 'string')) &&
    (refs === undefined || Object.values(refs).every((ref) => (
      ref === undefined
      || (typeof ref === 'object' && ref !== null && typeof ref.kind === 'string' && typeof ref.id === 'string'
        && (ref.locator === undefined
          || (typeof ref.locator === 'object' && ref.locator !== null
            && ref.kind === 'entity'
            && ref.locator.kind === 'entity-handle'
            && typeof ref.locator.handle === 'number'
            && typeof ref.locator.worldRef === 'number'
            && typeof ref.locator.epoch === 'number')))
    )))
  );
}
