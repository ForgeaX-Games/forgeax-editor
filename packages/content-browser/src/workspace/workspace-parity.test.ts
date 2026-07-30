import { describe, expect, test } from 'bun:test';
import { createAssetWorkspace, type AssetWorkspaceSnapshot } from '@forgeax/editor-core';
import { projectWorkspaceSnapshot } from './useWorkspaceSnapshot';

function snapshot(): AssetWorkspaceSnapshot {
  const workspace = createAssetWorkspace();
  workspace.reconcile({
    resourceRevision: 'resource:r1',
    logicalCommitId: 'commit:parity',
    subjects: [{
      id: 'subject:mesh' as never,
      kind: 'imported-output',
      provenance: { owner: 'engine', source: 'asset-producer', packageId: 'package:mesh' },
      resourceId: 'resource:mesh',
      path: 'assets/mesh.pack.json',
      capabilities: { canImport: false, canMove: true, canDelete: false, canPreflight: true },
    }],
    relations: [{ kind: 'depends-on', from: 'subject:mesh' as never, to: 'subject:material' as never }],
    issues: [],
  });
  return workspace.snapshot();
}

describe('Content Browser workspace projection', () => {
  test('projects facts without rebuilding an AssetGraph or changing the subject identity', () => {
    const source = snapshot();
    const projected = projectWorkspaceSnapshot(source);

    expect(projected.revision).toBe(source.revision);
    expect(projected.identity).toBe(source.identity);
    expect(projected.subjects).toEqual(source.subjects);
    expect(projected.relations).toEqual(source.relations);
    expect(projected.issues).toEqual(source.issues);
    expect(projected).not.toHaveProperty('graph');
  });
});
