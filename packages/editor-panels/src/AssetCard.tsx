import { materialSwatch, type PackAsset } from '@forgeax/editor-core';

const ASSET_ICON: Record<string, string> = {
  level: '🗺', character: '🧍', monster: '🐮',
  material: '🎨', mesh: '◫', texture: '🖼',
  scene: '🗺', animation: '▶',
};

interface AssetCardProps {
  asset: PackAsset;
  selected?: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

export function AssetCard({ asset, selected, onClick, onDoubleClick, onContextMenu }: AssetCardProps) {
  const swatch = materialSwatch(asset);
  return (
    <div className={`asset-card${selected ? ' sel' : ''}`}
         onClick={onClick} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu}
         title={`${asset.kind} · ${asset.guid}\n${asset.packPath}`}>
      <div className="asset-card-thumb">
        {swatch
          ? <div className="asset-thumb-swatch" style={{ background: swatch }} />
          : <span className="asset-thumb-icon">{ASSET_ICON[asset.kind] ?? '?'}</span>
        }
      </div>
      <div className="asset-card-label">{asset.name}</div>
      <div className="asset-card-kind">{asset.kind}</div>
    </div>
  );
}
