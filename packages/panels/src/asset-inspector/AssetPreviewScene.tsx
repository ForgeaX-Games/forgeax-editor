import type { ReactElement } from 'react';
import { PropertyRow } from './PropertyRow';
import { InspectorForm, InspectorSection } from './InspectorSection';
import type { PreviewProps } from './index';

export default function AssetPreviewScene({ payload }: PreviewProps): ReactElement {
  const entities = Array.isArray(payload.entities) ? payload.entities.length
    : Array.isArray(payload.nodes) ? payload.nodes.length : 0;
  const mounts = Array.isArray(payload.mounts) ? payload.mounts.length : 0;
  const skinGuids = Array.isArray(payload.skinGuids) ? payload.skinGuids.length : 0;

  return (
    <InspectorForm testId="preview-scene">
      <InspectorSection id="scene" title="Scene" dim="type">
        <PropertyRow label="Entities" value={entities} />
        <PropertyRow label="Mounts" value={mounts} />
        {skinGuids > 0 && <PropertyRow label="Skin GUIDs" value={skinGuids} />}
      </InspectorSection>
    </InspectorForm>
  );
}
