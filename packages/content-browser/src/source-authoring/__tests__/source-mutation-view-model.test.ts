import { describe, expect, it } from 'bun:test';
import {
  createSourceMutationViewModel,
  findRetryableSourceMutationRun,
  findSourceMutationRun,
  resolveSourceMutationExpectedRevision,
  resolveSourceMutationLifecycle,
  sourceMutationOperationFromRun,
  sourceMutationPreflightFromRun,
  type SourceMutationViewModelInput,
} from '../source-mutation-view-model';

const baseInput: SourceMutationViewModelInput = {
  guid: 'asset-guid',
  sourceKey: 'mesh:0',
  lifecycle: 'current',
  impact: {
    scope: { sourceKey: 'mesh:0' },
    sourceKeys: ['mesh:0'],
    affectedGuids: ['asset-guid', 'material-guid'],
    referencerGuids: ['scene-guid'],
    instanceGuids: ['instance-guid'],
    expectedRevision: 'meta:1',
  },
  operation: undefined,
  confirmation: undefined,
  now: 100,
};

describe('source mutation view model', () => {
  it('reads Meta revision, producer impact, and confirmation from the canonical preflight run', () => {
    expect(sourceMutationPreflightFromRun({
      runId: 'preflight-run',
      operationId: 'asset.preflight',
      status: 'succeeded',
      retryable: false,
      recoveryActions: [],
      result: {
        source: {
          revisionSource: 'meta',
          expectedRevision: 'meta:9',
          sourceKeys: ['mesh:0', 'material:0'],
          sourceOverrideDescriptors: [{ sourceKey: 'mesh:0', payloadSchema: { type: 'object' } }],
        },
        impact: {
          scope: { sourceKey: 'mesh:0' },
          expectedRevision: 'meta:9',
          sourceKeys: ['mesh:0'],
          affectedGuids: ['asset-guid'],
          referencerGuids: ['scene-guid'],
          instanceGuids: ['instance-guid'],
          confirmation: {
            required: true,
            token: 'confirm-impact',
            expiresAt: 200,
            expectedRevision: 'meta:9',
            scope: { sourceKey: 'mesh:0' },
            affectedGuids: ['asset-guid'],
          },
        },
      },
    })).toMatchObject({
      source: { expectedRevision: 'meta:9', sourceKeys: ['mesh:0', 'material:0'] },
      impact: { affectedGuids: ['asset-guid'], instanceGuids: ['instance-guid'] },
      confirmation: { token: 'confirm-impact' },
    });
  });

  it('keeps the Meta revision available when a failed Catalog row is missing its revision', () => {
    expect(resolveSourceMutationExpectedRevision(undefined, { expectedRevision: 'meta:7' })).toBe('meta:7');
    expect(resolveSourceMutationExpectedRevision('catalog:8', { expectedRevision: 'meta:7' })).toBe('meta:7');
    expect(resolveSourceMutationExpectedRevision(undefined, {})).toBeUndefined();
  });

  it('projects missing and failed terminal facts as failed recovery state', () => {
    expect(resolveSourceMutationLifecycle({ catalogLifecycle: 'missing', operationStatus: 'failed' })).toBe('failed');
    expect(resolveSourceMutationLifecycle({ catalogLifecycle: 'current', operationStatus: 'failed' })).toBe('failed');
    expect(resolveSourceMutationLifecycle({ catalogLifecycle: 'failed', hasLastKnownGood: true })).toBe('recoverable');
    expect(resolveSourceMutationLifecycle({ catalogLifecycle: 'cooking', operationStatus: 'running' })).toBe('cooking');
  });

  it('distinguishes current, cooking, stale, failed, and recoverable states', () => {
    for (const lifecycle of ['current', 'cooking', 'stale', 'failed', 'recoverable'] as const) {
      const view = createSourceMutationViewModel({ ...baseInput, lifecycle });
      expect(view.lifecycle).toBe(lifecycle);
      expect(view.impact.affectedGuids).toEqual(['asset-guid', 'material-guid']);
      expect(view.impact.referencerGuids).toEqual(['scene-guid']);
      expect(view.impact.instanceGuids).toEqual(['instance-guid']);
    }

    const failed = createSourceMutationViewModel({
      ...baseInput,
      lifecycle: 'failed',
      lastKnownGood: 'current:0',
      operation: {
        status: 'failed',
        error: {
          code: 'asset-cook-failed',
          phase: 'cook',
          hint: 'Retry the current revision.',
          recoveryActions: ['run.retry', 'catalog.reconcile'],
        },
      },
    });
    expect(failed.lastKnownGood).toBe('current:0');
    expect(failed.recoveryActions).toEqual(['run.retry', 'catalog.reconcile']);
    expect(failed.errorCode).toBe('asset-cook-failed');
  });

  it('requires a live confirmation token for discard and never makes an invalid action dispatchable', () => {
    const noToken = createSourceMutationViewModel({ ...baseInput, lifecycle: 'stale' });
    expect(noToken.canDiscard).toBe(false);
    expect(noToken.canReimport).toBe(true);

    const expired = createSourceMutationViewModel({
      ...baseInput,
      confirmation: { token: 'expired', expiresAt: 99, expectedRevision: 'meta:1' },
    });
    expect(expired.canDiscard).toBe(false);
    expect(expired.recoveryActions).toContain('asset.preflight');

    const valid = createSourceMutationViewModel({
      ...baseInput,
      confirmation: { token: 'valid', expiresAt: 101, expectedRevision: 'meta:1' },
    });
    expect(valid.canDiscard).toBe(true);
    expect(valid.confirmationToken).toBe('valid');
  });

  it('selects the displayed source run and preserves its real retry phase', () => {
    const runs = [
      {
        runId: 'other-asset',
        operationId: 'reimportAsset',
        status: 'failed' as const,
        retryable: true,
        input: { guid: 'other-guid', scope: { sourceKey: 'mesh:0' } },
        error: { code: 'asset-cook-failed', phase: 'cook', hint: 'Cook failed.' },
        recoveryActions: ['run.retry'],
      },
      {
        runId: 'save-failed',
        requestId: 'save-failed-request',
        operationId: 'saveAssetSourceOverride',
        status: 'failed' as const,
        retryable: true,
        input: { guid: 'asset-guid', scope: { sourceKey: 'mesh:0' } },
        error: { code: 'asset-validation-failed', phase: 'validation', hint: 'Validation failed.' },
        recoveryActions: ['run.retry', 'catalog.reconcile'],
      },
    ];

    expect(findSourceMutationRun(runs, 'asset-guid', 'mesh:0')?.runId).toBe('save-failed');
    expect(findRetryableSourceMutationRun(runs, 'asset-guid', 'mesh:0')?.requestId).toBe('save-failed-request');
    expect(findRetryableSourceMutationRun(runs, 'other-guid', 'mesh:0')?.runId).toBe('other-asset');
    expect(sourceMutationOperationFromRun(runs[1]!)).toMatchObject({
      status: 'failed',
      error: { code: 'asset-validation-failed', phase: 'validation' },
    });
  });
});
