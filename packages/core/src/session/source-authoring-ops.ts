// Source authoring session operations. The module owns orchestration only;
// Catalog, Meta, producer rebuild, and publication observation remain injected
// seams so the same Gateway operation is usable by UI and AI callers.

import {
  authorizeAssetSourceMutation,
  type AssetSourceMutationIntent,
} from '@forgeax/editor-product';
import {
  createSourceMutationPreflightCoordinator,
  readAssetSourceFact,
  type SourceMutationPreflightInput,
  type SourceMutationPreflightCommand,
} from '../assets/source-mutation-preflight';
import { assetIO } from '../io/asset-io-facade';
import { registerSessionApplier, registerTransientApplier, type SessionApplier, type SessionApplierCtx } from '../io/appliers';
import { awaitPostAssetWriteCatalogSync } from './pack-ops';
import type { CommandError, EditorOp, SourceAuthoringPhase, SourceAuthoringSubjectRef } from '../types';

export interface SourceAuthoringRuntime {
  readonly getPreflightInput: (op: EditorOp) => SourceMutationPreflightInput | Promise<SourceMutationPreflightInput>;
  readonly metaPath: (op: EditorOp) => string;
  readonly commitSourceOverrides?: (input: {
    readonly op: EditorOp;
    readonly discard: boolean;
    readonly scope: SourceMutationPreflightCommand['scope'];
    readonly override?: unknown;
  }) => Promise<unknown>;
  readonly rebuild: (input: { readonly op: EditorOp; readonly signal: AbortSignal }) => Promise<unknown>;
  readonly observePublication?: (input: { readonly op: EditorOp; readonly signal: AbortSignal }) => Promise<unknown>;
}

export interface SourceRecoveryState {
  readonly metaRevision: string;
  readonly currentRevision: string;
  readonly lastKnownGoodRevision: string;
  readonly terminal: 'succeeded' | 'failed';
  readonly errorCode?: string;
}

export type SourceRecoveryEvent =
  | { readonly type: 'reimport-failed'; readonly metaRevision: string; readonly errorCode: string }
  | { readonly type: 'reimport-succeeded'; readonly metaRevision: string; readonly revision: string };

export function reduceSourceRecoveryState(state: SourceRecoveryState, event: SourceRecoveryEvent): SourceRecoveryState {
  if (event.type === 'reimport-failed') {
    return { ...state, metaRevision: event.metaRevision, terminal: 'failed', errorCode: event.errorCode };
  }
  return {
    metaRevision: event.metaRevision,
    currentRevision: event.revision,
    lastKnownGoodRevision: event.revision,
    terminal: 'succeeded',
  };
}

export interface SourceLkgState {
  readonly current: string;
  readonly lastKnownGood: string;
  readonly phase: 'current' | 'rebuilding' | 'failed';
  readonly errorCode?: string;
}

export type SourceLkgEvent =
  | { readonly type: 'rebuild-started'; readonly candidate: string }
  | { readonly type: 'rebuild-failed'; readonly errorCode: string }
  | { readonly type: 'published'; readonly candidate: string };

export function reduceSourceLkgState(state: SourceLkgState, event: SourceLkgEvent): SourceLkgState {
  if (event.type === 'rebuild-started') return { ...state, phase: 'rebuilding' };
  if (event.type === 'rebuild-failed') return { ...state, phase: 'failed', errorCode: event.errorCode };
  return { current: event.candidate, lastKnownGood: event.candidate, phase: 'current' };
}

type SourceOperation = {
  readonly kind: string;
  readonly guid: string;
  readonly operationId?: string;
  readonly scope: SourceMutationPreflightCommand['scope'];
  readonly expectedRevision: string;
  readonly requestId: string;
  readonly confirmationToken?: string;
  readonly override?: unknown;
};

function intentFor(kind: string): AssetSourceMutationIntent {
  if (kind === 'discardSourceOverridesAndReimport') return 'discard-source-overrides-and-reimport';
  if (kind === 'previewAssetSourceMutation' || kind === 'reimportAsset') return 'reimport-asset';
  return 'save-asset-source-override';
}

function commandFor(op: SourceOperation): SourceMutationPreflightCommand {
  return {
    operationId: op.operationId ?? op.kind,
    requestId: op.requestId,
    guid: op.guid,
    scope: op.scope,
    expectedRevision: op.expectedRevision,
    intent: intentFor(op.kind),
  };
}

type SourceErrorInput = {
  readonly code?: unknown;
  readonly hint?: unknown;
  readonly message?: unknown;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly current?: unknown;
  readonly currentRevision?: unknown;
  readonly recoveryActions?: unknown;
  readonly retryable?: unknown;
  readonly missingGuids?: unknown;
};

