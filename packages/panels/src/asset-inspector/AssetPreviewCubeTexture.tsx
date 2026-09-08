import type { ReactElement } from 'react';
import { PropertyRow } from './PropertyRow';
import { InspectorForm, InspectorSection } from './InspectorSection';
import type { PreviewProps } from './index';

export default function AssetPreviewCubeTexture({ payload }: PreviewProps): ReactElement {
  const faces = Array.isArray(payload.faces) ? payload.faces.length : 0;

  return (
    <InspectorForm testId="preview-cube-texture">
      <InspectorSection id="cube-texture" title="Cube Texture" dim="type">
        <PropertyRow label="Width" value={payload.width} />
        <PropertyRow label="Height" value={payload.height} />
        <PropertyRow label="Format" value={payload.format} />
        <PropertyRow label="Faces" value={faces} />
      </InspectorSection>
    </InspectorForm>
  );
}
