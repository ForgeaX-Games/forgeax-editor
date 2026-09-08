import type { CommandError } from '@forgeax/editor-core';
import {
  createVersionControlCommandError,
  normalizeVersionControlFailure,
} from '@forgeax/editor-core';

export interface VersionControlProjectedError {
  readonly code: string;
  readonly hint: string;
  readonly stage?: string;
  readonly requestId?: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly commitIdentity?: string;
  readonly retryable?: boolean;
  readonly recoveryActions: readonly string[];
  readonly cause?: unknown;
}

export interface SwitchFailureObservation {
  readonly code: string;
  readonly headBefore: string | null;
  readonly headAfter: string | null;
  readonly dirtyBefore: boolean;
  readonly dirtyAfter: boolean | null;
  readonly generation: number;
}

export type SwitchFailureProjection =
  | {
    readonly mode: 'retain-old-runtime';
    readonly generation: number;
    readonly error: VersionControlProjectedError;
    readonly recoveryActions: readonly string[];
  }
  | {
    readonly mode: 'external-inspection-required';
    readonly generation: number;
    readonly error: VersionControlProjectedError;
    readonly mutation: 'rejected';
    readonly recoveryActions: readonly string[];
  };

/** Distinguishes a proven no-change failure from an unverifiable repository state. */
export function classifySwitchFailure(observation: SwitchFailureObservation): SwitchFailureProjection {
  const unchanged = observation.headAfter === observation.headBefore
    && observation.dirtyAfter === observation.dirtyBefore;
  if (unchanged) {
    const error = projectVersionControlError({
      code: observation.code,
      hint: 'The repository did not change; the old Runtime remains active.',
      stage: 'checkout',
      recoveryActions: ['version-control.refresh', 'run.retry'],
    });
    return {
      mode: 'retain-old-runtime',
      generation: observation.generation,
      error,
      recoveryActions: ['version-control.refresh', 'run.retry'],
    };
  }
  const error = projectVersionControlError({
    code: 'version-control-external-inspection-required',
    hint: 'Repository state could not be proven after checkout; inspect it externally before writing.',
    stage: 'checkout-postflight',
    expected: { head: observation.headBefore, dirty: observation.dirtyBefore },
    actual: { head: observation.headAfter, dirty: observation.dirtyAfter },
    recoveryActions: ['version-control.refresh', 'version-control.reconcile'],
  });
  return {
    mode: 'external-inspection-required',
    generation: observation.generation,
    error,
    mutation: 'rejected',
    recoveryActions: ['version-control.refresh', 'version-control.reconcile'],
  };
}

export function projectVersionControlError(value: unknown, context: {
  readonly stage?: string;
  readonly requestId?: string;
} = {}): VersionControlProjectedError {
  const error = normalizeVersionControlFailure(value, context);
  const candidate = error as CommandError & {
    readonly stage?: string;
    readonly commitIdentity?: string;
    readonly retryable?: boolean;
  };
  return Object.freeze({
    code: candidate.code,
    hint: candidate.hint,
    ...(candidate.stage === undefined ? {} : { stage: candidate.stage }),
    ...(candidate.requestId === undefined ? {} : { requestId: candidate.requestId }),
    ...(candidate.expected === undefined ? {} : { expected: candidate.expected }),
    ...(candidate.actual === undefined ? {} : { actual: candidate.actual }),
    ...(candidate.commitIdentity === undefined ? {} : { commitIdentity: candidate.commitIdentity }),
    ...(candidate.retryable === undefined ? {} : { retryable: candidate.retryable }),
    recoveryActions: Object.freeze([...(candidate.recoveryActions ?? [])]),
    ...(candidate.cause === undefined ? {} : { cause: candidate.cause }),
  });
}

export function createProjectedVersionControlError(input: Parameters<typeof createVersionControlCommandError>[0]): VersionControlProjectedError {
  return projectVersionControlError(createVersionControlCommandError(input), {
    ...(input.stage === undefined ? {} : { stage: input.stage }),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  });
}
