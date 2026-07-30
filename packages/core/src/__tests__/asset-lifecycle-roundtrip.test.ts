import { describe, expect, test } from 'bun:test';
import { createAssetSubject, createAssetWorkspaceSnapshot } from '@forgeax/editor-product';
import { createAssetMutationSafetyAdapter } from '../product/asset-producer-adapter';

describe('core asset lifecycle roundtrip', () => {
  test('publishes one resource revision only after the safety gate succeeds', async () => {
    let revision = 'resource:r1';
    let commits = 0;
    const adapter = createAssetMutationSafetyAdapter({
      snapshot: createAssetWorkspaceSnapshot({
        revision: 'workspace:r1',
        resourceRevision: revision,
        subjects: [
          createAssetSubject({
            id: 'asset:main',
            kind: 'internal-asset',
            provenance: { owner: 'engine', source: 'producer-catalog' },
            resourceId: 'resource:main',
            path: 'assets/main.pack.json',
            capabilities: { canImport: false, canMove: true, canDelete: true, canPreflight: true },
          }),
        ],
        relations: [],
        issues: [],
      }),
      commit: async () => {
        commits += 1;
        revision = `resource:r${commits + 1}`;
        return { revision };
      },
    });

    const preflight = adapter.preflight({ operation: 'replace', subjectId: 'asset:main' });
    const result = await adapter.run({
      operation: 'replace',
      subjectId: 'asset:main',
      expectedRevision: preflight.currentRevision,
      confirmationToken: preflight.confirmation.token,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.revision).toBe('resource:r2');
    expect(commits).toBe(1);
  });
});
