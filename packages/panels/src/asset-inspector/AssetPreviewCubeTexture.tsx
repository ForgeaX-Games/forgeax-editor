import { PropertyRow } from './PropertyRow';
import type { PreviewProps } from './index';

export default function AssetPreviewCubeTexture({ payload }: PreviewProps) {
  const faces = Array.isArray(payload.faces) ? payload.faces.length : 0;

  return (
    <div data-testid="preview-cube-texture">
      <div className="compname">Cube Texture</div>
      <PropertyRow label="Width" value={payload.width} />
      <PropertyRow label="Height" value={payload.height} />
      <PropertyRow label="Format" value={payload.format} />
      <PropertyRow label="Faces" value={faces} />
    </div>
  );
}
