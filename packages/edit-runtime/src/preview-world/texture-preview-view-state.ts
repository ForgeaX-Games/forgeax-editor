// texture-preview-view-state — UE Texture Editor view controls as a typed,
// engine-agnostic projection. The preview world service owns application of
// these facts onto the disposable mini-world; toolbar state mirrors this SSOT.

export type TexturePreviewChannel = 'rgb' | 'r' | 'g' | 'b' | 'a';

/** Display color space may override the asset-authored space for inspection. */
export type TexturePreviewColorSpaceDisplay = 'asset' | 'srgb' | 'linear';

/** UE-style tiling preview repeat count (1 = single tile, 2/4 = repeat grid). */
export type TexturePreviewTiling = 1 | 2 | 4;

export interface TexturePreviewViewState {
  readonly channel: TexturePreviewChannel;
  readonly mipLevel: number;
  readonly colorSpaceDisplay: TexturePreviewColorSpaceDisplay;
  readonly tiling: TexturePreviewTiling;
  readonly checkerboardVisible: boolean;
}

export const DEFAULT_TEXTURE_PREVIEW_VIEW_STATE: TexturePreviewViewState = Object.freeze({
  channel: 'rgb',
  mipLevel: 0,
  colorSpaceDisplay: 'asset',
  tiling: 1,
  checkerboardVisible: true,
});
