import type { ReactElement } from 'react';
import { PropertyRow } from './PropertyRow';
import { InspectorForm, InspectorSection } from './InspectorSection';
import type { PreviewProps } from './index';

export default function AssetPreviewRenderPipeline({ payload }: PreviewProps): ReactElement {
  const config = payload.config as Record<string, unknown> | undefined;
  const passCount = config?.passCount;

  return (
    <InspectorForm testId="preview-render-pipeline">
      <InspectorSection id="render-pipeline" title="Render Pipeline" dim="type">
        <PropertyRow label="Pipeline ID" value={payload.pipelineId} />
        {passCount != null && <PropertyRow label="Pass Count" value={passCount} />}
        {config && Object.entries(config).map(([k, v]) => {
          if (k === 'passCount') return null;
          if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
            return <PropertyRow key={k} label={k} value={v} />;
          }
          return null;
        })}
      </InspectorSection>
    </InspectorForm>
  );
}
