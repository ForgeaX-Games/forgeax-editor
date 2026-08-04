import { describe, expect, it } from 'bun:test';
import { listOps, type OpDescriptor } from '../io/catalog';
import type { AssetSourceAuthoringError, AssetSourceAuthoringErrorCode } from '../public/assets';

const SOURCE_OPS = [
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

function descriptor(id: string): OpDescriptor {
  const found = listOps().find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`missing public source operation: ${id}`);
  return found;
}

function fieldNames(operation: OpDescriptor): string[] {
  return Object.keys(operation.argsSchema?.properties ?? {}).sort();
}

function recoverFromStructuredError(error: AssetSourceAuthoringError): string {
  switch (error.code) {
    case 'asset-source-key-missing':
    case 'asset-source-key-unknown':
    case 'asset-source-key-ambiguous':
      return 'asset.preflight';
    case 'asset-meta-revision-conflict':
      return 'asset.preflight';
    case 'asset-confirmation-required':
    case 'asset-confirmation-expired':
    case 'asset-confirmation-mismatch':
      return 'asset.preflight';
    case 'asset-validation-failed':
    case 'asset-cook-failed':
      return 'run.retry';
    case 'asset-publish-observation-timeout':
    case 'asset-catalog-subscription-gap':
      return 'catalog.reconcile';
    case 'asset-operation-cas-committed':
      return 'run.get';
    case 'run-cancelled-before-cas':
      return 'run.retry';
  }
}

describe('asset source AI affordance contract', () => {
  it('discovers the canonical preview, submit, discard, and reimport operations', () => {
    const ops = listOps().filter((entry) => SOURCE_OPS.includes(entry.id as typeof SOURCE_OPS[number]));
    expect(ops).toHaveLength(SOURCE_OPS.length);
    expect(ops.map((entry) => entry.id)).toEqual(expect.arrayContaining([...SOURCE_OPS]));
    expect(ops.every((entry) => entry.domain === 'session')).toBe(true);
    expect(ops.every((entry) => entry.operationRun?.acceptedStatuses.includes('accepted'))).toBe(true);
    expect(ops.every((entry) => entry.operationRun?.terminalStatuses.includes('succeeded'))).toBe(true);
    expect(listOps().some((entry) => entry.id === 'reimportAssetByPath')).toBe(false);
  });

  it('uses stable schema fields for preview, save, reimport, and destructive discard', () => {
    const common = ['expectedRevision', 'guid', 'requestId', 'retryOfRequestId', 'scope'];
    for (const id of SOURCE_OPS) {
      expect(fieldNames(descriptor(id))).toEqual(expect.arrayContaining(common));
    }
    expect(fieldNames(descriptor('saveAssetSourceOverride'))).toContain('override');
    expect(fieldNames(descriptor('discardSourceOverridesAndReimport'))).toContain('confirmationToken');
    expect(descriptor('discardSourceOverridesAndReimport').destructive).toBe(true);
    expect(descriptor('previewAssetSourceMutation').destructive).toBe(false);
    expect(descriptor('discardSourceOverridesAndReimport').recoveryActions).toEqual([
      'asset.preflight', 'run.get', 'run.wait', 'run.retry', 'catalog.reconcile',
    ]);

    const scope = descriptor('reimportAsset').argsSchema?.properties?.scope as {
      readonly oneOf?: ReadonlyArray<{ readonly required?: readonly string[] }>;
    } | undefined;
    expect(scope?.oneOf?.map((variant) => variant.required)).toEqual(expect.arrayContaining([
      ['sourceKey'],
      ['all'],
    ]));
  });

  it('exposes the Meta revision as the expectedRevision read fact', async () => {
    const publicAssets = await import('../public/assets');
    const readAssetSourceFact = (publicAssets as typeof publicAssets & {
      readonly readAssetSourceFact?: (snapshot: {
        readonly metaRevision: string;
        readonly subAssets: readonly { readonly guid: string; readonly sourceKey: string }[];
        readonly sourceOverrideDescriptors?: readonly unknown[];
      }) => {
        readonly expectedRevision: string;
        readonly sourceKeys: readonly string[];
      };
    }).readAssetSourceFact;

    expect(readAssetSourceFact).toBeTypeOf('function');
    expect(readAssetSourceFact?.({
      metaRevision: 'meta:r7',
      subAssets: [{ guid: 'guid:mesh', sourceKey: 'source:mesh' }],
    })).toMatchObject({
      expectedRevision: 'meta:r7',
      sourceKeys: ['source:mesh'],
    });
  });

  it('waits and retries through the Gateway-owned OperationRun contract', () => {
    const run = descriptor('reimportAsset').operationRun;
    expect(run?.read).toEqual({ get: 'getOperationRun', wait: 'waitOperationRun', subscribe: 'subscribeOperationRun' });
    expect(run?.retry).toEqual({ requiresNewRequestId: true });
    expect(run?.terminalStatuses).toEqual(['succeeded', 'failed', 'cancelled']);
    expect(run?.retention).toEqual({ kind: 'terminal-only', maxTerminalRuns: 64 });
  });

  it('maps every public failure category from stable fields, never message text', () => {
    for (const code of ERROR_CODES) {
      const error: AssetSourceAuthoringError = {
        code,
        phase: code.startsWith('asset-source') || code.startsWith('asset-meta') || code.startsWith('asset-confirmation')
          ? 'preflight'
          : code === 'asset-cook-failed' ? 'cook' : 'publication',
        operationId: 'reimportAsset',
        requestId: `request-${code}`,
        subjectRef: { kind: 'asset-source', guid: 'guid', sourceKey: 'source' },
        hint: 'recover through the indexed action',
        expected: 'meta:r1',
        actual: 'meta:r0',
        retryable: true,
        recoveryActions: ['asset.preflight', 'run.get', 'run.wait', 'run.retry', 'catalog.reconcile'],
      };
      expect(recoverFromStructuredError(error)).toEqual(expect.any(String));
      expect(error.code).toBe(code);
      expect(error.subjectRef.kind).toBe('asset-source');
      expect(error.recoveryActions).toContain(recoverFromStructuredError(error));
    }
  });
});
