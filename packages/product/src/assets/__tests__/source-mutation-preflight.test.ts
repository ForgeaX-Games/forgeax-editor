import { describe, expect, test } from 'bun:test';
import {
  preflightAssetSourceMutation,
  type AssetSourceMutationSnapshot,
} from '../preflight';

function snapshot(): AssetSourceMutationSnapshot {
  return {
    metaRevision: 'meta:r7',
    outputs: [
      {
        guid: 'guid:mesh',
        sourceKey: 'source:mesh',
        referencerGuids: ['guid:scene-a', 'guid:scene-b'],
        instanceGuids: ['instance:scene-a'],
      },
      {
        guid: 'guid:material',
        sourceKey: 'source:material',
        referencerGuids: ['guid:scene-a'],
        instanceGuids: ['instance:scene-a', 'instance:scene-b'],
      },
      {
        guid: 'guid:promoted',
        sourceKey: 'source:mesh',
        referencerGuids: [],
        instanceGuids: [],
        promoted: true,
      },
    ],
  };
}

describe('source mutation preflight', () => {
  test('returns one source impact from an exact sourceKey scope', () => {
    const result = preflightAssetSourceMutation(snapshot(), {
      guid: 'guid:mesh',
      scope: { sourceKey: 'source:mesh' },
    });

    expect(result.ok).toBe(true);
    expect(result.expectedRevision).toBe('meta:r7');
    expect(result.sourceKeys).toEqual(['source:mesh']);
    expect(result.affectedGuids).toEqual(['guid:mesh']);
    expect(result.referencerGuids).toEqual(['guid:scene-a', 'guid:scene-b']);
    expect(result.instanceGuids).toEqual(['instance:scene-a']);
    expect(result.risks).toEqual([]);
  });

  test('returns the complete impact only when all scope is explicit', () => {
    const result = preflightAssetSourceMutation(snapshot(), {
      guid: 'guid:mesh',
      scope: { all: true },
    });

    expect(result.ok).toBe(true);
    expect(result.sourceKeys).toEqual(['source:material', 'source:mesh']);
    expect(result.affectedGuids).toEqual(['guid:material', 'guid:mesh']);
    expect(result.referencerGuids).toEqual(['guid:scene-a', 'guid:scene-b']);
    expect(result.instanceGuids).toEqual(['instance:scene-a', 'instance:scene-b']);
    expect(result.risks).toEqual([]);
  });

  test('fails closed for a sourceKey that is not in the producer snapshot', () => {
    const result = preflightAssetSourceMutation(snapshot(), {
      guid: 'guid:mesh',
      scope: { sourceKey: 'source:missing' },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('asset-source-key-unknown');
    expect(result.error?.recoveryActions).toContain('asset.preflight');
  });
});
