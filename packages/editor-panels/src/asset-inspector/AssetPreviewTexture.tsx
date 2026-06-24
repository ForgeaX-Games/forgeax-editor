import { PropertyRow } from './PropertyRow';
import type { PreviewProps } from './index';

export default function AssetPreviewTexture({ payload }: PreviewProps) {
  return (
    <div data-testid="preview-texture">
      <div className="compname">Texture</div>
      <PropertyRow label="Width" value={payload.width} />
      <PropertyRow label="Height" value={payload.height} />
      <PropertyRow label="Format" value={payload.format} />
      <PropertyRow label="Color Space" value={payload.colorSpace} />
      <PropertyRow label="Mipmap" value={payload.mipmap != null ? String(payload.mipmap) : '—'} />
      <PropertyRow label="Mip Levels" value={payload.mipLevelCount} />
      <PropertyRow label="Sample Count" value={payload.sampleCount} />
    </div>
  );
}
