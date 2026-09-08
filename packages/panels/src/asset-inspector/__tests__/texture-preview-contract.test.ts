import { describe, expect, it } from 'bun:test';
import { projectTexturePreview } from '../AssetPreviewTexture';

describe('Texture Inspector Engine primitive contract', () => {
  it('projects real texture facts without inventing a fallback subject', () => {
    const projection = projectTexturePreview('tex-1', {
      kind: 'texture',
      width: 8,
      height: 4,
      format: 'rgba8unorm',
      colorSpace: 'srgb',
      mipmap: true,
      mipLevelCount: 3,
      data: new Uint8Array(8 * 4 * 4),
    });

    expect(projection).toMatchObject({
      operationId: 'texture.preview',
      source: 'engine',
      subject: { kind: 'TextureAsset', guid: 'tex-1' },
      binding: {
        guid: 'tex-1',
        width: 8,
        height: 4,
        format: 'rgba8unorm',
        colorSpace: 'srgb',
        alpha: true,
        mipLevels: 3,
        channels: 4,
      },
    });
  });

  it('returns a structured unavailable projection for incomplete payloads', () => {
    expect(projectTexturePreview('missing', { kind: 'texture' })).toMatchObject({
      ok: false,
      code: 'texture-preview-binding-unavailable',
    });
  });
});
