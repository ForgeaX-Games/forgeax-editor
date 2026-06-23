import { PropertyRow } from './PropertyRow';
import type { PreviewProps } from './index';

export default function AssetPreviewRenderPipeline({ payload }: PreviewProps) {
  const config = payload.config as Record<string, unknown> | undefined;
  const passCount = config?.passCount;

  return (
    <div data-testid="preview-render-pipeline">
      <div className="compname">Render Pipeline</div>
      <PropertyRow label="Pipeline ID" value={payload.pipelineId} />
      {passCount != null && <PropertyRow label="Pass Count" value={passCount} />}
      {config && Object.entries(config).map(([k, v]) => {
        if (k === 'passCount') return null;
        if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
          return <PropertyRow key={k} label={k} value={v} />;
        }
        return null;
      })}
    </div>
  );
}
