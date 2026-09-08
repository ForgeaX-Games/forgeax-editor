import type { ReactElement } from 'react';
import { PropertyRow } from './PropertyRow';
import { InspectorForm, InspectorSection } from './InspectorSection';
import { meshInspectionFacts } from './mesh-inspection-facts';
import type { PreviewProps } from './index';

export default function AssetPreviewMesh({ payload }: PreviewProps): ReactElement {
  const facts = meshInspectionFacts(payload);
  const attrLabel = facts.attributeKeys.length > 0 ? facts.attributeKeys.join(', ') : '(default)';

  return (
    <InspectorForm testId="preview-mesh">
      <InspectorSection id="geometry" title="Geometry" dim="type">
        <PropertyRow label="Vertices" value={facts.vertexCount} />
        <PropertyRow label="Triangles" value={facts.triangleCount} />
        <PropertyRow label="Submeshes" value={facts.submeshCount} />
        <PropertyRow label="Topology" value={facts.topologies.length > 0 ? facts.topologies.join(', ') : '—'} />
      </InspectorSection>
      <InspectorSection id="attributes" title="Attributes" dim="all">
        <PropertyRow label="Attributes" value={attrLabel} />
        <PropertyRow label="Normals" value={facts.hasNormals ? 'Yes' : 'No'} />
        <PropertyRow label="Tangents" value={facts.hasTangents ? 'Yes' : 'No'} />
        <PropertyRow label="UV Sets" value={facts.hasUv ? facts.uvSetCount : 'None'} />
      </InspectorSection>
      <InspectorSection id="bounds" title="Bounds" dim="cap">
        <PropertyRow label="AABB Min" value={facts.aabbMin} />
        <PropertyRow label="AABB Max" value={facts.aabbMax} />
        <PropertyRow label="Bounds Radius" value={facts.boundsRadius} />
      </InspectorSection>
    </InspectorForm>
  );
}
