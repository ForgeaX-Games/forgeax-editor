import type { ReactElement } from 'react';
import { PropertyRow } from './PropertyRow';
import { InspectorForm, InspectorSection } from './InspectorSection';
import type { PreviewProps } from './index';

export default function AssetPreviewSkin({ payload }: PreviewProps): ReactElement {
  const jointPaths = Array.isArray(payload.jointPaths) ? payload.jointPaths.length : 0;

  return (
    <InspectorForm testId="preview-skin">
      <InspectorSection id="skin" title="Skin" dim="type">
        <PropertyRow label="Skeleton GUID" value={payload.skeletonGuid} />
        <PropertyRow label="Joint Paths" value={jointPaths} />
      </InspectorSection>
    </InspectorForm>
  );
}
