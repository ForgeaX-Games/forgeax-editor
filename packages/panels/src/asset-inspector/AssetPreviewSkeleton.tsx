import type { ReactElement } from 'react';
import { PropertyRow } from './PropertyRow';
import { InspectorForm, InspectorSection } from './InspectorSection';
import type { PreviewProps } from './index';

export default function AssetPreviewSkeleton({ payload }: PreviewProps): ReactElement {
  return (
    <InspectorForm testId="preview-skeleton">
      <InspectorSection id="skeleton" title="Skeleton" dim="type">
        <PropertyRow label="Joint Count" value={payload.jointCount} />
      </InspectorSection>
    </InspectorForm>
  );
}
