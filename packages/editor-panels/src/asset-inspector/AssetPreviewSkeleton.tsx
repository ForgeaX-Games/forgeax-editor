import { PropertyRow } from './PropertyRow';
import type { PreviewProps } from './index';

export default function AssetPreviewSkeleton({ payload }: PreviewProps) {
  return (
    <div data-testid="preview-skeleton">
      <div className="compname">Skeleton</div>
      <PropertyRow label="Joint Count" value={payload.jointCount} />
    </div>
  );
}
