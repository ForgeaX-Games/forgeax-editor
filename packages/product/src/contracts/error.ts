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

/** Stable subject identity associated with the failed command. */
export interface ErrorSubjectRef {
  readonly kind: string;
  readonly id: string;
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
export interface CommandError {
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

/** Create a frozen error value with a frozen recovery action list. */
export function createCommandError(input: CommandErrorInput): CommandError {
  return Object.freeze({
    ...input,
    recoveryActions: Object.freeze([...input.recoveryActions]),
    ...(input.message === undefined ? {} : { message: input.message }),
  });
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
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.hint === 'string' &&
    typeof candidate.retryable === 'boolean' &&
    Array.isArray(candidate.recoveryActions)
  );
}
