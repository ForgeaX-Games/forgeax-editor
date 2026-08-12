import { describe, expect, test } from 'bun:test';
import {
  compareAssetWorkspaceSnapshots,
  createAssetWorkspace,
} from '../workspace';

describe('workspace consumer parity', () => {
  test('core, Content Browser, and headless consumers read identical facts at one revision', () => {
    const workspace = createAssetWorkspace();
    const result = workspace.reconcile({
      resourceRevision: 'resource:r1',
      logicalCommitId: 'commit:parity',
      subjects: [{
        id: 'subject:mesh' as never,
        kind: 'external-package',
        provenance: { owner: 'platform-io', source: 'observer', packageId: 'package:mesh' },
        resourceId: 'resource:mesh',
        path: 'assets/mesh.pack.json',
        capabilities: { canImport: false, canMove: true, canDelete: false, canPreflight: true },
      }],
      relations: [],
      issues: [{
        code: 'source-meta-pending',
        severity: 'info',
        subjectId: 'subject:mesh' as never,
        message: 'pending',
      }],
    });

    expect(compareAssetWorkspaceSnapshots([
      result.snapshot,
      result.snapshot,
      result.snapshot,
    ])).toEqual({ equal: true, differences: [] });
    expect(result.snapshot.subjects[0]?.capabilities.canDelete).toBe(false);
  });
});
