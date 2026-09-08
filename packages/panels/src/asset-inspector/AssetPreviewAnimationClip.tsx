import type { ReactElement } from 'react';
import { PropertyRow } from './PropertyRow';
import { InspectorForm, InspectorSection } from './InspectorSection';
import type { PreviewProps } from './index';

export default function AssetPreviewAnimationClip({ payload }: PreviewProps): ReactElement {
  const channels = Array.isArray(payload.channels) ? payload.channels.length : 0;
  const duration = typeof payload.duration === 'number' ? `${payload.duration.toFixed(2)}s` : '—';

  return (
    <InspectorForm testId="preview-animation-clip">
      <InspectorSection id="animation-clip" title="Animation Clip" dim="type">
        <PropertyRow label="Duration" value={duration} />
        <PropertyRow label="Channels" value={channels} />
      </InspectorSection>
    </InspectorForm>
  );
}
