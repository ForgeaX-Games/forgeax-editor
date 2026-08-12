import { describe, expect, test } from 'bun:test';
import { createAssetSubject, createAssetWorkspaceSnapshot } from '../../contracts/asset-workspace';
import { createAssetLifecycleAdapter, preflightAssetMutation } from '../preflight';
import { reconcileImportedTopology } from '../subject-capability';

function snapshot() {
  return createAssetWorkspaceSnapshot({
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
}

describe('asset mutation rollback matrix', () => {
  test('confirmation failure keeps every destructive operation at zero mutations', async () => {
    let commits = 0;
    const adapter = createAssetLifecycleAdapter({
      getSnapshot: snapshot,
      commit: async () => {
        commits += 1;
        return { revision: 'resource:bad' };
      },
    });

    for (const operation of ['rename', 'move', 'delete', 'replace', 'reimport'] as const) {
      const result = await adapter.run({ operation, subjectId: 'subject:asset' });
      expect(result.ok).toBe(false);
      expect(result.mutationCount).toBe(0);
    }
    expect(commits).toBe(0);
  });

  test('resource failure exposes restore recovery and preserves the old snapshot', async () => {
    const before = snapshot();
    const adapter = createAssetLifecycleAdapter({
      getSnapshot: () => before,
      commit: async () => { throw new Error('resource write failed'); },
    });
    const request = { operation: 'replace', subjectId: 'subject:asset' } as const;
    const preflight = preflightAssetMutation(before, request);
    const result = await adapter.run({ ...request, confirmationToken: preflight.confirmation.token });

    expect(result.ok).toBe(false);
    expect(result.mutationCount).toBe(0);
    expect(result.snapshot).toEqual(before);
    expect(preflight.recoveryActions).toContain('asset.restore');
  });

  test('ambiguous topology keeps the old reference available for explicit recovery', () => {
    const result = reconcileImportedTopology({
      previous: [{ subjectId: 'subject:old', kind: 'mesh', sourceIndex: 0 }],
      next: [
        { subjectId: 'subject:left', kind: 'mesh', sourceIndex: 0 },
        { subjectId: 'subject:right', kind: 'mesh', sourceIndex: 0 },
      ],
      references: [{ referenceId: 'reference:old', subjectId: 'subject:old' }],
    });

    expect(result.status).toBe('ambiguous');
    expect(result.preservedReferences).toEqual([{ referenceId: 'reference:old', subjectId: 'subject:old' }]);
  });
});
