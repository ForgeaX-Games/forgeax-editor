export const RUNTIME_READINESS_STATES = Object.freeze([
  'committed-awaiting-reload',
  'resident-ready',
  'simulation-ready',
  'render-ready',
  'visible-ready',
  'render-unavailable',
] as const);

export type RuntimeReadinessState = (typeof RUNTIME_READINESS_STATES)[number];
import type { ResourceRevision } from '@forgeax/engine-types';

export type RuntimeRevision = string | number | null | ResourceRevision | Readonly<Record<string, unknown>>;

export interface RuntimeReadiness {
  readonly state: RuntimeReadinessState;
  readonly requestId: string;
  readonly assetGuid: string;
  readonly committedRevision: RuntimeRevision;
  readonly residentRevision: RuntimeRevision;
  readonly hint: string;
}

export interface CreateRuntimeReadinessInput {
  readonly state: RuntimeReadinessState;
  readonly requestId: string;
  readonly assetGuid: string;
  readonly committedRevision: RuntimeRevision;
  readonly residentRevision: RuntimeRevision;
  readonly hint: string;
}

export function createRuntimeReadiness(input: CreateRuntimeReadinessInput): RuntimeReadiness {
  if (input.requestId.trim() === '' || input.assetGuid.trim() === '' || input.hint.trim() === '') {
    throw new Error('runtime readiness requires requestId, assetGuid, and hint');
  }
  if (!RUNTIME_READINESS_STATES.includes(input.state)) {
    throw new Error(`unknown runtime readiness state: ${input.state}`);
  }
  return Object.freeze({ ...input });
}
