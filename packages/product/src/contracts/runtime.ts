import type { CommandError } from './error';

export const RUNTIME_CONTRACT_VERSION = 'game-runtime/v1' as const;

export type RuntimeHost = 'bun' | 'browser' | 'play' | (string & {});
export type RuntimeOperation = 'play' | 'stop' | 'query' | 'fixedStep' | 'dispose' | 'capture' | 'reveal';

export type RuntimeSchemaResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: { readonly issues: readonly string[] } };

export interface RuntimeSchema<T> {
  safeParse(value: unknown): RuntimeSchemaResult<T>;
}

function schema<T>(parse: (value: unknown) => T | undefined, description: string): RuntimeSchema<T> {
  return {
    safeParse(value) {
      const data = parse(value);
      return data === undefined
        ? { success: false, error: { issues: [description] } }
        : { success: true, data };
    },
  };
}

const RUNTIME_OPERATIONS: readonly RuntimeOperation[] = Object.freeze([
  'play', 'stop', 'query', 'fixedStep', 'dispose', 'capture', 'reveal',
]);

export const RuntimeOperationSchema: RuntimeSchema<RuntimeOperation> = schema(
  (value) => typeof value === 'string' && (RUNTIME_OPERATIONS as readonly string[]).includes(value)
    ? value as RuntimeOperation
    : undefined,
  'runtime operation must be one of play, stop, query, fixedStep, dispose, capture, reveal',
);

export interface RuntimeCapabilityAvailable {
  readonly available: true;
  readonly blocking?: false;
  readonly reason?: string;
}

export interface RuntimeCapabilityUnavailable {
  readonly available: false;
  readonly blocking?: boolean;
  readonly code: string;
  readonly reason: string;
  readonly resolution?: string;
}

export type RuntimeCapability = RuntimeCapabilityAvailable | RuntimeCapabilityUnavailable;

export interface RuntimeAvailability {
  readonly version: typeof RUNTIME_CONTRACT_VERSION;
  readonly host: RuntimeHost;
  readonly blocking: boolean;
  readonly capabilities: Readonly<Partial<Record<RuntimeOperation, RuntimeCapability>>>;
}

export const RuntimeAvailabilitySchema: RuntimeSchema<RuntimeAvailability> = schema((value) => {
  if (value === null || typeof value !== 'object') return undefined;
  const candidate = value as Partial<RuntimeAvailability>;
  if (candidate.version !== RUNTIME_CONTRACT_VERSION || typeof candidate.host !== 'string' || typeof candidate.blocking !== 'boolean') return undefined;
  if (candidate.capabilities === null || typeof candidate.capabilities !== 'object') return undefined;
  return value as RuntimeAvailability;
}, 'runtime availability must contain version, host, blocking, and capabilities');

export interface RuntimeWorldHandle {
  readonly worldId: string;
}

export interface RuntimeEntityHandle extends RuntimeWorldHandle {
  readonly entityId: string;
}

export type RuntimeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CommandError };

export interface GameRuntimePort {
  availability(): RuntimeAvailability;
  play(): Promise<RuntimeResult<RuntimeWorldHandle>>;
  stop(): Promise<RuntimeResult<void>>;
  query(query?: string | RuntimeEntityHandle): Promise<RuntimeResult<unknown>>;
  fixedStep(deltaMs: number): Promise<RuntimeResult<void>>;
  dispose(): Promise<RuntimeResult<void>>;
  capture(): Promise<RuntimeResult<unknown>>;
  reveal(artifact: unknown): Promise<RuntimeResult<void>>;
}

export function createRuntimeAvailability(input: {
  readonly host: RuntimeHost;
  readonly blocking?: boolean;
  readonly capabilities: Readonly<Partial<Record<RuntimeOperation, RuntimeCapability>>>;
}): RuntimeAvailability {
  return Object.freeze({
    version: RUNTIME_CONTRACT_VERSION,
    host: input.host,
    blocking: input.blocking ?? false,
    capabilities: Object.freeze(Object.fromEntries(
      Object.entries(input.capabilities).map(([key, value]) => [key, Object.freeze({ ...value })]),
    )) as RuntimeAvailability['capabilities'],
  });
}

export function runtimeError(
  code: string,
  hint: string,
  options: Partial<Omit<CommandError, 'code' | 'hint' | 'recoveryActions'>> & { readonly recoveryActions?: readonly string[] } = {},
): CommandError {
  return Object.freeze({
    code,
    hint,
    retryable: options.retryable ?? false,
    recoveryActions: Object.freeze([...(options.recoveryActions ?? [])]),
    ...(options.expected === undefined ? {} : { expected: options.expected }),
    ...(options.current === undefined ? {} : { current: options.current }),
    ...(options.subjectRef === undefined ? {} : { subjectRef: options.subjectRef }),
    ...(options.confirmation === undefined ? {} : { confirmation: options.confirmation }),
    ...(options.message === undefined ? {} : { message: options.message }),
  });
}

export function createStaleRuntimeHandleError(input: {
  readonly expectedWorldId: string;
  readonly actualWorldId: string;
  readonly handleId: string;
}): CommandError {
  return runtimeError('entity-state-stale-handle', 'The entity handle belongs to a different runtime world.', {
    expected: { worldId: input.expectedWorldId },
    current: { worldId: input.actualWorldId },
    subjectRef: { kind: 'entity', id: input.handleId },
    recoveryActions: ['runtime.query'],
  });
}

export function unavailableRuntimeError(operation: RuntimeOperation, reason: string, blocking = false): CommandError {
  return runtimeError(blocking ? 'runtime-unavailable' : 'display-unavailable', reason, {
    recoveryActions: ['runtime.describe'],
    retryable: !blocking,
    subjectRef: { kind: 'runtime-operation', id: operation },
  });
}