function sourceSubject(op: SourceOperation): SourceAuthoringSubjectRef {
  const scope = op.scope as { readonly all?: unknown; readonly sourceKey?: unknown } | undefined;
  const sourceKey = typeof scope?.sourceKey === 'string' ? scope.sourceKey : '';
  return {
    kind: 'asset-source',
    id: op.guid,
    guid: op.guid,
    ...(scope?.all === true || sourceKey === '' ? {} : { sourceKey }),
  };
}

function errorInput(error: unknown): SourceErrorInput {
  if (error !== null && typeof error === 'object') return error as SourceErrorInput;
  return {};
}

const stableSourceErrorCodes = new Set<CommandError['code']>([
  'INVALID_ARGS',
  'asset-source-key-missing',
  'asset-source-key-unknown',
  'asset-source-key-ambiguous',
  'asset-meta-revision-conflict',
  'asset-confirmation-required',
  'asset-confirmation-expired',
  'asset-confirmation-mismatch',
  'asset-validation-failed',
  'asset-cook-failed',
  'asset-publish-observation-timeout',
  'asset-catalog-subscription-gap',
  'asset-operation-cas-committed',
  'run-cancelled-before-cas',
]);

function isStableSourceErrorCode(value: unknown): value is CommandError['code'] {
  return typeof value === 'string' && stableSourceErrorCodes.has(value as CommandError['code']);
}

function sourceCode(input: SourceErrorInput, phase: SourceAuthoringPhase): CommandError['code'] {
  if (input.code === 'asset-resource-conflict') return 'asset-meta-revision-conflict';
  if (input.code === 'asset-source-impact-incomplete') return 'asset-catalog-subscription-gap';
  if (isStableSourceErrorCode(input.code)) return input.code;
  if (phase === 'cas') return 'asset-meta-revision-conflict';
  if (phase === 'cook') return 'asset-cook-failed';
  if (phase === 'validation') return 'asset-validation-failed';
  if (phase === 'publication') return 'asset-publish-observation-timeout';
  if (phase === 'gap') return 'asset-catalog-subscription-gap';
  return 'INVALID_ARGS';
}

function sourcePhase(code: CommandError['code'], fallback: SourceAuthoringPhase): SourceAuthoringPhase {
  if (code === 'asset-source-key-missing' || code === 'asset-source-key-unknown' || code === 'asset-source-key-ambiguous'
    || code === 'asset-confirmation-required' || code === 'asset-confirmation-expired' || code === 'asset-confirmation-mismatch'
    || code === 'INVALID_ARGS') return 'entry';
  if (code === 'asset-meta-revision-conflict' || code === 'asset-operation-cas-committed' || code === 'run-cancelled-before-cas') return 'cas';
  if (code === 'asset-cook-failed') return 'cook';
  if (code === 'asset-validation-failed') return 'validation';
  if (code === 'asset-publish-observation-timeout') return 'publication';
  if (code === 'asset-catalog-subscription-gap') return 'gap';
  return fallback;
}

function recoveryFor(code: CommandError['code'], input: SourceErrorInput): readonly string[] {
  if (code === 'asset-catalog-subscription-gap') return ['catalog.reconcile'];
  if (code === 'asset-source-key-missing' || code === 'asset-source-key-unknown' || code === 'asset-source-key-ambiguous'
    || code === 'asset-confirmation-required' || code === 'asset-confirmation-expired' || code === 'asset-confirmation-mismatch') {
    return ['asset.preflight'];
  }
  if (code === 'asset-meta-revision-conflict') return ['run.retry', 'asset.preflight'];
  if (code === 'asset-operation-cas-committed') return ['run.wait', 'run.retry'];
  if (code === 'run-cancelled-before-cas') return ['run.get'];
  if (code === 'asset-cook-failed' || code === 'asset-validation-failed' || code === 'asset-publish-observation-timeout') {
    return ['run.retry', 'catalog.reconcile'];
  }
  return Array.isArray(input.recoveryActions) ? input.recoveryActions.filter((value): value is string => typeof value === 'string') : [];
}

