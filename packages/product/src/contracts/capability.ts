// UI-free capability contract.
//
// The descriptor is the machine-readable fact shared by UI, Bun, and host
// adapters. Registration owns execution metadata; published descriptors never
// expose an executor closure.

import type { CommandError } from './error';

/** The lifecycle shape used by a capability consumer. */
export type CapabilityKind = 'operation' | 'query' | 'run' | 'workflow';

/** A host that can publish or execute a capability. */
export type CapabilityHost = 'bun' | 'edit' | 'play';

/** Lifecycle stage at which a capability contract is evaluated. */
export type CapabilityStage =
  | 'discover'
  | 'preflight'
  | 'dispatch'
  | 'wait'
  | 'query'
  | 'save'
  | 'capture'
  | 'resume';

/** JSON-like input or output facts used for discovery and preflight. */
export interface CapabilitySchema {
  readonly type?: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';
  readonly properties?: Readonly<Record<string, CapabilitySchema>>;
  readonly required?: readonly string[];
  readonly items?: CapabilitySchema;
  readonly enum?: readonly unknown[];
  readonly description?: string;
  readonly [key: string]: unknown;
}

/** Stable identity for the object named by a capability or error. */
export interface CapabilitySubjectRef {
  readonly kind: string;
  readonly id: string;
}

/** Availability fact for a capability that can be used now. */
export interface CapabilityAvailabilityAvailable {
  readonly available: true;
  readonly code?: 'available';
  readonly reason?: string;
  readonly resolution?: string;
}

/** Structured reason why a capability cannot be used on the current host. */
export interface CapabilityAvailabilityUnavailable {
  readonly available: false;
  readonly code:
    | 'executor-unavailable'
    | 'host-unavailable'
    | 'permission-denied'
    | 'confirmation-required'
    | 'not-supported'
    | 'wave1-input-blocked'
    | 'capability-blocked';
  readonly reason: string;
  readonly resolution?: string;
  readonly capabilityGeneration?: string;
  readonly stage?: CapabilityStage;
  readonly owner?: string;
  readonly expected?: string;
  readonly recoveryAction?: string;
  readonly diagnosticId?: string;
}

/** The machine-readable availability result returned during preflight. */
export type CapabilityAvailability =
  | CapabilityAvailabilityAvailable
  | CapabilityAvailabilityUnavailable;

/** Permission scope required by a capability invocation. */
export interface CapabilityPermission {
  readonly scope: string;
  readonly action: 'read' | 'write' | 'execute';
}

/** Confirmation policy for an invocation that may need user approval. */
export interface CapabilityConfirmation {
  readonly required: boolean;
  readonly reason?: string;
  readonly token?: string;
}

/** Cancellation policy exposed to a run coordinator; save publishes supported=false. */
export interface CapabilityCancellation {
  readonly supported: boolean;
  readonly reason?: string;
}

/** Retry policy; a retry always creates a new attempt and request correlation. */
export interface CapabilityRetry {
  readonly supported: boolean;
  readonly createsNewAttempt: boolean;
}

/** Host context supplied to an executor by the owning adapter. */
export interface CapabilityExecutorContext {
  readonly host?: CapabilityHost;
  readonly signal?: AbortSignal;
}

/** Effect entry point owned by the host adapter, never by a manifest. */
export interface CapabilityExecutor {
  readonly execute: (
    input: unknown,
    context?: CapabilityExecutorContext,
  ) => unknown | Promise<unknown>;
}

/**
 * Public, executor-free capability fact.
 *
 * `id` is always the canonical `subject.verb` name. Consumers should use the
 * schema and availability fields for discovery and preflight before dispatch.
 */
export interface CapabilityDescriptor {
  readonly id: string;
  readonly kind: CapabilityKind;
  readonly version: string;
  /** Stable domain noun, such as `editor` or `asset`. */
  readonly subject: string;
  /** Stable camelCase action or query name, such as `listCatalog`. */
  readonly verb: string;
  readonly capabilityGeneration?: string;
  readonly stage?: CapabilityStage;
  readonly owner?: string;
  readonly inputSchema: CapabilitySchema | null;
  readonly outputSchema: CapabilitySchema | null;
  readonly availability: CapabilityAvailability;
  readonly availabilityByHost?: Partial<Record<CapabilityHost, CapabilityAvailability>>;
  readonly presentationOnly?: boolean;
  readonly preconditions: readonly string[];
  readonly permission?: CapabilityPermission;
  readonly confirmation?: CapabilityConfirmation;
  readonly cancellation?: CapabilityCancellation;
  readonly retry?: CapabilityRetry;
  readonly recoveryActions: readonly string[];
  readonly recoveryAction?: string;
  readonly diagnosticId?: string;
}

