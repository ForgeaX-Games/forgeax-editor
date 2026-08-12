import { describe, expect, test } from 'bun:test';
import { createAssetSubject, createAssetWorkspaceSnapshot } from '../../contracts/asset-workspace';
import { preflightAssetMutation } from '../preflight';

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

describe('asset preflight revision and conflict gates', () => {
  test('rejects an expired revision before mutation and exposes recovery data', () => {
    const result = preflightAssetMutation(snapshot(), {
      operation: 'delete',
      subjectId: 'subject:asset',
      expectedRevision: 'resource:old',
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('revision-conflict');
    expect(result.error?.expected).toBe('resource:old');
    expect(result.error?.current).toBe('resource:r4');
    expect(result.error?.subjectRef).toBe('subject:asset');
    expect(result.error?.recoveryActions).toContain('asset.preflight');
  });

  test('rejects owner and root scope conflicts without choosing a winner', () => {
    const ownerConflict = preflightAssetMutation(
      snapshot(),
      { operation: 'move', subjectId: 'subject:asset', owner: 'actor:incoming' },
      { currentOwner: 'actor:existing' },
    );
    const scopeConflict = preflightAssetMutation(
      snapshot(),
      { operation: 'move', subjectId: 'subject:asset', scope: 'root:other' },
      { scope: 'root:one' },
    );

    expect(ownerConflict.ok).toBe(false);
    expect(ownerConflict.error?.code).toBe('owner-conflict');
    expect(scopeConflict.ok).toBe(false);
    expect(scopeConflict.error?.code).toBe('scope-conflict');
    expect(ownerConflict.error?.recoveryActions).toContain('asset.preflight');
    expect(scopeConflict.error?.recoveryActions).toContain('asset.preflight');
  });
});
