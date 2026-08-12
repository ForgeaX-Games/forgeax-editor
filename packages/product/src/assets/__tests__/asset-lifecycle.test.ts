import { describe, expect, test } from 'bun:test';
import {
  createAssetSubject,
  createAssetWorkspaceSnapshot,
  type AssetSubject,
} from '../../contracts/asset-workspace';
import { createAssetLifecycleAdapter, type AssetMutationRequest } from '../preflight';

function subject(id: string, kind: AssetSubject['kind'] = 'internal-asset'): AssetSubject {
  return createAssetSubject({
    id,
    kind,
    provenance: { owner: 'engine', source: 'producer-catalog', packageId: 'package:assets' },
    resourceId: `resource:${id}`,
    path: `assets/${id}.pack.json`,
    capabilities: {
      canImport: false,
      canMove: kind !== 'imported-output',
      canDelete: kind !== 'imported-output',
      canPreflight: true,
    },
  });
}

function createFixture() {
  let snapshot = createAssetWorkspaceSnapshot({
    revision: 'workspace:r1',
    resourceRevision: 'resource:r1',
    subjects: [subject('asset:main'), subject('asset:imported', 'imported-output')],
    relations: [],
    issues: [],
  });
  const committed: AssetMutationRequest[] = [];
  const adapter = createAssetLifecycleAdapter({
    getSnapshot: () => snapshot,
    commit: async (request) => {
      committed.push(request);
      snapshot = createAssetWorkspaceSnapshot({
        ...snapshot,
        revision: `workspace:r${committed.length + 1}`,
        resourceRevision: `resource:r${committed.length + 1}`,
      });
      return { revision: snapshot.resourceRevision, snapshot };
    },
  });
  return { adapter, committed, getSnapshot: () => snapshot };
}

describe('asset lifecycle matrix', () => {
  test('runs rename, move, delete, replace, duplicate, and reimport through preflight', async () => {
    const fixture = createFixture();
    const operations = ['rename', 'move', 'delete', 'replace', 'duplicate', 'reimport'] as const;

    for (const operation of operations) {
      const request = { operation, subjectId: 'asset:main' } as const;
      const preflight = fixture.adapter.preflight(request);
      const result = await fixture.adapter.run({
        ...request,
        expectedRevision: preflight.currentRevision,
        confirmationToken: preflight.confirmation.token,
      });

      expect(result.ok).toBe(true);
      expect(result.mutationCount).toBe(1);
    }

    expect(fixture.committed).toHaveLength(operations.length);
    expect(fixture.getSnapshot().resourceRevision).toBe('resource:r7');
  });

  test('protects imported output and leaves failed operations uncommitted', async () => {
    const fixture = createFixture();
    const preflight = fixture.adapter.preflight({ operation: 'delete', subjectId: 'asset:imported' });
    const result = await fixture.adapter.run({
      operation: 'delete',
      subjectId: 'asset:imported',
      expectedRevision: preflight.currentRevision,
      confirmationToken: preflight.confirmation.token,
    });

    expect(result.ok).toBe(false);
    expect(result.mutationCount).toBe(0);
    expect(fixture.committed).toHaveLength(0);
    expect(fixture.getSnapshot().resourceRevision).toBe('resource:r1');
  });
});
