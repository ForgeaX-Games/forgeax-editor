import type {
  AssetMutationOperation,
  AssetMutationRequest,
  AssetSourceMutationConfirmation,
  AssetSourceMutationIntent,
  AssetSourceMutationRequest,
  AssetSourceMutationScope,
  AssetSourceMutationSnapshot,
  AssetSubject,
  AssetSubjectId,
  AssetWorkspaceSnapshot,
} from '../contracts/asset-workspace';
import { getAssetSubjectCapability } from './subject-capability';

export type { AssetMutationRequest } from '../contracts/asset-workspace';
export type {
  AssetSourceMutationConfirmation,
  AssetSourceMutationIntent,
  AssetSourceMutationRequest,
  AssetSourceMutationScope,
  AssetSourceMutationSnapshot,
} from '../contracts/asset-workspace';

export type AssetSubjectAction = 'import' | 'move' | 'delete';

export type AssetMutationErrorCode =
  | 'revision-conflict'
  | 'confirmation-required'
  | 'confirmation-mismatch'
  | 'owner-conflict'
  | 'scope-conflict'
  | 'unsupported-subject-operation'
  | 'resource-transaction-failed';

export interface AssetMutationError {
  readonly code: AssetMutationErrorCode;
  readonly hint: string;
  readonly expected?: string;
  readonly current?: string;
  readonly subjectRef: AssetSubjectId;
  readonly retryable: boolean;
  readonly recoveryActions: readonly string[];
}

export interface AssetMutationImpact {
  readonly referencerIds: readonly AssetSubjectId[];
  readonly affectedSubjectIds: readonly AssetSubjectId[];
  readonly affectedResourceIds: readonly string[];
}

export interface AssetPreflightResult {
  readonly ok: boolean;
  readonly operation: AssetMutationOperation;
  readonly subjectRef: AssetSubjectId;
  readonly subject?: AssetSubject;
  readonly currentRevision: string;
  readonly expectedRevision: string;
  readonly impact: AssetMutationImpact;
  readonly confirmation: { readonly required: boolean; readonly token?: string };
  readonly recoveryActions: readonly string[];
  readonly error?: AssetMutationError;
}

export interface AssetPreflightOptions {
  readonly scope?: string;
  readonly currentOwner?: string;
}

export interface AssetMutationCommitResult {
  readonly revision: string;
  readonly snapshot?: AssetWorkspaceSnapshot;
}

export type AssetMutationResult =
  | {
      readonly ok: true;
      readonly mutationCount: 1;
      readonly revision: string;
      readonly snapshot: AssetWorkspaceSnapshot;
      readonly playSnapshot: AssetWorkspaceSnapshot;
    }
  | {
      readonly ok: false;
      readonly mutationCount: 0;
      readonly error: AssetMutationError;
      readonly snapshot: AssetWorkspaceSnapshot;
      readonly playSnapshot: AssetWorkspaceSnapshot;
    };

export type AssetSourceMutationErrorCode =
  | 'asset-source-key-missing'
  | 'asset-source-key-unknown'
  | 'asset-source-key-ambiguous'
  | 'asset-meta-revision-conflict'
  | 'asset-confirmation-required'
  | 'asset-confirmation-expired'
  | 'asset-confirmation-mismatch';

export interface AssetSourceMutationError {
  readonly code: AssetSourceMutationErrorCode;
  readonly hint: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly recoveryActions: readonly string[];
  readonly retryable: boolean;
}

export interface AssetSourceMutationPreflightResult {
  readonly ok: boolean;
  readonly guid: string;
  readonly scope: AssetSourceMutationScope;
  readonly expectedRevision: string;
  readonly sourceKeys: readonly string[];
  readonly affectedGuids: readonly string[];
  readonly referencerGuids: readonly string[];
  readonly instanceGuids: readonly string[];
  readonly risks: readonly string[];
  readonly confirmation: AssetSourceMutationConfirmation;
  readonly error?: AssetSourceMutationError;
}

export interface AssetSourceMutationPreflightOptions {
  readonly now?: number;
  readonly confirmationTtlMs?: number;
  readonly intent?: AssetSourceMutationIntent;
}

export interface AssetSourceMutationAuthorizationRequest {
  readonly intent: AssetSourceMutationIntent;
  readonly confirmationToken?: string;
  readonly now?: number;
}

export type AssetSourceMutationAuthorizationResult =
  | { readonly ok: true; readonly confirmationRequired: boolean; readonly error?: never }
  | { readonly ok: false; readonly confirmationRequired: boolean; readonly error: AssetSourceMutationError };

