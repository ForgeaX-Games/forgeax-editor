import { describe, expect, test } from 'bun:test';
import { createAssetSubject, createAssetWorkspaceSnapshot } from '@forgeax/editor-product';
import { createAssetMutationSafetyAdapter } from '../product/asset-producer-adapter';

describe('core asset mutation rollback', () => {
  test('resource transaction failure does not publish a second resource or authored effect', async () => {
    let commits = 0;
    const snapshot = createAssetWorkspaceSnapshot({
      revision: 'workspace:r1',
      resourceRevision: 'resource:r1',
      subjects: [
        createAssetSubject({
          id: 'subject:asset',
          kind: 'internal-asset',
          provenance: { owner: 'engine', source: 'producer-catalog' },
          resourceId: 'resource:asset',
          path: 'assets/asset.pack.json',
          capabilities: { canImport: false, canMove: true, canDelete: true, canPreflight: true },
        }),
      ],
      relations: [],
      issues: [],
    });
    const adapter = createAssetMutationSafetyAdapter({
      snapshot,
      commit: async () => {
        commits += 1;
        throw new Error('second resource failed');
      },
    });
    const preflight = adapter.preflight({ operation: 'delete', subjectId: 'subject:asset' });
    const result = await adapter.run({
      operation: 'delete',
      subjectId: 'subject:asset',
      confirmationToken: preflight.confirmation.token,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('rollback unexpectedly succeeded');
    expect(result.error.code).toBe('resource-transaction-failed');
    expect(result.mutationCount).toBe(0);
    expect(result.snapshot.resourceRevision).toBe('resource:r1');
    expect(commits).toBe(1);
  });
});