/** Normalize every source-operation boundary into the existing Core CommandError contract. */
function normalizeSourceAuthoringError(
  error: unknown,
  op: SourceOperation,
  fallbackPhase: SourceAuthoringPhase,
): CommandError {
  const input = errorInput(error);
  const code = sourceCode(input, fallbackPhase);
  const phase = sourcePhase(code, fallbackPhase);
  const expected = input.expected !== undefined
    ? input.expected
    : input.currentRevision !== undefined || input.code === 'asset-resource-conflict'
      ? op.expectedRevision
      : undefined;
  const actual = input.actual !== undefined
    ? input.actual
    : input.currentRevision !== undefined ? input.currentRevision : input.current;
  const hint = typeof input.hint === 'string'
    ? input.hint
    : typeof input.message === 'string' ? input.message
      : error instanceof Error ? error.message : `Source operation failed during ${phase}.`;
  const details = Array.isArray(input.missingGuids)
    ? { missingGuids: input.missingGuids.filter((value): value is string => typeof value === 'string') }
    : undefined;
  return {
    code,
    phase,
    operationId: op.operationId ?? op.kind,
    requestId: op.requestId,
    subjectRef: sourceSubject(op),
    hint,
    expected,
    actual,
    ...(details === undefined ? {} : { details }),
    retryable: code === 'asset-catalog-subscription-gap' || code === 'run-cancelled-before-cas'
      ? false
      : typeof input.retryable === 'boolean' ? input.retryable : true,
    recoveryActions: recoveryFor(code, input),
  };
}

function failure(error: CommandError): { ok: false; error: CommandError } {
  return { ok: false, error };
}

type SourceEffectResult = { readonly ok: true } | { readonly ok: false; readonly error: CommandError };

async function commitSourceOperation(
  rawOp: EditorOp,
  op: SourceOperation,
  runtime: SourceAuthoringRuntime,
  kind: string,
): Promise<SourceEffectResult> {
  if (kind === 'reimportAsset') return { ok: true };
  const commit = runtime.commitSourceOverrides === undefined
    ? assetIO.commitSourceOverrides({
      metaPath: runtime.metaPath(rawOp),
      expectedRevision: op.expectedRevision,
      scope: op.scope,
      override: op.override,
      discard: kind === 'discardSourceOverridesAndReimport',
    })
    : runtime.commitSourceOverrides({
      op: rawOp,
      discard: kind === 'discardSourceOverridesAndReimport',
      scope: op.scope,
      override: op.override,
    });
  try {
    await commit;
    return { ok: true };
  } catch (error) {
    return failure(normalizeSourceAuthoringError(error, op, 'cas'));
  }
}

async function rebuildSourceOperation(
  rawOp: EditorOp,
  op: SourceOperation,
  runtime: SourceAuthoringRuntime,
  signal: AbortSignal,
): Promise<SourceEffectResult> {
  try {
    await runtime.rebuild({ op: rawOp, signal });
    return { ok: true };
  } catch (error) {
    const phase = errorInput(error).code === 'asset-validation-failed' ? 'validation' : 'cook';
    return failure(normalizeSourceAuthoringError(error, op, phase));
  }
}

async function observeSourceOperation(
  op: SourceOperation,
  runtime: SourceAuthoringRuntime,
  signal: AbortSignal,
): Promise<SourceEffectResult> {
  try {
    if (runtime.observePublication !== undefined) {
      await runtime.observePublication({ op: op as EditorOp, signal });
    } else {
      await awaitPostAssetWriteCatalogSync(op.guid);
    }
    return { ok: true };
  } catch (error) {
    const phase = errorInput(error).code === 'asset-catalog-subscription-gap' ? 'gap' : 'publication';
    return failure(normalizeSourceAuthoringError(error, op, phase));
  }
}

function runSourceOperation(
  rawOp: EditorOp,
  ctx: SessionApplierCtx | undefined,
  runtime: SourceAuthoringRuntime,
  kind: string,
): { ok: true; completion: Promise<unknown> } | { ok: false; error: CommandError } {
  const op = rawOp as SourceOperation;
  if (typeof op.guid !== 'string' || op.guid.trim() === '') {
    return failure(normalizeSourceAuthoringError({ code: 'INVALID_ARGS', hint: `${kind}.guid must be a non-empty imported output GUID` }, {
      ...op,
      guid: typeof op.guid === 'string' ? op.guid : '',
      requestId: typeof op.requestId === 'string' ? op.requestId : `${kind}-invalid`,
    }, 'entry'));
  }
  if (typeof op.requestId !== 'string' || op.requestId.trim() === '') {
    return failure({ code: 'INVALID_ARGS', hint: `${kind}.requestId must be a non-empty caller-minted id` });
  }
  if (typeof op.expectedRevision !== 'string' || op.expectedRevision.trim() === '') {
    return failure({ code: 'INVALID_ARGS', hint: `${kind}.expectedRevision must be a non-empty Meta revision` });
  }
  const cancellation = new AbortController();
  let casCommitted = false;
  ctx?.operationRun?.registerCancelHandler?.(() => {
    if (casCommitted) {
      return failure({
        code: 'asset-operation-cas-committed',
        hint: 'The Meta CAS already committed; recover the same run instead of cancelling.',
        retryable: true,
        recoveryActions: ['run.wait', 'run.retry'],
      });
    }
    cancellation.abort();
    return { ok: true as const };
  });

  const completion = (async () => {
    const command = commandFor(op);
    const input = await runtime.getPreflightInput(rawOp);
    const preflight = createSourceMutationPreflightCoordinator(input).preflight(command);
    if (!preflight.ok) return failure(normalizeSourceAuthoringError(preflight.error, op, 'entry'));
    if (kind === 'previewAssetSourceMutation') return { ok: true as const, result: preflight.preflight };
    if (cancellation.signal.aborted) {
      return failure({
        code: 'run-cancelled-before-cas',
        hint: 'The source mutation was cancelled before the Meta CAS boundary.',
        retryable: false,
        recoveryActions: ['run.get'],
      });
    }
    if (kind === 'discardSourceOverridesAndReimport') {
      const authorized = authorizeAssetSourceMutation(preflight.preflight, {
        intent: 'discard-source-overrides-and-reimport',
        confirmationToken: op.confirmationToken,
      });
      if (!authorized.ok) return failure(authorized.error);
    }
    const committed = await commitSourceOperation(rawOp, op, runtime, kind);
    if (!committed.ok) return committed;
    if (kind !== 'reimportAsset') {
      casCommitted = true;
    }
    const rebuilt = await rebuildSourceOperation(rawOp, op, runtime, cancellation.signal);
    if (!rebuilt.ok) return rebuilt;
    const observed = await observeSourceOperation(op, runtime, cancellation.signal);
    if (!observed.ok) return observed;
    return { ok: true as const, result: { guid: op.guid, requestId: op.requestId } };
  })().catch((error: unknown) => failure(normalizeSourceAuthoringError(error, op, 'cook')));
  return { ok: true, completion };
}