export interface AssetLifecycleAdapter {
  readonly preflight: (request: AssetMutationRequest) => AssetPreflightResult;
  readonly run: (request: AssetMutationRequest) => Promise<AssetMutationResult>;
}

export interface AssetLifecycleAdapterOptions {
  readonly getSnapshot: () => AssetWorkspaceSnapshot;
  readonly commit: (request: AssetMutationRequest) => Promise<AssetMutationCommitResult>;
  readonly preflightOptions?: AssetPreflightOptions;
}

export function findAssetSubject(
  snapshot: AssetWorkspaceSnapshot,
  subjectId: AssetSubjectId,
): AssetSubject | undefined {
  return snapshot.subjects.find((subject) => subject.id === subjectId);
}

function sourceError(
  code: AssetSourceMutationErrorCode,
  hint: string,
  fields: Partial<Pick<AssetSourceMutationError, 'expected' | 'actual' | 'retryable'>> = {},
): AssetSourceMutationError {
  return {
    code,
    hint,
    recoveryActions: ['asset.preflight'],
    retryable: false,
    ...fields,
  };
}

function sourceScopeKey(scope: AssetSourceMutationScope): string {
  return scope.all === true ? 'all' : scope.sourceKey;
}

function sourceToken(
  expectedRevision: string,
  scope: AssetSourceMutationScope,
  affectedGuids: readonly string[],
  expiresAt: number,
): string {
  const value = JSON.stringify({ expectedRevision, scope, affectedGuids, expiresAt });
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `asset-source-confirmation:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function sourcePreflightBase(
  snapshot: AssetSourceMutationSnapshot,
  request: AssetSourceMutationRequest,
): Omit<AssetSourceMutationPreflightResult, 'error'> {
  return {
    ok: true,
    guid: request.guid,
    scope: request.scope,
    expectedRevision: snapshot.metaRevision,
    sourceKeys: [],
    affectedGuids: [],
    referencerGuids: [],
    instanceGuids: [],
    risks: [],
    confirmation: {
      required: false,
      scope: request.scope,
      expectedRevision: snapshot.metaRevision,
      affectedGuids: [],
    },
  };
}

function sourceImpact(selected: readonly AssetSourceMutationSnapshot['outputs'][number][]): {
  readonly sourceKeys: readonly string[];
  readonly affectedGuids: readonly string[];
  readonly referencerGuids: readonly string[];
  readonly instanceGuids: readonly string[];
} {
  return {
    sourceKeys: [...new Set(selected.map((output) => output.sourceKey))].sort(),
    affectedGuids: [...new Set(selected.map((output) => output.guid))].sort(),
    referencerGuids: [...new Set(selected.flatMap((output) => output.referencerGuids))].sort(),
    instanceGuids: [...new Set(selected.flatMap((output) => output.instanceGuids))].sort(),
  };
}

export function preflightAssetSourceMutation(
  snapshot: AssetSourceMutationSnapshot,
  request: AssetSourceMutationRequest,
  options: AssetSourceMutationPreflightOptions = {},
): AssetSourceMutationPreflightResult {
  const expectedRevision = snapshot.metaRevision;
  const base = sourcePreflightBase(snapshot, request);

  if (request.guid.trim() === '') {
    return {
      ...base,
      ok: false,
      error: sourceError('asset-source-key-missing', 'A stable imported output GUID is required for source mutation preflight.'),
    };
  }
  if (request.scope.all !== true && request.scope.sourceKey.trim() === '') {
    return {
      ...base,
      ok: false,
      error: sourceError('asset-source-key-missing', 'An explicit sourceKey or all scope is required.'),
    };
  }
  if (request.expectedRevision !== undefined && request.expectedRevision !== snapshot.metaRevision) {
    return {
      ...base,
      ok: false,
      error: sourceError('asset-meta-revision-conflict', 'The Meta revision changed after the source impact was observed.', {
        expected: request.expectedRevision,
        actual: snapshot.metaRevision,
        retryable: true,
      }),
    };
  }

  const eligible = snapshot.outputs.filter((output) => output.promoted !== true);
  const selected = request.scope.all === true
    ? eligible
    : eligible.filter((output) => output.sourceKey === request.scope.sourceKey);
  if (selected.length === 0) {
    return {
      ...base,
      ok: false,
      error: sourceError('asset-source-key-unknown', `No imported output is registered for scope ${sourceScopeKey(request.scope)}.`),
    };
  }
  if (!request.scope.all && !selected.some((output) => output.guid === request.guid)) {
    return {
      ...base,
      ok: false,
      error: sourceError('asset-source-key-ambiguous', 'The requested GUID does not belong to the selected sourceKey.'),
    };
  }

  const impact = sourceImpact(selected);
  const intent = options.intent ?? 'discard-source-overrides-and-reimport';
  const destructive = intent === 'discard-source-overrides-and-reimport';
  const now = options.now ?? Date.now();
  const expiresAt = now + (options.confirmationTtlMs ?? 5 * 60 * 1000);
  const confirmation: AssetSourceMutationConfirmation = {
    required: destructive,
    scope: request.scope,
    expectedRevision,
    affectedGuids: impact.affectedGuids,
    ...(destructive ? { expiresAt, token: sourceToken(expectedRevision, request.scope, impact.affectedGuids, expiresAt) } : {}),
  };
  return {
    ...base,
    ...impact,
    confirmation,
  };
}

export function authorizeAssetSourceMutation(
  preflight: AssetSourceMutationPreflightResult,
  request: AssetSourceMutationAuthorizationRequest,
): AssetSourceMutationAuthorizationResult {
  const destructive = request.intent === 'discard-source-overrides-and-reimport';
  if (!preflight.ok && preflight.error) {
    return { ok: false, confirmationRequired: destructive, error: preflight.error };
  }
  if (!destructive) return { ok: true, confirmationRequired: false };
  if (request.confirmationToken === undefined) {
    return {
      ok: false,
      confirmationRequired: true,
      error: sourceError('asset-confirmation-required', 'Discard requires a confirmation token from the current impact preview.'),
    };
  }
  const expiresAt = preflight.confirmation.expiresAt;
  if (expiresAt === undefined || (request.now ?? Date.now()) >= expiresAt) {
    return {
      ok: false,
      confirmationRequired: true,
      error: sourceError('asset-confirmation-expired', 'The source impact confirmation has expired; run preflight again.'),
    };
  }
  if (request.confirmationToken !== preflight.confirmation.token) {
    return {
      ok: false,
      confirmationRequired: true,
      error: sourceError('asset-confirmation-mismatch', 'The confirmation token is bound to a different source scope or impact revision.'),
    };
  }
  return { ok: true, confirmationRequired: true };
}

export function subjectSupports(
  snapshot: AssetWorkspaceSnapshot,
  subjectId: AssetSubjectId,
  action: AssetSubjectAction,
): boolean {
  const subject = findAssetSubject(snapshot, subjectId);
  if (!subject) return false;
  if (action === 'import') return subject.capabilities.canImport;
  if (action === 'move') return subject.capabilities.canMove;
  return subject.capabilities.canDelete;
}

function mutationNeedsConfirmation(operation: AssetMutationOperation): boolean {
  return operation !== 'duplicate';
}

function tokenFor(snapshot: AssetWorkspaceSnapshot, request: AssetMutationRequest, impact: AssetMutationImpact): string {
  const value = JSON.stringify({
    revision: snapshot.resourceRevision,
    operation: request.operation,
    subjectId: request.subjectId,
    affectedSubjectIds: impact.affectedSubjectIds,
  });
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `asset-confirmation:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function error(
  code: AssetMutationErrorCode,
  subjectRef: AssetSubjectId,
  hint: string,
  fields: Pick<AssetMutationError, 'expected' | 'current'> = {},
): AssetMutationError {
  return {
    code,
    hint,
    subjectRef,
    retryable: code === 'revision-conflict' || code === 'resource-transaction-failed',
    recoveryActions: ['asset.preflight'],
    ...fields,
  };
}

function impactFor(snapshot: AssetWorkspaceSnapshot, subjectId: AssetSubjectId): AssetMutationImpact {
  const referencerIds = new Set<AssetSubjectId>();
  const queue = [subjectId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    for (const relation of snapshot.relations) {
      if (relation.to !== current || relation.kind !== 'referenced-by' || referencerIds.has(relation.from)) continue;
      referencerIds.add(relation.from);
      queue.push(relation.from);
    }
  }
  const orderedReferencers = [...referencerIds].sort();
  const affectedSubjectIds = [subjectId, ...orderedReferencers].sort();
  const affectedResourceIds = snapshot.subjects
    .filter((subject) => affectedSubjectIds.includes(subject.id))
    .map((subject) => subject.resourceId)
    .sort();
  return { referencerIds: orderedReferencers, affectedSubjectIds, affectedResourceIds };
}

export function preflightAssetMutation(
  snapshot: AssetWorkspaceSnapshot,
  request: AssetMutationRequest,
  options: AssetPreflightOptions = {},
): AssetPreflightResult {
  const subject = findAssetSubject(snapshot, request.subjectId);
  const impact = impactFor(snapshot, request.subjectId);
  const expectedRevision = request.expectedRevision ?? snapshot.resourceRevision;
  const base = {
    ok: true,
    operation: request.operation,
    subjectRef: request.subjectId,
    ...(subject ? { subject } : {}),
    currentRevision: snapshot.resourceRevision,
    expectedRevision,
    impact,
    confirmation: { required: mutationNeedsConfirmation(request.operation) },
    recoveryActions: ['asset.preflight', 'asset.restore'],
  } satisfies Omit<AssetPreflightResult, 'error'>;

  if (!subject) {
    return { ...base, ok: false, error: error('unsupported-subject-operation', request.subjectId, 'The asset subject does not exist.') };
  }
  if (expectedRevision !== snapshot.resourceRevision) {
    return {
      ...base,
      ok: false,
      error: error('revision-conflict', request.subjectId, 'The asset workspace revision is stale.', {
        expected: expectedRevision,
        current: snapshot.resourceRevision,
      }),
    };
  }
  if (options.scope !== undefined && request.scope !== undefined && options.scope !== request.scope) {
    return { ...base, ok: false, error: error('scope-conflict', request.subjectId, 'The mutation scope does not own this subject.') };
  }
  if (options.currentOwner !== undefined && request.owner !== options.currentOwner) {
    return { ...base, ok: false, error: error('owner-conflict', request.subjectId, 'Another owner currently holds this subject.') };
  }
  const capability = getAssetSubjectCapability(subject).operations[request.operation];
  if (!capability?.available) {
    return {
      ...base,
      ok: false,
      error: error('unsupported-subject-operation', request.subjectId, capability?.reason?.hint ?? 'The subject does not support this operation.'),
    };
  }
  const confirmation = mutationNeedsConfirmation(request.operation)
    ? { required: true, token: tokenFor(snapshot, request, impact) }
    : { required: false };
  return { ...base, confirmation };
}

export function authorizeAssetMutation(
  preflight: AssetPreflightResult,
  confirmationToken?: string,
): { readonly ok: boolean; readonly mutationCount: 0; readonly error?: AssetMutationError } {
  if (!preflight.ok && preflight.error) return { ok: false, mutationCount: 0, error: preflight.error };
  if (!preflight.confirmation.required) return { ok: true, mutationCount: 0 };
  if (confirmationToken === undefined) {
    return {
      ok: false,
      mutationCount: 0,
      error: error('confirmation-required', preflight.subjectRef, 'Explicit confirmation is required before mutation.'),
    };
  }
  if (confirmationToken !== preflight.confirmation.token) {
    return {
      ok: false,
      mutationCount: 0,
      error: error('confirmation-mismatch', preflight.subjectRef, 'The confirmation token does not match this preflight.'),
    };
  }
  return { ok: true, mutationCount: 0 };
}

export function createAssetLifecycleAdapter(options: AssetLifecycleAdapterOptions): AssetLifecycleAdapter {
  const preflight = (request: AssetMutationRequest): AssetPreflightResult =>
    preflightAssetMutation(options.getSnapshot(), request, options.preflightOptions);
  const run = async (request: AssetMutationRequest): Promise<AssetMutationResult> => {
    const snapshot = options.getSnapshot();
    const checked = preflightAssetMutation(snapshot, request, options.preflightOptions);
    const authorization = authorizeAssetMutation(checked, request.confirmationToken);
    if (!authorization.ok || !checked.ok) {
      const failure = authorization.error ?? checked.error ?? error('confirmation-required', request.subjectId, 'The mutation was not authorized.');
      return { ok: false, mutationCount: 0, error: failure, snapshot, playSnapshot: snapshot };
    }
    try {
      const committed = await options.commit(request);
      const nextSnapshot = committed.snapshot ?? snapshot;
      return { ok: true, mutationCount: 1, revision: committed.revision, snapshot: nextSnapshot, playSnapshot: nextSnapshot };
    } catch (caught) {
      return {
        ok: false,
        mutationCount: 0,
        error: error('resource-transaction-failed', request.subjectId, caught instanceof Error ? caught.message : 'Resource transaction failed.'),
        snapshot,
        playSnapshot: snapshot,
      };
    }
  };
  return { preflight, run };
}

export function preflightAssetSubject(
  snapshot: AssetWorkspaceSnapshot,
  subjectId: AssetSubjectId,
  action: AssetSubjectAction,
) {
  const subject = findAssetSubject(snapshot, subjectId);
  return {
    subjectId,
    action,
    revision: snapshot.resourceRevision,
    allowed: subjectSupports(snapshot, subjectId, action),
    subject,
    issues: snapshot.issues.filter((issue) => issue.subjectId === subjectId),
  };
}
