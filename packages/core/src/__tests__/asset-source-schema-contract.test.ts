import { describe, expect, it } from 'bun:test';
import { getOp, listOps, type ArgsSchema } from '../io/catalog';
import type { AssetSourceAuthoringErrorCode } from '../public/assets';

const OP_IDS = [
  'previewAssetSourceMutation',
  'saveAssetSourceOverride',
  'reimportAsset',
  'discardSourceOverridesAndReimport',
] as const;

const ERROR_CODES: readonly AssetSourceAuthoringErrorCode[] = [
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
];

function sourceSchema(id: typeof OP_IDS[number]): ArgsSchema {
  const operation = getOp(id);
  if (operation?.argsSchema === null || operation?.argsSchema === undefined) throw new Error(`missing schema for ${id}`);
  return operation.argsSchema;
}

type SourceSchemaProjection = ArgsSchema & {
  readonly oneOf?: readonly SourceSchemaProjection[];
  readonly additionalProperties?: boolean;
  readonly $ref?: string;
};

function projectedSourceSchema(id: typeof OP_IDS[number]): SourceSchemaProjection {
  return sourceSchema(id) as SourceSchemaProjection;
}

describe('public asset source schema contract', () => {
  it('publishes asset.preflight as the canonical read-only source fact operation', () => {
    expect(getOp('asset.preflight')).toMatchObject({
      id: 'asset.preflight',
      domain: 'transient',
      destructive: false,
      argsSchema: {
        type: 'object',
        required: ['guid', 'scope', 'requestId'],
        properties: {
          guid: { type: 'string', minLength: 1 },
          scope: { type: 'object' },
          requestId: { type: 'string', minLength: 1 },
        },
      },
      operationRun: {
        acceptedStatuses: ['accepted', 'running'],
        terminalStatuses: ['succeeded', 'failed', 'cancelled'],
      },
    });
    expect(getOp('asset.preflight')?.argsSchema?.properties?.expectedRevision).toBeUndefined();
  });

  it('publishes canonical descriptors with explicit destructive and terminal semantics', () => {
    for (const id of OP_IDS) {
      const operation = getOp(id);
      expect(operation).toMatchObject({
        id,
        domain: 'session',
        destructive: id === 'discardSourceOverridesAndReimport',
        operationRun: {
          acceptedStatuses: ['accepted', 'running'],
          terminalStatuses: ['succeeded', 'failed', 'cancelled'],
          retry: { requiresNewRequestId: true },
        },
        recoveryActions: ['asset.preflight', 'run.get', 'run.wait', 'run.retry', 'catalog.reconcile'],
      });
    }
  });

  it('requires stable identity, revision, scope, and request correlation fields', () => {
    const required = ['guid', 'scope', 'expectedRevision', 'requestId'];
    for (const id of OP_IDS) {
      const schema = sourceSchema(id);
      expect(schema.type).toBe('object');
      expect(schema.required).toEqual(id === 'saveAssetSourceOverride'
        ? ['guid', 'scope', 'expectedRevision', 'override', 'requestId']
        : required);
      expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining([
        'guid', 'scope', 'expectedRevision', 'requestId', 'retryOfRequestId',
      ]));
      expect(schema.properties?.guid).toMatchObject({ type: 'string', minLength: 1 });
      expect(schema.properties?.expectedRevision).toMatchObject({ type: 'string', minLength: 1 });
      expect(schema.properties?.scope?.properties?.sourceKey).toMatchObject({ type: 'string', minLength: 1 });
    }
  });

  it('separates override payload and destructive confirmation from normal mutation schemas', () => {
    expect(sourceSchema('saveAssetSourceOverride').properties?.override).toMatchObject({ type: 'object' });
    expect(sourceSchema('saveAssetSourceOverride').required).toContain('override');
    expect(sourceSchema('discardSourceOverridesAndReimport').properties?.confirmationToken)
      .toMatchObject({ type: 'string', minLength: 1 });
    expect(sourceSchema('previewAssetSourceMutation').properties?.confirmationToken).toBeUndefined();
    expect(sourceSchema('reimportAsset').properties?.override).toBeUndefined();
  });

  it('publishes mutually exclusive scope variants and the producer override contract', () => {
    for (const id of OP_IDS) {
      const scope = projectedSourceSchema(id).properties?.scope;
      expect(scope?.oneOf).toHaveLength(2);
      expect(scope?.oneOf?.map((variant) => variant.required)).toEqual(expect.arrayContaining([
        ['sourceKey'],
        ['all'],
      ]));
      expect(scope?.oneOf?.every((variant) => variant.additionalProperties === false)).toBe(true);
    }

    const override = projectedSourceSchema('saveAssetSourceOverride').properties?.override;
    expect(override).toMatchObject({
      type: 'object',
      $ref: 'asset.preflight.result.source.sourceOverrideDescriptors[].payloadSchema',
    });
  });

  it('keeps the closed structured error and recovery vocabulary public', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(ERROR_CODES).toEqual(expect.arrayContaining([
      'asset-source-key-missing',
      'asset-meta-revision-conflict',
      'asset-confirmation-required',
      'asset-cook-failed',
      'asset-publish-observation-timeout',
      'asset-catalog-subscription-gap',
      'asset-operation-cas-committed',
      'run-cancelled-before-cas',
    ]));
  });
});
