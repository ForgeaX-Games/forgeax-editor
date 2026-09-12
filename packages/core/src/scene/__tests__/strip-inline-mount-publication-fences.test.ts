import { describe, expect, it } from 'bun:test';
import { stripInlinePackMountPublicationFences } from '../strip-inline-mount-publication-fences';

const ROOT = 'b60b4bc5-c61e-4104-a842-acf373692c29';
const INLINE = '586251cb-fb0d-4e84-9373-f91e10711859';
const EXTERNAL = 'aaaaaaaa-bbbb-4ccc-dddd-000000000099';

describe('stripInlinePackMountPublicationFences', () => {
  it('removes publicationFence from mounts sourced to another asset in the same pack', () => {
    const packObj = {
      assets: [
        {
          guid: ROOT,
          kind: 'scene',
          refs: [INLINE],
          payload: {
            mounts: [{
              localId: 0,
              source: 0,
              publicationFence: { schemaVersion: 'scene-publication-fence/1' },
            }],
          },
        },
        { guid: INLINE, kind: 'scene', refs: [], payload: { mounts: [] } },
      ],
    };
    stripInlinePackMountPublicationFences(packObj);
    expect(packObj.assets[0]!.payload.mounts[0]!.publicationFence).toBeUndefined();
  });

  it('keeps publicationFence when mount source is not an inline pack asset', () => {
    const fence = { schemaVersion: 'scene-publication-fence/1', sourcePath: 'assets/other.pack.json' };
    const packObj = {
      assets: [
        {
          guid: ROOT,
          kind: 'scene',
          refs: [EXTERNAL],
          payload: { mounts: [{ localId: 0, source: EXTERNAL, publicationFence: fence }] },
        },
      ],
    };
    stripInlinePackMountPublicationFences(packObj);
    expect(packObj.assets[0]!.payload.mounts[0]!.publicationFence).toEqual(fence);
  });
});
