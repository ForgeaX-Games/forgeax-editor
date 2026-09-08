import {
  RENDERER_OWNER_ADMISSION_IDENTITY_FIELDS,
  type RendererOwnerAdmissionIdentity,
  type RendererOwnerAdmissionRequest,
  validateRendererOwnerAdmissionRequest,
} from '@forgeax/editor-product';

export type RendererOwnerAdmissionRestoreReason =
  | 'finally'
  | 'stop'
  | 'unmount'
  | 'dispose'
  | 'generation-change';

export interface RendererOwnerAdmissionLeaseError {
  readonly code: string;
  readonly category: 'precondition' | 'state' | 'adapter';
  readonly expected: unknown;
  readonly observed: unknown;
  readonly hint: string;
  readonly recoveryActions: readonly ['renderer.ownerAdmission.rediscover'];
  readonly safeRerun: true;
}

export interface RendererOwnerAdmissionLeaseDeps {
  readonly identity: RendererOwnerAdmissionIdentity;
  readRendererGeneration(): string;
  apply(input: RendererOwnerAdmissionRequest): void;
  restore(): void;
}

export interface RendererOwnerAdmissionLease {
  applyAtFrameBoundary(
    input: RendererOwnerAdmissionRequest,
  ):
    | { readonly ok: true }
    | { readonly ok: false; readonly error: RendererOwnerAdmissionLeaseError };
  restoreOnce(reason: RendererOwnerAdmissionRestoreReason): void;
  clearForDispose(): void;
  clearForGeneration(identity?: RendererOwnerAdmissionIdentity): void;
}

const recoveryActions = ['renderer.ownerAdmission.rediscover'] as const;

function sameIdentity(
  left: RendererOwnerAdmissionIdentity,
  right: RendererOwnerAdmissionIdentity,
): boolean {
  return RENDERER_OWNER_ADMISSION_IDENTITY_FIELDS.every(
    (field) => left[field] === right[field],
  );
}

function failure(
  code: string,
  category: RendererOwnerAdmissionLeaseError['category'],
  expected: unknown,
  observed: unknown,
  hint: string,
): { readonly ok: false; readonly error: RendererOwnerAdmissionLeaseError } {
  const result: { ok: false; error?: RendererOwnerAdmissionLeaseError } = {
    ok: false,
  };
  Object.defineProperty(result, 'error', {
    value: {
      code,
      category,
      expected,
      observed,
      hint,
      recoveryActions,
      safeRerun: true,
    },
    enumerable: false,
  });
  return result as {
    readonly ok: false;
    readonly error: RendererOwnerAdmissionLeaseError;
  };
}

function generationFailure(
  expected: string,
  observed: string,
): { readonly ok: false; readonly error: RendererOwnerAdmissionLeaseError } {
  return failure(
    'renderer-owner-admission-generation-mismatch',
    'precondition',
    { rendererGeneration: expected },
    { rendererGeneration: observed },
    'The renderer generation changed; rediscover the owner on the current carrier before retrying.',
  );
}

function readGeneration(
  deps: RendererOwnerAdmissionLeaseDeps,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: RendererOwnerAdmissionLeaseError } {
  try {
    const generation = deps.readRendererGeneration();
    if (typeof generation === 'string' && generation.trim() !== '')
      return { ok: true, value: generation };
    return failure(
      'renderer-owner-admission-generation-unavailable',
      'precondition',
      { rendererGeneration: 'non-empty string' },
      { rendererGeneration: generation },
      'The renderer generation is unavailable; rediscover the current renderer owner.',
    );
  } catch (error) {
    return failure(
      'renderer-owner-admission-generation-unavailable',
      'adapter',
      { rendererGeneration: 'readable' },
      { error: error instanceof Error ? error.message : String(error) },
      'The renderer owner adapter could not read its generation; rediscover the current renderer owner.',
    );
  }
}

function sameRequest(
  left: RendererOwnerAdmissionRequest,
  right: RendererOwnerAdmissionRequest,
): boolean {
  return (
    left.shadowSubmitMode === right.shadowSubmitMode &&
    sameIdentity(left.identity, right.identity)
  );
}

