import type { ReactElement } from 'react';
import { PropertyRow } from './PropertyRow';
import { InspectorForm, InspectorSection } from './InspectorSection';
import type { PreviewProps } from './index';

export default function AssetPreviewAudio({ payload }: PreviewProps): ReactElement {
  const hasMeta = typeof payload.duration === 'number' || typeof payload.sampleRate === 'number';

  if (!hasMeta) {
    return (
      <InspectorForm testId="preview-audio">
        <InspectorSection id="audio" title="Audio" dim="type">
          <div className="asset-empty-note">Audio asset (binary, no metadata available)</div>
        </InspectorSection>
      </InspectorForm>
    );
  }

  return (
    <InspectorForm testId="preview-audio">
      <InspectorSection id="audio" title="Audio" dim="type">
        {typeof payload.duration === 'number' && (
          <PropertyRow label="Duration" value={`${payload.duration.toFixed(2)}s`} />
        )}
        {typeof payload.sampleRate === 'number' && (
          <PropertyRow label="Sample Rate" value={`${payload.sampleRate} Hz`} />
        )}
      </InspectorSection>
    </InspectorForm>
  );
}
