import type { CatalogLifecycle } from '@forgeax/engine-types';

export type SourceMutationLifecycle = 'current' | 'cooking' | 'stale' | 'failed' | 'recoverable';

export type SourceMutationScope =
  | { readonly sourceKey: string; readonly all?: false }
  | { readonly all: true; readonly sourceKey?: never };

export interface SourceMutationImpact {
  readonly scope: SourceMutationScope;
  readonly sourceKeys: readonly string[];
  readonly affectedGuids: readonly string[];
  readonly referencerGuids: readonly string[];
  readonly instanceGuids: readonly string[];
  readonly expectedRevision: string;
}

export interface SourceMutationOperationError {
  readonly code: string;
  readonly phase: string;
  readonly hint: string;
  readonly recoveryActions: readonly string[];
}

export interface SourceMutationOperation {
  readonly status: 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly error?: SourceMutationOperationError;
}

export interface SourceMutationRun {
  readonly runId: string;
  readonly requestId?: string;
  readonly operationId: string;
  readonly status: SourceMutationOperation['status'];
  readonly retryable: boolean;
  readonly input?: unknown;
  readonly result?: unknown;
  readonly error?: {
    readonly code: string;
    readonly phase?: string;
    readonly hint?: string;
  };
  readonly recoveryActions: readonly string[];
}

export interface SourceMutationPreflightFact {
  readonly source: {
    readonly expectedRevision: string;
    readonly sourceKeys: readonly string[];
    readonly sourceOverrideDescriptors: readonly unknown[];
  };
  readonly impact: SourceMutationImpact;
  readonly confirmation?: SourceMutationConfirmation;
}

export interface SourceMutationConfirmation {
  readonly token: string;
  readonly expiresAt: number;
  readonly expectedRevision: string;
}

export interface SourceMutationViewModelInput {
  readonly guid: string;
  readonly sourceKey: string;
  readonly lifecycle: SourceMutationLifecycle;
  readonly lastKnownGood?: string;
  readonly impact: SourceMutationImpact;
  readonly operation?: SourceMutationOperation;
  readonly confirmation?: SourceMutationConfirmation;
  readonly now: number;
}

export interface SourceMutationViewModel {
  readonly guid: string;
  readonly sourceKey: string;
  readonly lifecycle: SourceMutationLifecycle;
  readonly impact: SourceMutationImpact;
  readonly lastKnownGood?: string;
  readonly operation?: SourceMutationOperation;
  readonly errorCode?: string;
  readonly errorPhase?: string;
  readonly errorHint?: string;
  readonly recoveryActions: readonly string[];
  readonly confirmationToken?: string;
  readonly canReimport: boolean;
  readonly canDiscard: boolean;
}

const sourceMutationOperationIds = new Set([
  'saveAssetSourceOverride',
  'reimportAsset',
  'discardSourceOverridesAndReimport',
]);

function sourceMutationInputMatches(run: SourceMutationRun, guid: string, sourceKey: string): boolean {
  if (!sourceMutationOperationIds.has(run.operationId)) return false;
  if (typeof run.input !== 'object' || run.input === null || Array.isArray(run.input)) return false;
  const input = run.input as { readonly guid?: unknown; readonly sourceKey?: unknown; readonly scope?: { readonly sourceKey?: unknown } };
  return input.guid === guid && (input.sourceKey === sourceKey || input.scope?.sourceKey === sourceKey);
}

/** Read the latest Gateway-owned source run for the selected asset/sourceKey. */
export function findSourceMutationRun(
  runs: readonly SourceMutationRun[],
  guid: string,
  sourceKey: string,
): SourceMutationRun | undefined {
  return [...runs].reverse().find((run) => sourceMutationInputMatches(run, guid, sourceKey));
}

export function findSourceMutationPreflightRun(
  runs: readonly SourceMutationRun[],
  guid: string,
  sourceKey: string,
): SourceMutationRun | undefined {
  return [...runs].reverse().find((run) => run.operationId === 'asset.preflight'
    && run.status === 'succeeded'
    && sourceMutationInputMatches({ ...run, operationId: 'reimportAsset' }, guid, sourceKey));
}

function stringList(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;
}

/** Parse only the canonical preflight terminal result; malformed projections stay unusable. */
export function sourceMutationPreflightFromRun(run: SourceMutationRun): SourceMutationPreflightFact | undefined {
  if (run.operationId !== 'asset.preflight' || run.status !== 'succeeded'
    || run.result === null || typeof run.result !== 'object') return undefined;
  const result = run.result as { readonly source?: unknown; readonly impact?: unknown };
  if (result.source === null || typeof result.source !== 'object'
    || result.impact === null || typeof result.impact !== 'object') return undefined;
  const source = result.source as {
    readonly expectedRevision?: unknown;
    readonly sourceKeys?: unknown;
    readonly sourceOverrideDescriptors?: unknown;
  };
  const impact = result.impact as {
    readonly scope?: unknown;
    readonly sourceKeys?: unknown;
    readonly affectedGuids?: unknown;
    readonly referencerGuids?: unknown;
    readonly instanceGuids?: unknown;
    readonly expectedRevision?: unknown;
    readonly confirmation?: unknown;
  };
  const sourceKeys = stringList(source.sourceKeys);
  const impactSourceKeys = stringList(impact.sourceKeys);
  const affectedGuids = stringList(impact.affectedGuids);
  const referencerGuids = stringList(impact.referencerGuids);
  const instanceGuids = stringList(impact.instanceGuids);
  if (typeof source.expectedRevision !== 'string' || sourceKeys === undefined
    || !Array.isArray(source.sourceOverrideDescriptors) || impactSourceKeys === undefined
    || affectedGuids === undefined || referencerGuids === undefined || instanceGuids === undefined
    || typeof impact.expectedRevision !== 'string' || impact.scope === null || typeof impact.scope !== 'object') return undefined;
  const scope = impact.scope as SourceMutationScope;
  const confirmationInput = impact.confirmation as {
    readonly required?: unknown;
    readonly token?: unknown;
    readonly expiresAt?: unknown;
  } | undefined;
  const confirmation = confirmationInput?.required === true
    && typeof confirmationInput.token === 'string'
    && typeof confirmationInput.expiresAt === 'number'
    ? {
      token: confirmationInput.token,
      expiresAt: confirmationInput.expiresAt,
      expectedRevision: impact.expectedRevision,
    }
    : undefined;
  return {
    source: {
      expectedRevision: source.expectedRevision,
      sourceKeys,
      sourceOverrideDescriptors: source.sourceOverrideDescriptors,
    },
    impact: {
      scope,
      sourceKeys: impactSourceKeys,
      affectedGuids,
      referencerGuids,
      instanceGuids,
      expectedRevision: impact.expectedRevision,
    },
    ...(confirmation === undefined ? {} : { confirmation }),
  };
}

