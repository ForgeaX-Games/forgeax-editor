import { describe, expect, it } from 'bun:test';
import { buildAssetGraph } from './useAssetGraph';

describe('buildAssetGraph', () => {
  it('builds forward dependency edges from refs', () => {
    const { dependencies } = buildAssetGraph([
      { guid: 'a', refs: ['b', 'c'] },
      { guid: 'b', refs: [] },
      { guid: 'c', refs: [] },
    ]);
    expect(dependencies.get('a')).toEqual(['b', 'c']);
    expect(dependencies.get('b')).toEqual([]);
  });

  it('builds reverse referencer edges', () => {
    const { referencers } = buildAssetGraph([
      { guid: 'mat', refs: ['tex'] },
      { guid: 'mesh', refs: ['mat', 'tex'] },
      { guid: 'tex', refs: [] },
    ]);
    expect(referencers.get('tex')?.sort()).toEqual(['mat', 'mesh']);
    expect(referencers.get('mat')).toEqual(['mesh']);
    expect(referencers.get('mesh')).toBeUndefined();
  });

  it('de-duplicates repeated forward edges', () => {
    const { dependencies, referencers } = buildAssetGraph([
      { guid: 'a', refs: ['b', 'b', 'b'] },
    ]);
    expect(dependencies.get('a')).toEqual(['b']);
    expect(referencers.get('b')).toEqual(['a']);
  });

  it('drops self-references', () => {
    const { dependencies, referencers } = buildAssetGraph([
      { guid: 'a', refs: ['a', 'b'] },
    ]);
    expect(dependencies.get('a')).toEqual(['b']);
    expect(referencers.get('a')).toBeUndefined();
  });

  it('handles an empty catalog', () => {
    const { dependencies, referencers } = buildAssetGraph([]);
    expect(dependencies.size).toBe(0);
    expect(referencers.size).toBe(0);
  });
});
