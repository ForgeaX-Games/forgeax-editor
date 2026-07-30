import { describe, expect, it } from 'bun:test';
import { createAssetWorkspace } from '@forgeax/editor-core';
import { projectWorkspaceFacts } from './useWorkspaceSnapshot';

function workspaceSnapshot() {
  return createAssetWorkspace().reconcile({
    resourceRevision: 'resource:r4',
    logicalCommitId: 'commit:r4',
    subjects: [{
      id: 'asset-1',
      kind: 'imported-output',
      provenance: { owner: 'engine', source: 'asset-producer', packageId: 'package:1' },
      resourceId: 'resource:asset-1',
      path: 'assets/asset-1.pack.json',
      capabilities: { canImport: false, canMove: true, canDelete: true, canPreflight: true },
      name: 'Asset 1',
    }],
    relations: [{ kind: 'depends-on', from: 'asset-1', to: 'texture-1' }],
    issues: [{
      code: 'dirty-conflict',
      severity: 'error',
      subjectId: 'asset-1',
      message: 'The workspace changed outside the editor.',
    }],
  }).snapshot;
}

describe('workspace common fact projection', () => {
  it('keeps subject, relation, issue, and revision facts stable for UI and AI', () => {
    const snapshot = workspaceSnapshot();
    const ui = projectWorkspaceFacts(snapshot);
    const ai = projectWorkspaceFacts(snapshot);

    expect(ui).toEqual(ai);
    expect(ui.revision).toBe(snapshot.revision);
    expect(ui.identity).toBe(snapshot.identity);
    expect(ui.subjects).toEqual(snapshot.subjects);
    expect(ui.relations).toEqual(snapshot.relations);
    expect(ui.issues).toEqual(snapshot.issues);
  });

  it('does not infer identity from display path or name', () => {
    const snapshot = workspaceSnapshot();
    const projection = projectWorkspaceFacts(snapshot);
    expect(projection.subjects[0]?.id).toBe('asset-1');
    expect(projection.subjects[0]?.stableIdentity).not.toBe(projection.subjects[0]?.path);
    expect(projection.subjects[0]?.stableIdentity).not.toBe(projection.subjects[0]?.name);
  });
});
