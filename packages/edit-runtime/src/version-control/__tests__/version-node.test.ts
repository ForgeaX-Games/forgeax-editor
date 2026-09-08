import { describe, expect, it } from 'bun:test';
import type { VersionControlGraph } from '@forgeax/editor-core';
import { initialVersionTarget, isCurrentVersionNode, sortVersionNodes, versionNodeTags, versionNodeTargetOptions, versionNodeTreeEdges, versionNodeTreeRows } from '../version-node';

type Node = VersionControlGraph['nodes'][number];

function node(
  id: string,
  committedAt?: number,
  extra: Partial<Node> = {},
): Node {
  return {
    id,
    head: id.padEnd(40, '0').slice(0, 40),
    ...(committedAt === undefined ? {} : { committedAt }),
    tags: [],
    ...extra,
  };
}

describe('version-control graph node projection', () => {
  it('sorts known commit times newest first and keeps legacy nodes deterministic', () => {
    const sorted = sortVersionNodes([
      node('old', 100),
      node('new', 300),
      node('legacy', undefined),
      node('latest', undefined, { latest: true }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(['new', 'old', 'latest', 'legacy']);
  });

  it('normalizes legacy singular tags and identifies the current commit', () => {
    const tagged = node('tagged', 1, { tag: 'release/current' });
    const untagged = node('untagged', 2);
    expect(versionNodeTags(tagged)).toEqual(['release/current']);
    expect(isCurrentVersionNode(tagged, 'release/current', null)).toBe(true);
    expect(isCurrentVersionNode(untagged, 'release/current', untagged.head)).toBe(true);
    expect(isCurrentVersionNode(tagged, 'release/other', null)).toBe(false);
  });

  it('orders switch targets newest first, marks the current option, and defaults to it', () => {
    const old = node('old', 100, { tags: ['release/one'] });
    const current = node('current', 300, { tags: ['release/two'] });
    const latest = node('latest', 200, { latest: true });
    const options = versionNodeTargetOptions([old, latest, current], 'release/two', current.head);
    expect(options.map((option) => option.value)).toEqual(['release/two', '@latest', 'release/one']);
    expect(options[0]).toMatchObject({ current: true, label: `release/two (current) (${current.head.slice(0, 8)})` });
    expect(initialVersionTarget([old, latest, current], 'release/two', current.head)).toEqual({
      tag: 'release/two',
      commit: current.id,
    });
  });

  it('keeps linear history on one lane and indents only branch siblings', () => {
    const oldest = node('oldest', 100);
    const middle = node('middle', 200);
    const newest = node('newest', 300);
    const linear = versionNodeTreeRows(
      [oldest, middle, newest],
      [
        { from: newest.id, to: middle.id },
        { from: middle.id, to: oldest.id },
      ],
    );
    expect(linear.map((row) => row.depth)).toEqual([0, 0, 0]);

    const branch = node('branch', 250);
    const branched = versionNodeTreeRows(
      [oldest, newest, branch],
      [
        { from: newest.id, to: oldest.id },
        { from: branch.id, to: oldest.id },
      ],
    );
    expect(branched.map((row) => row.node.id)).toEqual(['newest', 'branch', 'oldest']);
    expect(branched.map((row) => row.depth)).toEqual([0, 1, 0]);
    expect(versionNodeTreeEdges(branched, [
      { from: newest.id, to: oldest.id },
      { from: branch.id, to: oldest.id },
    ])).toEqual([
      { from: newest.id, to: oldest.id, fromIndex: 0, toIndex: 2 },
      { from: branch.id, to: oldest.id, fromIndex: 1, toIndex: 2 },
    ]);
    expect(Math.max(...branched.map((row) => row.depth))).toBeLessThanOrEqual(3);
  });

  it('keeps a large linear history bounded and scroll-friendly', () => {
    const many = Array.from({ length: 1000 }, (_, index) => node(`commit-${index}`, index));
    const edges = many.slice(1).map((entry, index) => ({ from: entry.id, to: many[index]!.id }));
    const rows = versionNodeTreeRows(many, edges);
    expect(rows).toHaveLength(1000);
    expect(rows.every((row) => row.depth === 0)).toBe(true);
    expect(Math.max(...rows.map((row) => row.depth))).toBeLessThanOrEqual(3);
  });
});
