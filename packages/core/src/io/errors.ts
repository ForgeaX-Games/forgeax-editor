import type { CommandError } from '../types';
import { VERSION_CONTROL_ERROR_CODES, type VersionControlErrorCode } from './version-control-schema';

export { VERSION_CONTROL_ERROR_CODES } from './version-control-schema';

export interface VersionControlCommandErrorInput {
  readonly code: VersionControlErrorCode;
  readonly hint: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly stage?: string;
  readonly requestId?: string;
  readonly commitIdentity?: string;
  readonly recoveryActions?: readonly string[];
  readonly cause?: unknown;
  readonly retryable?: boolean;
}

export function createVersionControlCommandError(input: VersionControlCommandErrorInput): CommandError {
  return {
    code: input.code,
    hint: input.hint,
    owner: 'platform-io',
    category: 'resource',
    operationId: input.requestId === undefined ? 'version-control' : input.requestId,
    ...(input.expected === undefined ? {} : { expected: input.expected }),
    ...(input.actual === undefined ? {} : { actual: input.actual }),
    ...(input.stage === undefined ? {} : { stage: input.stage }),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.commitIdentity === undefined ? {} : { commitIdentity: input.commitIdentity }),
    ...(input.cause === undefined ? {} : { cause: boundedCause(input.cause) }),
    retryable: input.retryable ?? true,
    recoveryActions: input.recoveryActions ?? ['version-control.refresh', 'run.retry'],
  } as CommandError;
}

function boundedCause(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  const candidate = value as { code?: unknown; hint?: unknown; details?: unknown };
  return {
    ...(typeof candidate.code === 'string' ? { code: candidate.code.slice(0, 96) } : {}),
    ...(typeof candidate.hint === 'string' ? { hint: candidate.hint.slice(0, 512) } : {}),
    ...(candidate.details === undefined ? {} : { details: candidate.details }),
  };
}

export function normalizeVersionControlFailure(
  cause: unknown,
  context: Pick<VersionControlCommandErrorInput, 'stage' | 'requestId'> = {},
): CommandError {
  if (cause !== null && typeof cause === 'object' && VERSION_CONTROL_ERROR_CODES.includes((cause as { code?: unknown }).code as never)) {
    return createVersionControlCommandError({
      ...(cause as VersionControlCommandErrorInput),
      code: (cause as { code: VersionControlErrorCode }).code,
      hint: typeof (cause as { hint?: unknown }).hint === 'string' ? (cause as { hint: string }).hint : 'Version control command failed.',
      ...context,
    });
  }
  return createVersionControlCommandError({
    code: 'version-control-unexpected',
    hint: 'The version control command failed.',
    ...context,
    cause,
  });
}
