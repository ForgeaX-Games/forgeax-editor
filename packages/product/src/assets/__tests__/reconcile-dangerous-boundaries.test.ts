import { describe, expect, test } from 'bun:test';
import {
  createAssetWorkspace,
  type AssetWorkspaceObservation,
} from '../workspace';

function observe(observation: AssetWorkspaceObservation) {
  return createAssetWorkspace().observe(observation);
}

describe('workspace dangerous external boundaries', () => {
  test('keeps orphan metadata and source-only observations without implicit mutation', () => {
    const orphan = observe({
      kind: 'source-meta',
      sourcePath: 'assets/missing.glb',
      sourcePresent: false,
      metaPresent: true,
      logicalBatchId: 'batch:missing',
    });
    const sourceOnly = observe({
      kind: 'source-meta',
      sourcePath: 'assets/new.glb',
      sourcePresent: true,
      metaPresent: false,
      logicalBatchId: 'batch:new',
    });

    expect(orphan.issues.map(issue => issue.code)).toContain('orphan-meta');
    expect(sourceOnly.issues.map(issue => issue.code)).toContain('source-only');
    expect(orphan.mutationCount).toBe(0);
    expect(sourceOnly.mutationCount).toBe(0);
    expect(orphan.recoveryIntents[0]?.kind).toBe('await-source');
  });

  test('quarantines GUID collisions without selecting an arbitrary winner', () => {
    const result = observe({
      kind: 'guid-collision',
      guid: 'guid:collision',
      subjectIds: ['subject:left' as never, 'subject:right' as never],
      paths: ['assets/left.pack.json', 'assets/right.pack.json'],
    });

    expect(result.status).toBe('quarantined');
    expect(result.collisionWinner).toBeUndefined();
    expect(result.recoveryIntents[0]?.kind).toBe('resolve-collision');
    expect(result.mutationCount).toBe(0);
  });

  test('isolates malformed packages while retaining healthy facts and last-known-good state', () => {
    const workspace = createAssetWorkspace();
    const healthy = workspace.reconcile({
      resourceRevision: 'resource:healthy',
      logicalCommitId: 'commit:healthy',
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
    const malformed = workspace.observe({
      kind: 'malformed-package',
      packageId: 'package:broken',
      path: 'assets/broken.pack.json',
      reason: 'invalid package schema',
    });

    expect(malformed.status).toBe('quarantined');
    expect(malformed.snapshot.subjects).toEqual(healthy.snapshot.subjects);
    expect(malformed.snapshot.identity).toBe(healthy.snapshot.identity);
    expect(malformed.snapshot.issues).toContainEqual(expect.objectContaining({ code: 'malformed-package' }));
    expect(malformed.recoveryIntents[0]?.kind).toBe('quarantine-package');
  });

  test('turns VCS bursts, late roots, missed events, and dirty conflicts into scoped recovery facts', () => {
    const workspace = createAssetWorkspace();
    for (const kind of ['vcs-burst', 'late-root', 'event-gap'] as const) {
      const result = workspace.observe({ kind, rootId: 'game-main', scope: 'assets' });
      expect(result.recoveryIntents[0]).toMatchObject({ kind: 'scoped-reconcile', scope: 'assets' });
      expect(result.recoveryIntents[0]).not.toHaveProperty('fullScan', true);
    }
    const conflict = workspace.observe({
      kind: 'dirty-conflict',
      subjectId: 'subject:healthy' as never,
      expectedRevision: 'resource:r1',
      actualRevision: 'resource:r2',
    });
    expect(conflict.issues).toContainEqual(expect.objectContaining({ code: 'dirty-conflict' }));
    expect(conflict.mutationCount).toBe(0);
  });
});
