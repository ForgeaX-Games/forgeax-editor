import { describe, expect, it } from 'bun:test';
import { reuseFbxSubAssetGuids } from '../assets/fbx-cook';

describe('FBX reimport sub-asset identity', () => {
  const old = [
    { kind: 'material', sourceIndex: 0, sourceKey: 'fbx:material:Body', guid: 'guid-body' },
    { kind: 'material', sourceIndex: 1, sourceKey: 'fbx:material:Trim', guid: 'guid-trim' },
  ];

  it('mints inserted outputs and reuses moved outputs only by sourceKey', () => {
    const result = reuseFbxSubAssetGuids([
      { kind: 'material', sourceIndex: 0, sourceKey: 'fbx:material:Accent', guid: 'guid-new' },
      { kind: 'material', sourceIndex: 1, sourceKey: 'fbx:material:Body', guid: 'fresh-body' },
      { kind: 'material', sourceIndex: 2, sourceKey: 'fbx:material:Trim', guid: 'fresh-trim' },
    ], old);

    expect(result.map((entry) => entry.guid)).toEqual(['guid-new', 'guid-body', 'guid-trim']);
    expect(new Set(result.map((entry) => entry.guid)).size).toBe(result.length);
  });

  it('keeps remaining identities stable across deletion and reorder', () => {
    const result = reuseFbxSubAssetGuids([
      { kind: 'material', sourceIndex: 0, sourceKey: 'fbx:material:Trim', guid: 'fresh-trim' },
      { kind: 'material', sourceIndex: 1, sourceKey: 'fbx:material:Body', guid: 'fresh-body' },
    ], old);

    expect(result.map((entry) => entry.guid)).toEqual(['guid-trim', 'guid-body']);
  });

  it('uses position only for a legacy sidecar without sourceKey metadata', () => {
    const result = reuseFbxSubAssetGuids([
      { kind: 'material', sourceIndex: 0, sourceKey: 'fbx:material:Body', guid: 'fresh' },
    ], [{ kind: 'material', sourceIndex: 0, guid: 'legacy-guid' }]);

    expect(result[0]?.guid).toBe('legacy-guid');
  });
});
