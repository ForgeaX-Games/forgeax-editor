// Unit tests for buildSkeletonTree (P1.4).
//
// The parser turns a flat list of `/`-separated joint paths (SkinAsset.jointPaths)
// into a nested read-only tree. These tests pin the tree shape, dedup of
// shared prefixes, ordering by first appearance, and the empty/edge cases.

import { describe, expect, it } from 'bun:test';
import { buildSkeletonTree } from '../skeleton-tree';

describe('buildSkeletonTree', () => {
  it('builds a nested tree from shared-prefix joint paths', () => {
    const tree = buildSkeletonTree(['root', 'root/spine', 'root/spine/head', 'root/leg_l']);
    expect(tree).toHaveLength(1);
    const root = tree[0]!;
    expect(root.name).toBe('root');
    expect(root.path).toBe('root');
    expect(root.children).toHaveLength(2);
    expect(root.children[0]!.name).toBe('spine');
    expect(root.children[0]!.path).toBe('root/spine');
    expect(root.children[0]!.children).toHaveLength(1);
    expect(root.children[0]!.children[0]!.name).toBe('head');
    expect(root.children[0]!.children[0]!.path).toBe('root/spine/head');
    expect(root.children[1]!.name).toBe('leg_l');
    expect(root.children[1]!.path).toBe('root/leg_l');
  });

  it('dedupes a path that was previously only an interior prefix', () => {
    // "root/spine/head" first creates root, spine, head. Then "root/spine"
    // appears as a leaf path — the node already exists; no duplicate added.
    const tree = buildSkeletonTree(['root/spine/head', 'root/spine']);
    expect(tree).toHaveLength(1);
    const root = tree[0]!;
    expect(root.name).toBe('root');
    expect(root.children).toHaveLength(1);
    expect(root.children[0]!.name).toBe('spine');
    expect(root.children[0]!.path).toBe('root/spine');
    expect(root.children[0]!.children).toHaveLength(1);
    expect(root.children[0]!.children[0]!.name).toBe('head');
  });

  it('dedupes identical paths across multiple skins', () => {
    const tree = buildSkeletonTree(['root/spine', 'root/spine', 'root/leg']);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children).toHaveLength(2);
    expect(tree[0]!.children[0]!.name).toBe('spine');
    expect(tree[0]!.children[1]!.name).toBe('leg');
  });

  it('preserves first-appearance order of root siblings', () => {
    const tree = buildSkeletonTree(['b', 'a', 'c', 'a']);
    expect(tree.map((n) => n.name)).toEqual(['b', 'a', 'c']);
  });

  it('returns an empty array for no joint paths', () => {
    expect(buildSkeletonTree([])).toEqual([]);
  });

  it('skips empty path segments (leading/trailing/double slashes)', () => {
    // Matches the engine's split('/').filter(Boolean) semantics.
    const tree = buildSkeletonTree(['/root/', '//root//spine', 'root/spine']);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.name).toBe('root');
    expect(tree[0]!.children).toHaveLength(1);
    expect(tree[0]!.children[0]!.name).toBe('spine');
  });

  it('skips a path that is only separators', () => {
    expect(buildSkeletonTree(['///', ''])).toEqual([]);
  });
});
