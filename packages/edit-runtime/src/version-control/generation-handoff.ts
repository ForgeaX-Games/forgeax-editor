export interface SwitchReceipt {
  readonly requestId?: string;
  readonly targetTag: string;
  readonly targetCommit: string;
  readonly repositoryIdentity: string;
  readonly detached: boolean;
  readonly filesVerified: boolean;
}

export type GenerationHandoffState = 'ready' | 'barrier' | 'tearing-down' | 'cold-starting' | 'frozen';

export interface RuntimeSuccessor {
  readonly generation: number;
  readonly projectionLease: string;
  readonly actionLease: string;
  readonly repositoryIdentity: string;
  readonly targetCommit: string;
}

export interface GenerationHandoffSnapshot {
  readonly generation: number;
  readonly state: GenerationHandoffState;
  readonly projectionLease: string | null;
  readonly actionLease: string | null;
  readonly runOwner: string | null;
  readonly repositoryIdentity: string | null;
  readonly targetCommit: string | null;
}

export interface GenerationHandoffSuccess {
  readonly status: 'succeeded';
  readonly requestId: string;
  readonly generation: number;
  readonly receipt: SwitchReceipt;
}

export interface GenerationHandoffFailure {
  readonly status: 'failed';
  readonly requestId: string;
  readonly generation: number;
  readonly receipt: SwitchReceipt;
  readonly error: { readonly code: string; readonly hint: string; readonly recoveryActions: readonly string[] };
}

export type GenerationHandoffResult = GenerationHandoffSuccess | GenerationHandoffFailure;

export interface GenerationHandoffOptions {
  readonly initialGeneration: number;
  readonly initialProjectionLease: string;
  readonly initialActionLease: string;
  readonly initialRepositoryIdentity?: string;
}

export interface GenerationHandoffBeginInput {
  readonly requestId: string;
  readonly receipt: SwitchReceipt;
  readonly teardown: () => void | Promise<void>;
  readonly bootSuccessor: (generation: number) => RuntimeSuccessor | Promise<RuntimeSuccessor>;
  readonly terminal: (status: 'succeeded' | 'failed', result: GenerationHandoffResult) => void;
  readonly disposeOld?: () => void | Promise<void>;
}

export interface GenerationHandoffAdoptInput {
  readonly requestId: string;
  readonly receipt: SwitchReceipt;
  readonly successor: RuntimeSuccessor;
}

function validGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function failureResult(requestId: string, receipt: SwitchReceipt, generation: number, error: GenerationHandoffFailure['error']): GenerationHandoffFailure {
  return { status: 'failed', requestId, generation, receipt, error };
}

function validateSuccessor(receipt: SwitchReceipt, successor: RuntimeSuccessor, generation: number): string | null {
  if (successor.generation !== generation) return 'successor generation does not match the handoff';
  if (successor.repositoryIdentity !== receipt.repositoryIdentity) return 'successor repository identity does not match the receipt';
  if (successor.targetCommit !== receipt.targetCommit) return 'successor target commit does not match the receipt';
  if (successor.projectionLease.length === 0 || successor.actionLease.length === 0) return 'successor leases must be non-empty';
  return null;
}

/**
 * Coordinates one switch across a Runtime boundary. The old lease stays the
 * only writable lease until the successor reports cold-ready; the old run is
 * terminal only after both leases have been swapped.
 */