export function createRendererOwnerAdmissionLease(
  deps: RendererOwnerAdmissionLeaseDeps,
): RendererOwnerAdmissionLease {
  let expectedIdentity = { ...deps.identity };
  let appliedRequest: RendererOwnerAdmissionRequest | null = null;
  let applyAttempted = false;
  let restored = false;
  let disposed = false;

  function resetForGeneration(identity: RendererOwnerAdmissionIdentity): void {
    expectedIdentity = { ...identity };
    appliedRequest = null;
    applyAttempted = false;
    restored = false;
    disposed = false;
  }

  function restoreOnce(reason: RendererOwnerAdmissionRestoreReason): void {
    if (!applyAttempted || restored) return;
    restored = true;
    try {
      deps.restore();
    } catch (error) {
      console.warn(
        `[editor] renderer owner admission restore (${reason}) failed:`,
        error,
      );
    }
  }

  return {
    applyAtFrameBoundary(input) {
      if (disposed) {
        return failure(
          'renderer-owner-admission-disposed',
          'state',
          { disposed: false },
          { disposed: true },
          'The renderer owner lease was disposed; rediscover the capability on the current carrier.',
        );
      }
      const validated = validateRendererOwnerAdmissionRequest(input);
      if (!validated.ok) {
        return failure(
          validated.error.code,
          'precondition',
          validated.error.expected,
          validated.error.observed,
          validated.error.hint,
        );
      }
      const request = validated.value;
      if (!sameIdentity(request.identity, expectedIdentity)) {
        return failure(
          'renderer-owner-admission-identity-mismatch',
          'precondition',
          expectedIdentity,
          request.identity,
          'The request belongs to another carrier or browser realm; rediscover the renderer owner.',
        );
      }
      const currentGeneration = readGeneration(deps);
      if (!currentGeneration.ok) return currentGeneration;
      if (currentGeneration.value !== expectedIdentity.rendererGeneration) {
        return generationFailure(
          expectedIdentity.rendererGeneration,
          currentGeneration.value,
        );
      }
      if (applyAttempted) {
        if (
          appliedRequest !== null &&
          sameRequest(appliedRequest, request) &&
          !restored
        )
          return { ok: true };
        return failure(
          'renderer-owner-admission-mode-already-applied',
          'state',
          appliedRequest,
          request,
          'One renderer owner admission is already bound to this lifecycle; restore it before a different request.',
        );
      }
      applyAttempted = true;
      appliedRequest = request;
      try {
        deps.apply(request);
        return { ok: true };
      } catch (error) {
        return failure(
          'renderer-owner-admission-apply-failed',
          'adapter',
          { applied: true },
          { error: error instanceof Error ? error.message : String(error) },
          'The renderer owner adapter rejected the frame-boundary apply; restore the lease and rediscover before retrying.',
        );
      }
    },
    restoreOnce,
    clearForDispose() {
      restoreOnce('dispose');
      disposed = true;
      appliedRequest = null;
      applyAttempted = false;
    },
    clearForGeneration(identity) {
      restoreOnce('generation-change');
      if (identity !== undefined) {
        resetForGeneration(identity);
        return;
      }
      const generation = readGeneration(deps);
      if (generation.ok) {
        resetForGeneration({
          ...expectedIdentity,
          rendererGeneration: generation.value,
        });
      } else {
        appliedRequest = null;
        applyAttempted = false;
        restored = false;
      }
    },
  };
}

let activeRendererOwnerAdmissionLease: RendererOwnerAdmissionLease | undefined;

export function installRendererOwnerAdmissionLease(
  lease: RendererOwnerAdmissionLease,
): () => void {
  const previous = activeRendererOwnerAdmissionLease;
  if (previous !== undefined && previous !== lease) previous.clearForDispose();
  activeRendererOwnerAdmissionLease = lease;
  return () => {
    if (activeRendererOwnerAdmissionLease !== lease) return;
    lease.clearForDispose();
    activeRendererOwnerAdmissionLease = undefined;
  };
}

export function getRendererOwnerAdmissionLease():
  | RendererOwnerAdmissionLease
  | undefined {
  return activeRendererOwnerAdmissionLease;
}
