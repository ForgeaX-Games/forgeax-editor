import {
  preflightAssetSourceMutation,
  type AssetSourceMutationOutput,
  type AssetSourceMutationIntent,
  type AssetSourceMutationPreflightOptions,
  type AssetSourceMutationPreflightResult,
  type AssetSourceMutationRequest,
} from '@forgeax/editor-product';
import type { AssetSourceMutationErrorCode } from '@forgeax/editor-product';
import type {
  AssetBrowserAsset,
  AssetBrowserCatalogRelation,
  AssetBrowserSnapshot,
} from './asset-browser-read-model';
import type { SourceOverrideDescriptor } from '@forgeax/engine-types';

export interface AssetIoSourceOutput {
  readonly guid: string;
  readonly sourceKey: string;
}

export interface AssetIoSourceSnapshot {
  readonly metaRevision: string;
  readonly subAssets: readonly AssetIoSourceOutput[];
  /** Producer descriptors read from the same catalog snapshot as the outputs. */
  readonly sourceOverrideDescriptors?: readonly SourceOverrideDescriptor[];
}

/** Public read fact used to build a source mutation request without guessing. */
export interface AssetSourceReadFact {
  readonly kind: 'asset-source-read-fact';
  readonly revisionSource: 'meta';
  readonly expectedRevision: string;
  readonly sourceKeys: readonly string[];
  readonly sourceOverrideDescriptors: readonly SourceOverrideDescriptor[];
}

/** Project the current Meta and producer descriptor facts; this function reads only. */
export function readAssetSourceFact(snapshot: AssetIoSourceSnapshot): AssetSourceReadFact {
  return {
    kind: 'asset-source-read-fact',
    revisionSource: 'meta',
    expectedRevision: snapshot.metaRevision,
    sourceKeys: snapshot.subAssets.map((output) => output.sourceKey),
    sourceOverrideDescriptors: snapshot.sourceOverrideDescriptors ?? [],
  };
}

export interface ActiveSceneSourceReference {
  readonly assetGuid: string;
  readonly instanceGuid: string;
}

export interface SourceMutationPreflightInput {
  readonly browser: {
    readonly assets: AssetBrowserSnapshot['assets'];
    readonly relations?: readonly AssetBrowserCatalogRelation[];
    readonly workspace?: AssetBrowserSnapshot['workspace'];
  };
  readonly meta: AssetIoSourceSnapshot;
  readonly activeSceneReferences: readonly ActiveSceneSourceReference[];
}

export interface SourceMutationProjectionError {
  readonly code: 'asset-source-impact-incomplete';
  readonly hint: string;
  readonly recoveryActions: readonly string[];
  readonly missingGuids: readonly string[];
}

export type SourceMutationPreflightResult =
  | AssetSourceMutationPreflightResult
  | { readonly ok: false; readonly error: SourceMutationProjectionError };

export interface SourceMutationOperationIdentity {
  readonly operationId: string;
  readonly requestId: string;
}

export interface SourceMutationPreflightCommand extends AssetSourceMutationRequest, SourceMutationOperationIdentity {
  readonly intent: AssetSourceMutationIntent;
  readonly expectedRevision: string;
}

export interface SourceMutationErrorSubjectRef {
  readonly kind: 'asset-source';
  readonly guid: string;
  readonly sourceKey?: string;
}

export interface SourceMutationPreflightError extends SourceMutationOperationIdentity {
  readonly code: AssetSourceMutationErrorCode | 'asset-source-impact-incomplete';
  readonly phase: 'entry';
  readonly subjectRef: SourceMutationErrorSubjectRef;
  readonly hint: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly recoveryActions: readonly string[];
  readonly retryable: boolean;
  readonly missingGuids?: readonly string[];
}

export type CoordinatedSourceMutationPreflightResult =
  | {
    readonly ok: true;
    readonly operationId: string;
    readonly requestId: string;
    readonly preflight: AssetSourceMutationPreflightResult;
  }
  | { readonly ok: false; readonly error: SourceMutationPreflightError };

export interface SourceMutationPreflightCoordinator {
  readonly preflight: (command: SourceMutationPreflightCommand) => CoordinatedSourceMutationPreflightResult;
}

function relationTouchesGuid(relation: AssetBrowserCatalogRelation, guid: string): boolean {
  return relation.from === guid || relation.to === guid;
}

function referencersForAsset(
  assets: readonly AssetBrowserAsset[],
  relations: readonly AssetBrowserCatalogRelation[],
  guid: string,
): readonly string[] {
  const referencers = new Set<string>();
  for (const relation of relations) {
    if (relation.kind === 'depends-on' && relation.to === guid) referencers.add(relation.from);
    if (relation.kind === 'referenced-by' && relation.from === guid) referencers.add(relation.to);
  }
  for (const asset of assets) {
    if (asset.refs.includes(guid)) referencers.add(asset.guid);
  }
  return [...referencers].sort();
}

