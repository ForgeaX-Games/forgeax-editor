import { describe, expect, test } from 'bun:test';
import {
  ASSET_WORKSPACE_SCHEMA_VERSION,
  createAssetWorkspaceSnapshot,
  createAssetSubject,
  type AssetRelation,
  type AssetWorkspaceIssue,
} from '../asset-workspace';

const relation: AssetRelation = {
  kind: 'depends-on',
  from: 'subject:mesh' as never,
  to: 'subject:material' as never,
};

const issue: AssetWorkspaceIssue = {
  code: 'source-meta-pending',
  severity: 'info',
  subjectId: 'subject:mesh' as never,
  message: 'Source and metadata are waiting for the same settled batch.',
};

function subject(path: string, id: string) {
  return createAssetSubject({
    id: id as never,
    kind: 'imported-output',
    provenance: {
      owner: 'engine',
      source: 'asset-producer',
      packageId: 'package:mesh',
    },
    resourceId: `resource:${id}`,
    path,
    capabilities: {
      canImport: false,
      canMove: true,
      canDelete: false,
      canPreflight: true,
    },
  });
}

describe('AssetWorkspaceSnapshot contract', () => {
  test('carries stable subject identity, provenance, typed relations, issues, and resource revision', () => {
    const mesh = subject('assets/mesh-a.pack.json', 'subject:mesh');
    const material = subject('assets/material.pack.json', 'subject:material');
    const snapshot = createAssetWorkspaceSnapshot({
      revision: 'workspace:r1',
      resourceRevision: 'resource:r7',
      subjects: [mesh, material],
      relations: [relation],
      issues: [issue],
    });

    expect(snapshot).toMatchObject({
      schemaVersion: ASSET_WORKSPACE_SCHEMA_VERSION,
      revision: 'workspace:r1',
      resourceRevision: 'resource:r7',
      subjects: [mesh, material],
      relations: [relation],
      issues: [issue],
    });
    expect(snapshot.identity).toMatch(/^workspace-snapshot:/);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  test('keeps snapshot identity stable when facts are unchanged and independent of path or array position', () => {
    const first = createAssetWorkspaceSnapshot({
      revision: 'workspace:r1',
      resourceRevision: 'resource:r7',
      subjects: [subject('assets/mesh-a.pack.json', 'subject:mesh')],
      relations: [],
      issues: [],
    });
    const reorderedPath = createAssetWorkspaceSnapshot({
      revision: 'workspace:r1',
      resourceRevision: 'resource:r7',
      subjects: [subject('renamed/mesh.pack.json', 'subject:mesh')],
      relations: [],
      issues: [],
    });
    expect(reorderedPath.identity).toBe(first.identity);
  });
});