/** Select only the displayed run's advertised retry action, never another asset's run. */
export function findRetryableSourceMutationRun(
  runs: readonly SourceMutationRun[],
  guid: string,
  sourceKey: string,
): SourceMutationRun | undefined {
  const run = findSourceMutationRun(runs, guid, sourceKey);
  return run?.status === 'failed' && run.retryable && run.recoveryActions.includes('run.retry') ? run : undefined;
}

export function sourceMutationOperationFromRun(run: SourceMutationRun): SourceMutationOperation {
  return {
    status: run.status,
    ...(run.error === undefined ? {} : {
      error: {
        code: run.error.code,
        phase: run.error.phase ?? 'publication',
        hint: run.error.hint ?? 'The source operation failed.',
        recoveryActions: run.recoveryActions,
      },
    }),
  };
}

export function resolveSourceMutationExpectedRevision(
  assetRevision: string | undefined,
  operationInput: unknown,
): string | undefined {
  if (typeof operationInput === 'object' && operationInput !== null) {
    const expectedRevision = (operationInput as { readonly expectedRevision?: unknown }).expectedRevision;
    if (typeof expectedRevision === 'string' && expectedRevision.length > 0) return expectedRevision;
  }
  return assetRevision !== undefined && assetRevision.length > 0 ? assetRevision : undefined;
}

export function resolveSourceMutationLifecycle(input: {
  readonly catalogLifecycle?: CatalogLifecycle;
  readonly operationStatus?: SourceMutationOperation['status'];
  readonly hasLastKnownGood?: boolean;
}): SourceMutationLifecycle {
  if (input.operationStatus === 'failed' || input.catalogLifecycle === 'missing' || input.catalogLifecycle === 'failed') {
    return input.hasLastKnownGood === true ? 'recoverable' : 'failed';
  }
  if (input.catalogLifecycle === 'stale') return 'stale';
  if (input.catalogLifecycle === 'cooking' || isRunning({ status: input.operationStatus ?? 'succeeded' })) return 'cooking';
  return 'current';
}

const defaultRecoveryActions = ['asset.preflight', 'run.get', 'run.wait', 'run.retry', 'catalog.reconcile'] as const;

function isRunning(operation: SourceMutationOperation | undefined): boolean {
  return operation?.status === 'accepted' || operation?.status === 'running';
}

function validConfirmation(
  confirmation: SourceMutationConfirmation | undefined,
  expectedRevision: string,
  now: number,
): boolean {
  return confirmation !== undefined
    && confirmation.token.length > 0
    && confirmation.expiresAt > now
    && confirmation.expectedRevision === expectedRevision;
}

export function createSourceMutationViewModel(input: SourceMutationViewModelInput): SourceMutationViewModel {
  const error = input.operation?.error;
  const recoveryActions = error?.recoveryActions.length
    ? error.recoveryActions
    : defaultRecoveryActions;
  const discardable = validConfirmation(input.confirmation, input.impact.expectedRevision, input.now);
  return Object.freeze({
    guid: input.guid,
    sourceKey: input.sourceKey,
    lifecycle: input.lifecycle,
    impact: input.impact,
    ...(input.lastKnownGood === undefined ? {} : { lastKnownGood: input.lastKnownGood }),
    ...(input.operation === undefined ? {} : { operation: input.operation }),
    ...(error === undefined ? {} : {
      errorCode: error.code,
      errorPhase: error.phase,
      errorHint: error.hint,
    }),
    recoveryActions: Object.freeze([...recoveryActions]),
    ...(discardable ? { confirmationToken: input.confirmation?.token } : {}),
    canReimport: !isRunning(input.operation),
    canDiscard: !isRunning(input.operation) && discardable,
  });
}

export type SourceMutationAction = 'reimport' | 'discard' | 'retry' | 'reconcile';

export function canDispatchSourceMutation(
  viewModel: SourceMutationViewModel,
  action: SourceMutationAction,
): boolean {
  if (action === 'reimport') return viewModel.canReimport;
  if (action === 'discard') return viewModel.canDiscard;
  return viewModel.recoveryActions.includes(action === 'retry' ? 'run.retry' : 'catalog.reconcile');
}