function runSourcePreflight(
  rawOp: EditorOp,
  runtime: SourceAuthoringRuntime,
): { ok: true; completion: Promise<unknown> } | { ok: false; error: CommandError } {
  const inputOp = rawOp as {
    readonly kind: 'asset.preflight';
    readonly guid?: unknown;
    readonly scope?: unknown;
    readonly requestId?: unknown;
  };
  if (typeof inputOp.guid !== 'string' || inputOp.guid.trim() === '') {
    return failure({ code: 'INVALID_ARGS', hint: 'asset.preflight.guid must be a non-empty imported output GUID' });
  }
  if (typeof inputOp.requestId !== 'string' || inputOp.requestId.trim() === '') {
    return failure({ code: 'INVALID_ARGS', hint: 'asset.preflight.requestId must be a non-empty caller-minted id' });
  }
  const completion = (async () => {
    const input = await runtime.getPreflightInput(rawOp);
    const source = readAssetSourceFact(input.meta);
    const op: SourceOperation = {
      kind: inputOp.kind,
      guid: inputOp.guid as string,
      scope: inputOp.scope as SourceMutationPreflightCommand['scope'],
      expectedRevision: source.expectedRevision,
      requestId: inputOp.requestId as string,
    };
    const preflight = createSourceMutationPreflightCoordinator(input).preflight({
      ...commandFor(op),
      intent: 'discard-source-overrides-and-reimport',
    });
    if (!preflight.ok) return failure(normalizeSourceAuthoringError(preflight.error, op, 'entry'));
    return { ok: true as const, result: { source, impact: preflight.preflight } };
  })().catch((error: unknown) => failure({
    code: 'INVALID_ARGS',
    hint: error instanceof Error ? error.message : 'Asset source preflight failed.',
    retryable: false,
    recoveryActions: ['catalog.reconcile'],
  }));
  return { ok: true, completion };
}

/** Register all three source-authoring intent operations through the Gateway seam. */
export function installSourceAuthoringOps(runtime: SourceAuthoringRuntime): () => void {
  const unregisterPreflight = registerTransientApplier(
    'asset.preflight',
    (op: EditorOp) => runSourcePreflight(op, runtime),
  );
  const registrations = [
    ['previewAssetSourceMutation', (op: EditorOp, ctx?: SessionApplierCtx) => runSourceOperation(op, ctx, runtime, 'previewAssetSourceMutation')],
    ['saveAssetSourceOverride', (op: EditorOp, ctx?: SessionApplierCtx) => runSourceOperation(op, ctx, runtime, 'saveAssetSourceOverride')],
    ['reimportAsset', (op: EditorOp, ctx?: SessionApplierCtx) => runSourceOperation(op, ctx, runtime, 'reimportAsset')],
    ['discardSourceOverridesAndReimport', (op: EditorOp, ctx?: SessionApplierCtx) => runSourceOperation(op, ctx, runtime, 'discardSourceOverridesAndReimport')],
  ] as const;
  const unregister = registrations.map(([kind, applier]) => registerSessionApplier(kind, applier as SessionApplier));
  return () => {
    for (const remove of unregister.reverse()) remove();
    unregisterPreflight();
  };
}
