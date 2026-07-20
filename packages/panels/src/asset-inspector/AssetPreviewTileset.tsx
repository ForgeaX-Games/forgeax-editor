import { PropertyRow } from './PropertyRow';
import type { PreviewProps } from './index';

export default function AssetPreviewTileset({ payload }: PreviewProps) {
  const regions = Array.isArray(payload.regions) ? payload.regions.length : 0;
  const tiles = Array.isArray(payload.tiles) ? payload.tiles.length : 0;

  return (
    <div data-testid="preview-tileset">
      <div className="compname">Tileset</div>
      <PropertyRow label="Tile Width" value={payload.tileWidth} />
      <PropertyRow label="Tile Height" value={payload.tileHeight} />
      <PropertyRow label="Columns" value={payload.columns} />
      <PropertyRow label="Rows" value={payload.rows} />
      <PropertyRow label="Regions" value={regions} />
      <PropertyRow label="Tiles" value={tiles} />
    </div>
  );
}
