import { PropertyRow } from './PropertyRow';
import type { PreviewProps } from './index';

export default function AssetPreviewAnimationClip({ payload }: PreviewProps) {
  const channels = Array.isArray(payload.channels) ? payload.channels.length : 0;
  const duration = typeof payload.duration === 'number' ? `${payload.duration.toFixed(2)}s` : '—';

  return (
    <div data-testid="preview-animation-clip">
      <div className="compname">Animation Clip</div>
      <PropertyRow label="Duration" value={duration} />
      <PropertyRow label="Channels" value={channels} />
    </div>
  );
}
