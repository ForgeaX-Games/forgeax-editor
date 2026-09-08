import type { ReactElement } from 'react';
import { PropertyRow } from './PropertyRow';
import { InspectorForm, InspectorSection } from './InspectorSection';
import type { PreviewProps } from './index';

export default function AssetPreviewTileset({ payload }: PreviewProps): ReactElement {
  const regions = Array.isArray(payload.regions) ? payload.regions.length : 0;
  const tiles = Array.isArray(payload.tiles) ? payload.tiles.length : 0;

  return (
    <InspectorForm testId="preview-tileset">
      <InspectorSection id="tileset-grid" title="Grid" dim="type">
        <PropertyRow label="Tile Width" value={payload.tileWidth} />
        <PropertyRow label="Tile Height" value={payload.tileHeight} />
        <PropertyRow label="Columns" value={payload.columns} />
        <PropertyRow label="Rows" value={payload.rows} />
      </InspectorSection>
      <InspectorSection id="tileset-content" title="Content" dim="all">
        <PropertyRow label="Regions" value={regions} />
        <PropertyRow label="Tiles" value={tiles} />
      </InspectorSection>
    </InspectorForm>
  );
}
