import type { CommandError } from './error';

export const VIEWPORT_RUNTIME_CONTRACT_VERSION = 'viewport-runtime/v1' as const;

export const VIEWPORT_CARRIER_KINDS = [
  'local',
  'iframe',
  'browser-page',
  'tauri-webview',
] as const;

export type ViewportCarrierKind = typeof VIEWPORT_CARRIER_KINDS[number];

/**
 * Identity of one replaceable Runtime authority. Runtime generation fences all
 * late messages after a restart or carrier relocation; renderer generation is
 * a separate producer fact and does not substitute for it.
 */
export interface ViewportRuntimeIdentity {
  readonly version: typeof VIEWPORT_RUNTIME_CONTRACT_VERSION;
  readonly runtimeId: string;
  readonly runtimeGeneration: number;
  readonly carrierId: string;
  readonly carrierKind: ViewportCarrierKind;
}

export type ViewportProjectionStatus = 'ready' | 'empty' | 'unavailable' | 'faulted';

interface ViewportProjectionBase {
  readonly version: typeof VIEWPORT_RUNTIME_CONTRACT_VERSION;
  readonly runtime: ViewportRuntimeIdentity;
  /** Monotonic only within runtime.runtimeGeneration. */
  readonly revision: number;
}

export type ViewportProjectionEnvelope<T> =
  | (ViewportProjectionBase & { readonly status: 'ready'; readonly value: T })
  | (ViewportProjectionBase & { readonly status: 'empty' })
  | (ViewportProjectionBase & { readonly status: 'unavailable'; readonly error: CommandError })
  | (ViewportProjectionBase & { readonly status: 'faulted'; readonly error: CommandError });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isViewportCarrierKind(value: unknown): value is ViewportCarrierKind {
  return typeof value === 'string' && (VIEWPORT_CARRIER_KINDS as readonly string[]).includes(value);
}

export function isViewportRuntimeIdentity(value: unknown): value is ViewportRuntimeIdentity {
  if (!isRecord(value)) return false;
  return value.version === VIEWPORT_RUNTIME_CONTRACT_VERSION
    && typeof value.runtimeId === 'string'
    && value.runtimeId.length > 0
    && Number.isSafeInteger(value.runtimeGeneration)
    && (value.runtimeGeneration as number) > 0
    && typeof value.carrierId === 'string'
    && value.carrierId.length > 0
    && isViewportCarrierKind(value.carrierKind);
}

/** Reject delayed messages from a replaced Runtime before touching panel state. */
export function isCurrentViewportRuntime(
  expected: ViewportRuntimeIdentity,
  received: Pick<ViewportRuntimeIdentity, 'runtimeId' | 'runtimeGeneration'>,
): boolean {
  return expected.runtimeId === received.runtimeId
    && expected.runtimeGeneration === received.runtimeGeneration;
}

export function isViewportProjectionEnvelope(value: unknown): value is ViewportProjectionEnvelope<unknown> {
  if (!isRecord(value)
    || value.version !== VIEWPORT_RUNTIME_CONTRACT_VERSION
    || !isViewportRuntimeIdentity(value.runtime)
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0
  ) return false;

  if (value.status === 'ready') return 'value' in value;
  if (value.status === 'empty') return !('value' in value) && !('error' in value);
  if (value.status === 'unavailable' || value.status === 'faulted') {
    const error = value.error;
    return isRecord(error)
      && typeof error.code === 'string'
      && typeof error.hint === 'string'
      && typeof error.retryable === 'boolean'
      && Array.isArray(error.recoveryActions);
  }
  return false;
}
