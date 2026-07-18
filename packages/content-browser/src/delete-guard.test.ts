import { describe, expect, it } from 'bun:test';
import { buildAssetGraph } from './hooks/useAssetGraph';
import { computeDeleteImpact } from './delete-guard';

// tex ← mat ← mesh ; standalone has no referencers.
const graph = buildAssetGraph([
  { guid: 'mesh', refs: ['mat'] },
  { guid: 'mat', refs: ['tex'] },
  { guid: 'tex', refs: [] },
  { guid: 'standalone', refs: [] },
]);

describe('computeDeleteImpact', () => {
  it('flags a target still referenced from outside the batch', () => {
    const impact = computeDeleteImpact(['tex'], graph);
    expect(impact.hasExternalReferencers).toBe(true);
    expect(impact.externalReferencers.get('tex')).toEqual(['mat']);
    expect(impact.externalReferencerCount).toBe(1);
  });

  it('reports no impact for an unreferenced target', () => {
    const impact = computeDeleteImpact(['standalone'], graph);
    expect(impact.hasExternalReferencers).toBe(false);
    expect(impact.externalReferencers.size).toBe(0);
    expect(impact.externalReferencerCount).toBe(0);
  });

  it('ignores referencers that are part of the same delete batch', () => {
    // Deleting mat + tex together: mat references tex, but mat is also going, so
    // tex has no *external* referencer.
    const impact = computeDeleteImpact(['mat', 'tex'], graph);
    expect(impact.externalReferencers.get('tex')).toBeUndefined();
    // mat is still referenced by mesh (outside the batch).
    expect(impact.externalReferencers.get('mat')).toEqual(['mesh']);
    expect(impact.hasExternalReferencers).toBe(true);
  });

  it('counts distinct external referencers across targets', () => {
    const g = buildAssetGraph([
      { guid: 'consumer', refs: ['x', 'y'] },
      { guid: 'x', refs: [] },
      { guid: 'y', refs: [] },
    ]);
    const impact = computeDeleteImpact(['x', 'y'], g);
    // Both x and y are referenced by the same consumer → distinct count is 1.
    expect(impact.externalReferencerCount).toBe(1);
  });
});
