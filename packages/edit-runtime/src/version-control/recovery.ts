import { projectVersionControlError, type VersionControlProjectedError } from './error-projection';

export type RecoveryState = 'ready' | 'external-inspection-required';

export interface RecoverySnapshot {
  readonly generation: number;
  readonly repositoryIdentity: string;
  readonly head: string | null;
  readonly snapshotId: string;
}

export interface RecoveryMutationResult {
  readonly ok: false;
  readonly error: VersionControlProjectedError;
}

export interface VersionControlRecoveryController {
  readonly snapshot: () => {
    readonly state: RecoveryState;
    readonly generation: number;
    readonly lastSnapshot: RecoverySnapshot | null;
    readonly error: VersionControlProjectedError | null;
  };
  readonly freeze: (input: { readonly generation: number; readonly error: unknown }) => void;
  readonly canMutate: (generation: number) => { readonly ok: true } | RecoveryMutationResult;
  readonly reconcile: (snapshot: RecoverySnapshot) => { readonly ok: true } | RecoveryMutationResult;
}

/** Owns the edit-runtime freeze; platform-io remains unaware of Gateway state. */
export function createVersionControlRecoveryController(initialGeneration: number): VersionControlRecoveryController {
  let state: RecoveryState = 'ready';
  let generation = initialGeneration;
  let lastSnapshot: RecoverySnapshot | null = null;
  let error: VersionControlProjectedError | null = null;
  const failure = (hint: string, actual?: unknown): RecoveryMutationResult => ({
    ok: false,
    error: projectVersionControlError({
      code: 'version-control-external-inspection-required',
      hint,
      stage: 'runtime-recovery',
      expected: { state: 'ready', generation },
      actual,
      recoveryActions: ['version-control.refresh', 'version-control.reconcile'],
    }),
  });
  return {
    snapshot: () => Object.freeze({ state, generation, lastSnapshot, error }),
    freeze: (input) => {
      state = 'external-inspection-required';
      generation = input.generation;
      error = projectVersionControlError({
        code: 'version-control-external-inspection-required',
        hint: 'Inspect the repository externally before writing again.',
        stage: 'checkout-postflight',
      recoveryActions: ['version-control.refresh', 'version-control.reconcile'],
        cause: input.error,
      });
    },
    canMutate: (candidateGeneration) => {
      if (state !== 'ready') return failure('External repository inspection is required before mutation.');
      if (candidateGeneration !== generation) return failure('The mutation targets a stale Runtime generation.', candidateGeneration);
      return { ok: true };
    },
    reconcile: (next) => {
      if (next.generation !== generation) return failure('The reconciliation snapshot belongs to a different Runtime generation.', next.generation);
      lastSnapshot = Object.freeze(next);
      state = 'ready';
      error = null;
      return { ok: true };
    },
  };
}
