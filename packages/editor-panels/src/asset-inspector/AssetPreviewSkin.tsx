import { PropertyRow } from './PropertyRow';
import type { PreviewProps } from './index';

export default function AssetPreviewSkin({ payload }: PreviewProps) {
  const jointPaths = Array.isArray(payload.jointPaths) ? payload.jointPaths.length : 0;

  return (
    <div data-testid="preview-skin">
      <div className="compname">Skin</div>
      <PropertyRow label="Skeleton GUID" value={payload.skeletonGuid} />
      <PropertyRow label="Joint Paths" value={jointPaths} />
    </div>
  );
}