function relationsForAsset(
  asset: AssetBrowserAsset | undefined,
  browser: { readonly workspace?: AssetBrowserSnapshot['workspace'] },
  guid: string,
): readonly AssetBrowserCatalogRelation[] {
  const fromAsset = asset?.relations ?? [];
  const workspaceRelations = browser.workspace?.relations.filter((relation) => relationTouchesGuid(relation, guid)) ?? [];
  return [...fromAsset, ...workspaceRelations];
}

function buildOutputs(input: SourceMutationPreflightInput): readonly AssetSourceMutationOutput[] {
  const assetsByGuid = new Map(input.browser.assets.map((asset) => [asset.guid.toLowerCase(), asset]));
  return input.meta.subAssets.map((subAsset) => {
    const guid = subAsset.guid.toLowerCase();
    const asset = assetsByGuid.get(guid);
    const relations = relationsForAsset(asset, input.browser, guid);
    return {
      guid,
      sourceKey: subAsset.sourceKey,
      referencerGuids: referencersForAsset(input.browser.assets, relations, guid),
      instanceGuids: input.activeSceneReferences
        .filter((reference) => reference.assetGuid.toLowerCase() === guid)
        .map((reference) => reference.instanceGuid)
        .sort(),
    };
  });
}

export function preflightSourceMutation(
  input: SourceMutationPreflightInput,
  request: AssetSourceMutationRequest,
  options: AssetSourceMutationPreflightOptions = {},
): SourceMutationPreflightResult {
  const catalogGuids = new Set(input.browser.assets.map((asset) => asset.guid.toLowerCase()));
  const missingGuids = input.meta.subAssets
    .map((output) => output.guid.toLowerCase())
    .filter((guid) => !catalogGuids.has(guid));
  if (missingGuids.length > 0) {
    return {
      ok: false,
      error: {
        code: 'asset-source-impact-incomplete',
        hint: 'The source impact cannot be confirmed until every Meta output is present in the Catalog snapshot.',
        recoveryActions: ['asset.preflight', 'catalog.reconcile'],
        missingGuids: [...new Set(missingGuids)].sort(),
      },
    };
  }
  return preflightAssetSourceMutation(
    { metaRevision: input.meta.metaRevision, outputs: buildOutputs(input) },
    request,
    options,
  );
}

function sourceErrorSubject(command: SourceMutationPreflightCommand): SourceMutationErrorSubjectRef {
  return {
    kind: 'asset-source',
    guid: command.guid,
    ...(command.scope.all === true || command.scope.sourceKey.trim() === '' ? {} : { sourceKey: command.scope.sourceKey }),
  };
}

function coordinateError(
  command: SourceMutationPreflightCommand,
  error: {
    readonly code: AssetSourceMutationErrorCode | 'asset-source-impact-incomplete';
    readonly hint: string;
    readonly expected?: string;
    readonly actual?: string;
    readonly recoveryActions: readonly string[];
    readonly retryable?: boolean;
    readonly missingGuids?: readonly string[];
  },
): SourceMutationPreflightError {
  return {
    operationId: command.operationId,
    requestId: command.requestId,
    phase: 'entry',
    subjectRef: sourceErrorSubject(command),
    code: error.code,
    hint: error.hint,
    ...(error.expected === undefined ? {} : { expected: error.expected }),
    ...(error.actual === undefined ? {} : { actual: error.actual }),
    recoveryActions: error.recoveryActions,
    retryable: error.retryable ?? true,
    ...(error.missingGuids === undefined ? {} : { missingGuids: error.missingGuids }),
  };
}

/**
 * Build the source-mutation preflight door used by both human UI and AI.
 * The coordinator owns no authored state: it only projects the current Catalog,
 * Meta, and active-scene inputs into the Product preflight contract, adding the
 * operation identity required for structured Gateway errors.
 */
export function createSourceMutationPreflightCoordinator(
  input: SourceMutationPreflightInput,
  options: AssetSourceMutationPreflightOptions = {},
): SourceMutationPreflightCoordinator {
  return {
    preflight(command) {
      const result = preflightSourceMutation(input, command, options);
      if (result.ok) {
        return {
          ok: true,
          operationId: command.operationId,
          requestId: command.requestId,
          preflight: result,
        };
      }
      const error = 'error' in result && result.error !== undefined
        ? result.error
        : {
          code: 'asset-source-impact-incomplete' as const,
          hint: 'The source impact could not be projected from the current snapshot.',
          recoveryActions: ['asset.preflight', 'catalog.reconcile'],
        };
      return { ok: false, error: coordinateError(command, error) };
    },
  };
}
