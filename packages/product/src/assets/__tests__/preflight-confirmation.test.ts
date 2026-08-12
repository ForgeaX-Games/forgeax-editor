import { describe, expect, test } from 'bun:test';
import { createAssetSubject, createAssetWorkspaceSnapshot } from '../../contracts/asset-workspace';
import { authorizeAssetMutation, preflightAssetMutation } from '../preflight';

function snapshot() {
  return createAssetWorkspaceSnapshot({
    revision: 'workspace:r3',
    resourceRevision: 'resource:r3',
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

describe('asset preflight confirmation', () => {
  test('requires explicit confirmation for every destructive operation', () => {
    for (const operation of ['rename', 'move', 'delete', 'replace', 'reimport'] as const) {
      const result = preflightAssetMutation(snapshot(), { operation, subjectId: 'subject:asset' });
      expect(result.confirmation.required).toBe(true);
      expect(result.confirmation.token).toMatch(/^asset-confirmation:/);
    }
  });

  test('missing or mismatched confirmation authorizes zero mutations', () => {
    const result = preflightAssetMutation(snapshot(), { operation: 'delete', subjectId: 'subject:asset' });

    expect(authorizeAssetMutation(result).mutationCount).toBe(0);
    expect(authorizeAssetMutation(result, 'asset-confirmation:wrong').mutationCount).toBe(0);
    expect(authorizeAssetMutation(result).ok).toBe(false);
  });
});