export function createRuntimeGenerationHandoff(options: GenerationHandoffOptions): RuntimeGenerationHandoff {
  if (!validGeneration(options.initialGeneration)) throw new Error('initial generation must be positive');
  let current: GenerationHandoffSnapshot = Object.freeze({
    generation: options.initialGeneration,
    state: 'ready',
    projectionLease: options.initialProjectionLease,
    actionLease: options.initialActionLease,
    runOwner: null,
    repositoryIdentity: options.initialRepositoryIdentity ?? null,
    targetCommit: null,
  });
  let activeRequest: string | null = null;
  const publish = (next: GenerationHandoffSnapshot): void => { current = Object.freeze(next); };
  const snapshot = (): GenerationHandoffSnapshot => current;

  const commitSuccessor = (requestId: string, receipt: SwitchReceipt, successor: RuntimeSuccessor): GenerationHandoffSuccess | GenerationHandoffFailure => {
    const mismatch = validateSuccessor(receipt, successor, current.generation + 1);
    if (mismatch !== null) {
      return failureResult(requestId, receipt, current.generation, {
        code: 'version-control-generation-not-ready',
        hint: mismatch,
        recoveryActions: ['version-control.refresh', 'run.retry'],
      });
    }
    publish({
      generation: successor.generation,
      state: 'ready',
      projectionLease: successor.projectionLease,
      actionLease: successor.actionLease,
      runOwner: null,
      repositoryIdentity: successor.repositoryIdentity,
      targetCommit: successor.targetCommit,
    });
    activeRequest = null;
    return { status: 'succeeded', requestId, generation: successor.generation, receipt };
  };

  const begin = (input: GenerationHandoffBeginInput): Promise<GenerationHandoffResult> => {
    if (activeRequest !== null) {
      const result = failureResult(input.requestId, input.receipt, current.generation, {
        code: 'version-control-transition-active',
        hint: 'Another Runtime generation transition is already active.',
        recoveryActions: ['run.wait'],
      });
      return Promise.resolve(result);
    }
    activeRequest = input.requestId;
    publish({ ...current, state: 'barrier', runOwner: input.requestId, targetCommit: input.receipt.targetCommit });
    return (async (): Promise<GenerationHandoffResult> => {
      try {
        await Promise.resolve();
        publish({ ...current, state: 'tearing-down' });
        await input.teardown();
        publish({ ...current, state: 'cold-starting' });
        const successor = await input.bootSuccessor(current.generation + 1);
        const result = commitSuccessor(input.requestId, input.receipt, successor);
        if (result.status === 'succeeded') {
          input.terminal('succeeded', result);
          await input.disposeOld?.();
        } else {
          publish({ ...current, state: 'frozen', runOwner: input.requestId });
          activeRequest = null;
          input.terminal('failed', result);
        }
        return result;
      } catch (cause) {
        const result = failureResult(input.requestId, input.receipt, current.generation, {
          code: 'version-control-generation-handoff-failed',
          hint: cause instanceof Error ? cause.message : 'The successor Runtime did not become ready.',
          recoveryActions: ['version-control.refresh', 'run.retry'],
        });
        publish({ ...current, state: 'frozen', runOwner: input.requestId });
        activeRequest = null;
        input.terminal('failed', result);
        return result;
      }
    })();
  };

  const adopt = async (input: GenerationHandoffAdoptInput): Promise<GenerationHandoffResult> => {
    if (activeRequest !== null && activeRequest !== input.requestId) {
      return failureResult(input.requestId, input.receipt, current.generation, {
        code: 'version-control-transition-active', hint: 'A different transition owns the Runtime handoff.', recoveryActions: ['run.wait'],
      });
    }
    activeRequest = input.requestId;
    publish({ ...current, state: 'cold-starting', runOwner: input.requestId });
    const result = commitSuccessor(input.requestId, input.receipt, input.successor);
    if (result.status === 'failed') publish({ ...current, state: 'frozen', runOwner: input.requestId });
    return result;
  };

  const freeze = (_reason: string): void => {
    activeRequest = null;
    publish({ ...current, state: 'frozen', runOwner: null });
  };

  const reconcile = (repositoryIdentity: string, targetCommit: string | null): boolean => {
    if (current.state !== 'frozen' || repositoryIdentity.length === 0) return false;
    publish({ ...current, state: 'ready', repositoryIdentity, targetCommit, runOwner: null });
    return true;
  };

  return Object.freeze({ snapshot, begin, adopt, freeze, reconcile });
}

export interface RuntimeGenerationHandoff {
  readonly snapshot: () => GenerationHandoffSnapshot;
  readonly begin: (input: GenerationHandoffBeginInput) => Promise<GenerationHandoffResult>;
  readonly adopt: (input: GenerationHandoffAdoptInput) => Promise<GenerationHandoffResult>;
  readonly freeze: (reason: string) => void;
  readonly reconcile: (repositoryIdentity: string, targetCommit: string | null) => boolean;
}
