import { describe, expect, test } from 'bun:test';
import {
  createAssetWorkspace,
  type AssetWorkspaceInput,
} from '../workspace';

function input(resourceRevision: string, logicalCommitId?: string): AssetWorkspaceInput {
  return {
    resourceRevision,
    logicalCommitId,
    subjects: [{
      id: 'subject:mesh' as never,
      kind: 'imported-output',
      provenance: { owner: 'engine', source: 'asset-producer', packageId: 'package:mesh' },
      resourceId: 'resource:mesh',
      path: 'assets/mesh.pack.json',
      capabilities: { canImport: false, canMove: true, canDelete: false, canPreflight: true },
    }],
    relations: [],
    issues: [],
  };
}

describe('AssetWorkspace snapshot lifecycle', () => {
  test('changes workspace revision once for one logical commit', () => {
    const workspace = createAssetWorkspace();
    const first = workspace.reconcile(input('resource:r1', 'commit:1'));
    const repeated = workspace.reconcile(input('resource:r1', 'commit:1'));

    expect(first.delta.revisionChanged).toBe(true);
    expect(repeated.delta.revisionChanged).toBe(false);
    expect(repeated.snapshot.revision).toBe(first.snapshot.revision);
    expect(repeated.snapshot.identity).toBe(first.snapshot.identity);
  });

  test('exposes the same facts for a stable revision', () => {
    const workspace = createAssetWorkspace();
    const result = workspace.reconcile(input('resource:r1', 'commit:1'));
    const snapshot = workspace.snapshot();

    expect(snapshot).toEqual(result.snapshot);
    expect(snapshot.subjects[0]?.id).toBe('subject:mesh');
    expect(snapshot.resourceRevision).toBe('resource:r1');
    expect(snapshot.relations).toEqual([]);
    expect(snapshot.issues).toEqual([]);
  });
});
