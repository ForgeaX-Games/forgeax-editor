import { describe, expect, it } from 'bun:test';
import { createAssetWorkspace } from '@forgeax/editor-core';
import { buildAssetGraph } from './useAssetGraph';

function workspace() {
  const result = createAssetWorkspace().reconcile({
    resourceRevision: 'resource:r1',
    logicalCommitId: 'commit:graph',
    subjects: ['a', 'b', 'c'].map((id) => ({
      id,
      kind: 'imported-output' as const,
      provenance: { owner: 'engine' as const, source: 'asset-producer', packageId: `package:${id}` },
      resourceId: `resource:${id}`,
      path: `assets/${id}.pack.json`,
      capabilities: { canImport: false, canMove: true, canDelete: true, canPreflight: true },
    })),
    relations: [
      { kind: 'depends-on' as const, from: 'a', to: 'b' },
      { kind: 'depends-on' as const, from: 'a', to: 'c' },
    ],
    issues: [],
  });
  return result.snapshot;
}

describe('buildAssetGraph workspace projection', () => {
  it('builds forward dependency edges from refs', () => {
    const { dependencies } = buildAssetGraph(workspace());
    expect(dependencies.get('a')).toEqual(['b', 'c']);
    expect(dependencies.get('b')).toEqual([]);
  });

  it('builds reverse referencer edges', () => {
    const source = createAssetWorkspace().reconcile({
      resourceRevision: 'resource:r1', logicalCommitId: 'commit:refs',
      subjects: ['mat', 'mesh', 'tex'].map((id) => ({ id, kind: 'imported-output' as const, provenance: { owner: 'engine' as const, source: 'asset-producer' }, resourceId: id, path: id, capabilities: { canImport: false, canMove: true, canDelete: true, canPreflight: true } })),
      relations: [{ kind: 'depends-on' as const, from: 'mat', to: 'tex' }, { kind: 'depends-on' as const, from: 'mesh', to: 'mat' }, { kind: 'depends-on' as const, from: 'mesh', to: 'tex' }], issues: [],
    }).snapshot;
    const { referencers } = buildAssetGraph(source);
    expect(referencers.get('tex')?.sort()).toEqual(['mat', 'mesh']);
    expect(referencers.get('mat')).toEqual(['mesh']);
    expect(referencers.get('mesh')).toBeUndefined();
  });

  it('de-duplicates repeated forward edges', () => {
    const source = { ...workspace(), relations: [{ kind: 'depends-on' as const, from: 'a', to: 'b' }] };
    const { dependencies, referencers } = buildAssetGraph(source);
    expect(dependencies.get('a')).toEqual(['b']);
    expect(referencers.get('b')).toEqual(['a']);
  });

  it('drops self-references', () => {
    const source = { ...workspace(), relations: [{ kind: 'depends-on' as const, from: 'a', to: 'a' }, { kind: 'depends-on' as const, from: 'a', to: 'b' }] };
    const { dependencies, referencers } = buildAssetGraph(source);
    expect(dependencies.get('a')).toEqual(['b']);
    expect(referencers.get('a')).toBeUndefined();
  });

  it('handles an empty catalog', () => {
    const { dependencies, referencers } = buildAssetGraph({ ...workspace(), subjects: [], relations: [] });
    expect(dependencies.size).toBe(0);
    expect(referencers.size).toBe(0);
  });
});
