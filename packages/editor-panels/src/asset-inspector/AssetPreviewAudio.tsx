import { PropertyRow } from './PropertyRow';
import type { PreviewProps } from './index';

export default function AssetPreviewAudio({ payload }: PreviewProps) {
  const hasMeta = typeof payload.duration === 'number' || typeof payload.sampleRate === 'number';

  if (!hasMeta) {
    return (
      <div data-testid="preview-audio">
        <div className="compname">Audio</div>
        <div className="field muted">Audio asset (binary, no metadata available)</div>
      </div>
    );
  }

  return (
    <div data-testid="preview-audio">
      <div className="compname">Audio</div>
      {typeof payload.duration === 'number' && (
        <PropertyRow label="Duration" value={`${payload.duration.toFixed(2)}s`} />
      )}
      {typeof payload.sampleRate === 'number' && (
        <PropertyRow label="Sample Rate" value={`${payload.sampleRate} Hz`} />
      )}
    </div>
  );
}
