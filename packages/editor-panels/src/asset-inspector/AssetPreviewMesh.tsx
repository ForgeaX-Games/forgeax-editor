import { PropertyRow } from './PropertyRow';
import type { PreviewProps } from './index';

export default function AssetPreviewMesh({ payload }: PreviewProps) {
  const vertices = payload.vertices;
  const indices = payload.indices;
  const attributes = payload.attributes as Record<string, unknown> | undefined;
  const submeshes = payload.submeshes;

  const vertexCount = Array.isArray(vertices)
    ? Math.floor(vertices.length / 3)
    : '—';
  const triangleCount = Array.isArray(indices)
    ? Math.floor(indices.length / 3)
    : '—';
  const submeshCount = Array.isArray(submeshes) ? submeshes.length : 0;
  const attrKeys = attributes ? Object.keys(attributes) : [];

  return (
    <div data-testid="preview-mesh">
      <div className="compname">Mesh</div>
      <PropertyRow label="Vertices" value={vertexCount} />
      <PropertyRow label="Triangles" value={triangleCount} />
      <PropertyRow label="Submeshes" value={submeshCount} />
      <PropertyRow label="Attributes" value={attrKeys.length > 0 ? attrKeys.join(', ') : '(default)'} />
    </div>
  );
}
