import { PropertyRow } from './PropertyRow';
import type { PreviewProps } from './index';

export default function AssetPreviewFont({ payload }: PreviewProps) {
  const glyphs = payload.glyphs as Record<string, unknown> | undefined;
  const glyphCount = glyphs ? Object.keys(glyphs).length : 0;
  const common = payload.common as Record<string, unknown> | undefined;

  return (
    <div data-testid="preview-font">
      <div className="compname">Font</div>
      <PropertyRow label="Glyphs" value={glyphCount} />
      <PropertyRow label="Line Height" value={common?.lineHeight} />
      <PropertyRow label="Atlas Width" value={common?.atlasWidth} />
      <PropertyRow label="Atlas Height" value={common?.atlasHeight} />
      <PropertyRow label="Distance Range" value={common?.distanceRange} />
    </div>
  );
}
