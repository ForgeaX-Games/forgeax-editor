import { describe, expect, test } from 'bun:test';
import {
  createAssetSubject,
  createAssetWorkspaceSnapshot,
  type AssetRelation,
  type AssetSubject,
} from '../contracts/asset-workspace';
import { preflightAssetMutation } from './preflight';

function subject(id: string, resourceId = id): AssetSubject {
  return createAssetSubject({
    id,
    kind: id.includes('reference') ? 'reference' : 'internal-asset',
    provenance: { owner: 'engine', source: 'producer-catalog', packageId: 'package:assets' },
    resourceId,
    path: `assets/${id}.pack.json`,
    capabilities: { canImport: false, canMove: true, canDelete: true, canPreflight: true },
  });
}

function snapshot() {
  const relations: readonly AssetRelation[] = [
    { kind: 'referenced-by', from: 'subject:direct-reference', to: 'subject:target' },
    { kind: 'referenced-by', from: 'subject:transitive-reference', to: 'subject:direct-reference' },
    { kind: 'depends-on', from: 'subject:target', to: 'subject:source' },
  ];
  return createAssetWorkspaceSnapshot({
    revision: 'workspace:r7',
    resourceRevision: 'resource:r7',
    subjects: [
      subject('subject:target', 'resource:target'),
      subject('subject:source', 'resource:source'),
      subject('subject:direct-reference', 'resource:direct'),
      subject('subject:transitive-reference', 'resource:transitive'),
    ],
    relations,
    issues: [],
  });
}

describe('asset preflight impact', () => {
  test('returns the complete canonical referencer closure and resources', () => {
    const result = preflightAssetMutation(snapshot(), {
      operation: 'delete',
      subjectId: 'subject:target',
    });

    expect(result.ok).toBe(true);
    expect(result.subjectRef).toBe('subject:target');
    expect(result.impact.referencerIds).toEqual([
      'subject:direct-reference',
      'subject:transitive-reference',
    ]);
    expect(result.impact.affectedResourceIds).toEqual([
      'resource:direct',
      'resource:target',
      'resource:transitive',
    ]);
    expect(result.currentRevision).toBe('resource:r7');
    expect(result.recoveryActions.length).toBeGreaterThan(0);
  });
});
