import { describe, expect, test } from 'bun:test';
import { createAssetSubject, createAssetWorkspaceSnapshot } from '@forgeax/editor-product';
import { createAssetMutationSafetyAdapter } from '../product/asset-producer-adapter';

function snapshot() {
  return createAssetWorkspaceSnapshot({
    revision: 'workspace:r4',
    resourceRevision: 'resource:r4',
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

describe('core asset mutation safety seam', () => {
  test('does not invoke the canonical producer for stale revision or missing confirmation', async () => {
    let mutationCount = 0;
    const adapter = createAssetMutationSafetyAdapter({
      snapshot: snapshot(),
      commit: async () => {
        mutationCount += 1;
        return { revision: 'resource:r5' };
      },
    });

    const stale = await adapter.run({
      operation: 'delete',
      subjectId: 'subject:asset',
      expectedRevision: 'resource:old',
    });
    const unconfirmed = await adapter.run({ operation: 'delete', subjectId: 'subject:asset' });

    expect(stale.ok).toBe(false);
    expect(unconfirmed.ok).toBe(false);
    expect(mutationCount).toBe(0);
  });
});
