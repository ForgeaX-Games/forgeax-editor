import { PropertyRow } from './PropertyRow';
import type { PreviewProps } from './index';

export default function AssetPreviewSampler({ payload }: PreviewProps) {
  return (
    <div data-testid="preview-sampler">
      <div className="compname">Sampler</div>
      <PropertyRow label="Mag Filter" value={payload.magFilter} />
      <PropertyRow label="Min Filter" value={payload.minFilter} />
      <PropertyRow label="Mipmap Filter" value={payload.mipmapFilter} />
      <PropertyRow label="Address U" value={payload.addressModeU} />
      <PropertyRow label="Address V" value={payload.addressModeV} />
      <PropertyRow label="Address W" value={payload.addressModeW} />
      <PropertyRow label="LOD Min" value={payload.lodMinClamp} />
      <PropertyRow label="LOD Max" value={payload.lodMaxClamp} />
      <PropertyRow label="Compare" value={payload.compare} />
    </div>
  );
}
