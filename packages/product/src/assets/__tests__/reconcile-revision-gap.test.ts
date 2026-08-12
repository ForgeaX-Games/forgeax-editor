import { describe, expect, test } from 'bun:test';
import { createAssetWorkspace } from '../workspace';

describe('workspace revision-gap recovery', () => {
  test('recovers a missed event with a scoped enumerate and preserves last-known-good facts', () => {
    const workspace = createAssetWorkspace();
    const seeded = workspace.reconcile({
      resourceRevision: 'resource:r1',
      logicalCommitId: 'commit:seed',
      subjects: [{
        id: 'subject:healthy' as never,
        kind: 'internal-asset',
        provenance: { owner: 'engine', source: 'asset-producer', packageId: 'package:healthy' },
        resourceId: 'resource:healthy',
        path: 'assets/healthy.pack.json',
        capabilities: { canImport: false, canMove: true, canDelete: true, canPreflight: true },
      }],
      relations: [],
      issues: [],
    });
    const recovered = workspace.observe({
      kind: 'revision-gap',
      rootId: 'game-main',
      scope: 'assets/healthy.pack.json',
      baselineRevision: 'resource:r1',
      currentRevision: 'resource:r4',
    });

    expect(recovered.snapshot).toEqual(seeded.snapshot);
    expect(recovered.recoveryIntents).toContainEqual(expect.objectContaining({
      kind: 'scoped-reconcile',
      scope: 'assets/healthy.pack.json',
      lastKnownGoodRevision: 'resource:r1',
    }));
    expect(recovered.recoveryIntents[0]).not.toHaveProperty('fullScan', true);
  });

  test('does not turn one ordinary asset event into a full workspace scan', () => {
    const workspace = createAssetWorkspace();
    const result = workspace.observe({
      kind: 'asset-change',
      rootId: 'game-main',
      scope: 'assets/one.glb',
      resourceRevision: 'resource:r2',
    });

    expect(result.recoveryIntents).toEqual([]);
    expect(result.delta.fullScan).toBe(false);
  });
});
