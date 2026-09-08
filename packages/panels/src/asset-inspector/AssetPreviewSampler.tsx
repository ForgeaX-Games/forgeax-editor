import type { ReactElement } from 'react';
import { PropertyRow } from './PropertyRow';
import { InspectorForm, InspectorSection } from './InspectorSection';
import type { PreviewProps } from './index';

export default function AssetPreviewSampler({ payload }: PreviewProps): ReactElement {
  return (
    <InspectorForm testId="preview-sampler">
      <InspectorSection id="sampler-filtering" title="Filtering" dim="type">
        <PropertyRow label="Mag Filter" value={payload.magFilter} />
        <PropertyRow label="Min Filter" value={payload.minFilter} />
        <PropertyRow label="Mipmap Filter" value={payload.mipmapFilter} />
      </InspectorSection>
      <InspectorSection id="sampler-addressing" title="Addressing" dim="all">
        <PropertyRow label="Address U" value={payload.addressModeU} />
        <PropertyRow label="Address V" value={payload.addressModeV} />
        <PropertyRow label="Address W" value={payload.addressModeW} />
      </InspectorSection>
      <InspectorSection id="sampler-lod" title="LOD & Compare" dim="cap">
        <PropertyRow label="LOD Min" value={payload.lodMinClamp} />
        <PropertyRow label="LOD Max" value={payload.lodMaxClamp} />
        <PropertyRow label="Compare" value={payload.compare} />
      </InspectorSection>
    </InspectorForm>
  );
}