export interface CapabilityGapError extends CommandError {
  readonly code: 'capability-gap';
  readonly capabilityId: string;
  readonly capabilityGeneration: string;
  readonly stage: CapabilityStage;
  readonly owner: string;
  readonly expected: string;
  readonly recoveryAction: string;
  readonly diagnosticId: string;
}

export interface CapabilityGapErrorInput {
  readonly capabilityId: string;
  readonly capabilityGeneration: string;
  readonly stage: CapabilityStage;
  readonly owner: string;
  readonly expected: string;
  readonly recoveryAction: string;
  readonly diagnosticId: string;
}

/** Internal registration fact that may attach the host-owned executor. */
export interface CapabilityRegistration extends CapabilityDescriptor {
  readonly executor?: CapabilityExecutor;
}

/** Build the canonical `subject.verb` identifier used by every host. */
export function capabilityId(subject: string, verb: string): string {
  return `${subject}.${verb}`;
}

/** Narrow unknown transport data to a minimally valid capability descriptor. */
export function isCapabilityDescriptor(value: unknown): value is CapabilityDescriptor {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<CapabilityDescriptor>;
  const baseValid = (
    typeof candidate.id === 'string' &&
    candidate.id === capabilityId(candidate.subject ?? '', candidate.verb ?? '') &&
    typeof candidate.kind === 'string' &&
    typeof candidate.version === 'string' &&
    typeof candidate.subject === 'string' &&
    typeof candidate.verb === 'string' &&
    candidate.availability !== undefined &&
    Array.isArray(candidate.preconditions) &&
    Array.isArray(candidate.recoveryActions)
  );
  if (!baseValid) return false;
  if (candidate.availability.available) return true;
  if (candidate.availability.code !== 'capability-blocked') return true;
  return (
    typeof candidate.capabilityGeneration === 'string' &&
    (candidate.availability.capabilityGeneration === undefined ||
      candidate.availability.capabilityGeneration === candidate.capabilityGeneration) &&
    typeof candidate.availability.stage === 'string' &&
    typeof candidate.availability.owner === 'string' &&
    typeof candidate.availability.recoveryAction === 'string' &&
    typeof candidate.availability.diagnosticId === 'string'
  );
}

/** Identify a discoverable capability whose owner has not published its seam. */
export function isCapabilityBlocked(value: unknown): value is CapabilityDescriptor {
  return isCapabilityDescriptor(value) &&
    !value.availability.available &&
    value.availability.code === 'capability-blocked';
}

/** Build an immutable unavailable fact without throwing during discovery. */
export function unavailableCapability(
  code: CapabilityAvailabilityUnavailable['code'],
  reason: string,
  resolution?: string,
): CapabilityAvailabilityUnavailable {
  return Object.freeze({
    available: false,
    code,
    reason,
    ...(resolution === undefined ? {} : { resolution }),
  });
}

/** Project a structured command error into capability availability. */
export function capabilityError(
  error: CommandError,
): CapabilityAvailabilityUnavailable {
  return unavailableCapability('not-supported', error.hint);
}

/** Build the structured owner handoff for a capability contract gap. */
export function capabilityGapError(input: CapabilityGapErrorInput): CapabilityGapError {
  return Object.freeze({
    code: 'capability-gap' as const,
    capabilityId: input.capabilityId,
    capabilityGeneration: input.capabilityGeneration,
    stage: input.stage,
    owner: input.owner,
    expected: input.expected,
    retryable: false,
    recoveryAction: input.recoveryAction,
    diagnosticId: input.diagnosticId,
    hint: `Capability "${input.capabilityId}" is blocked until its owner publishes the expected contract.`,
    recoveryActions: Object.freeze([input.recoveryAction]),
  }) as CapabilityGapError;
}

/** Narrow a transport value to the stable capability-gap error shape. */
export function isCapabilityGapError(value: unknown): value is CapabilityGapError {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<CapabilityGapError>;
  return candidate.code === 'capability-gap' &&
    typeof candidate.capabilityId === 'string' &&
    typeof candidate.capabilityGeneration === 'string' &&
    typeof candidate.stage === 'string' &&
    typeof candidate.owner === 'string' &&
    typeof candidate.expected === 'string' &&
    candidate.retryable === false &&
    typeof candidate.recoveryAction === 'string' &&
    typeof candidate.diagnosticId === 'string' &&
    Array.isArray(candidate.recoveryActions);
}
