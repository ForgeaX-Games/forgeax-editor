import {
  createRuntimeGenerationHandoff,
  type GenerationHandoffResult,
  type RuntimeGenerationHandoff,
  type RuntimeSuccessor,
  type SwitchReceipt,
} from './generation-handoff';
import type { GatewayWriteBarrier } from '@forgeax/editor-core';

export type { SwitchReceipt } from './generation-handoff';

export interface SwitchPreflightInput {
  readonly playActive: boolean;
  readonly stagingActive: boolean;
  readonly dirty: boolean;
  readonly untracked: boolean;
  readonly targetDrifted: boolean;
  readonly writeOperationActive: boolean;
  readonly rootMatches: boolean;
  readonly repositoryRecoveryRequired: boolean;
  readonly generation: number;
}

export interface SwitchSideEffects {
  readonly checkout: boolean;
  readonly deleteFiles: boolean;
  readonly moveRefs: boolean;
  readonly writeGeneration: boolean;
}

export interface SwitchPreflightError {
  readonly code: string;
  readonly hint: string;
  readonly recoveryActions: readonly string[];
}

export type SwitchPreflightResult =
  | { readonly ok: true; readonly generation: number; readonly transitionId: string; readonly sideEffects: SwitchSideEffects }
  | { readonly ok: false; readonly generation: number; readonly error: SwitchPreflightError; readonly sideEffects: SwitchSideEffects };

const noSideEffects: SwitchSideEffects = Object.freeze({
  checkout: false,
  deleteFiles: false,
  moveRefs: false,
  writeGeneration: false,
});

const preflightFailure = (input: SwitchPreflightInput, code: string, hint: string): SwitchPreflightResult => ({
  ok: false,
  generation: input.generation,
  error: { code, hint, recoveryActions: ['version-control.refresh', 'run.wait'] },
  sideEffects: noSideEffects,
});

/** Pure guard owned by edit-runtime; platform-io only reports repository facts. */
export function evaluateSwitchPreflight(input: SwitchPreflightInput): SwitchPreflightResult {
  if (input.playActive) return preflightFailure(input, 'version-control-play-active', 'Stop Play before switching the game version.');
  if (input.stagingActive) return preflightFailure(input, 'version-control-staging-active', 'Wait for Editor staging to finish before switching.');
  if (input.dirty || input.untracked) return preflightFailure(input, 'version-control-worktree-dirty', 'Publish or discard repository changes before switching.');
  if (input.targetDrifted) return preflightFailure(input, 'version-control-target-stale', 'Refresh the version graph because the target changed.');
  if (input.writeOperationActive) return preflightFailure(input, 'version-control-operation-busy', 'Wait for the current Gateway operation to finish.');
  if (!input.rootMatches) return preflightFailure(input, 'version-control-root-mismatch', 'The current game root no longer matches the Host authority.');
  if (input.repositoryRecoveryRequired) return preflightFailure(input, 'version-control-recovery-required', 'Inspect and reconcile the repository before switching.');
  return {
    ok: true,
    generation: input.generation,
    transitionId: `switch-transition-${input.generation}-${Math.random().toString(36).slice(2, 10)}`,
    sideEffects: noSideEffects,
  };
}

export interface SwitchCheckoutFailure {
  readonly ok: false;
  readonly error: SwitchPreflightError & { readonly code: string };
}

export interface SwitchCheckoutSuccess {
  readonly ok: true;
  readonly receipt: SwitchReceipt;
}

export interface SwitchApplierOptions {
  readonly readPreflight: () => SwitchPreflightInput | Promise<SwitchPreflightInput>;
  readonly checkout: (input: unknown) => SwitchCheckoutSuccess | SwitchCheckoutFailure | Promise<SwitchCheckoutSuccess | SwitchCheckoutFailure>;
  readonly handoff: RuntimeGenerationHandoff;
  readonly teardown: () => void | Promise<void>;
  readonly bootSuccessor: (generation: number) => RuntimeSuccessor | Promise<RuntimeSuccessor>;
  readonly terminal: (status: 'succeeded' | 'failed', result: GenerationHandoffResult) => void;
  readonly disposeOld?: () => void | Promise<void>;
  readonly freeze?: (reason: string) => void;
}

/**
 * Applies the runtime half of switchGameVersion. Checkout remains a Host fact;
 * this function owns barrier ordering and never runs Git itself.
 */
export async function applySwitchGameVersion(
  options: SwitchApplierOptions,
  input: unknown,
): Promise<SwitchPreflightResult | GenerationHandoffResult | SwitchCheckoutFailure> {
  const preflight = evaluateSwitchPreflight(await options.readPreflight());
  if (!preflight.ok) return preflight;
  const checked = await options.checkout(input);
  if (!checked.ok) {
    if (checked.error.code === 'version-control-recovery-required' || checked.error.code === 'version-control-external-inspection-required') {
      options.freeze?.(checked.error.hint);
    }
    return checked;
  }
  return options.handoff.begin({
    requestId: checked.receipt.requestId ?? preflight.transitionId,
    receipt: checked.receipt,
    teardown: options.teardown,
    bootSuccessor: options.bootSuccessor,
    terminal: options.terminal,
    disposeOld: options.disposeOld,
  });
}

export function createSwitchHandoff(options: {
  readonly generation: number;
  readonly projectionLease: string;
  readonly actionLease: string;
  readonly repositoryIdentity?: string;
}): RuntimeGenerationHandoff {
  return createRuntimeGenerationHandoff({
    initialGeneration: options.generation,
    initialProjectionLease: options.projectionLease,
    initialActionLease: options.actionLease,
    initialRepositoryIdentity: options.repositoryIdentity,
  });
}

/** Binds the switch protocol to the shared Gateway transition barrier. */
export async function applySwitchWithGatewayBarrier(
  barrier: GatewayWriteBarrier,
  options: SwitchApplierOptions,
  input: unknown,
): Promise<SwitchPreflightResult | GenerationHandoffResult | SwitchCheckoutFailure> {
  const before = barrier.snapshot();
  if (before.phase !== 'open') {
    return {
      ok: false,
      generation: (await options.readPreflight()).generation,
      error: {
        code: before.phase === 'frozen' ? 'version-control-external-inspection-required' : 'version-control-transition-active',
        hint: before.frozenReason ?? 'The Gateway is not open for a Runtime transition.',
        recoveryActions: ['version-control.refresh', 'run.wait'],
      },
      sideEffects: noSideEffects,
    };
  }
  barrier.beginTransition();
  try {
    const result = await applySwitchGameVersion({
      ...options,
      freeze: (reason) => {
        options.freeze?.(reason);
        barrier.freeze(reason);
      },
    }, input);
    if ('status' in result && result.status === 'failed') {
      barrier.freeze(result.error.hint);
    }
    return result;
  } finally {
    if (barrier.snapshot().phase === 'transition') barrier.endTransition();
  }
}
