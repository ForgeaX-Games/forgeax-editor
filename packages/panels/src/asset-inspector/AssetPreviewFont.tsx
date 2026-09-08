import type { ReactElement } from 'react';
import { PropertyRow } from './PropertyRow';
import { InspectorForm, InspectorSection } from './InspectorSection';
import type { PreviewProps } from './index';

export default function AssetPreviewFont({ payload }: PreviewProps): ReactElement {
  const glyphs = payload.glyphs as Record<string, unknown> | undefined;
  const glyphCount = glyphs ? Object.keys(glyphs).length : 0;
  const common = payload.common as Record<string, unknown> | undefined;

  return (
    <InspectorForm testId="preview-font">
      <InspectorSection id="font" title="Font" dim="type">
        <PropertyRow label="Glyphs" value={glyphCount} />
        <PropertyRow label="Line Height" value={common?.lineHeight} />
      </InspectorSection>
      <InspectorSection id="font-atlas" title="Atlas" dim="all">
        <PropertyRow label="Atlas Width" value={common?.atlasWidth} />
        <PropertyRow label="Atlas Height" value={common?.atlasHeight} />
        <PropertyRow label="Distance Range" value={common?.distanceRange} />
      </InspectorSection>
    </InspectorForm>
  );
}
