import { materialSwatch, type PackAsset } from '@forgeax/editor-core';

const ASSET_ICON: Record<string, string> = {
  mesh: '◫', texture: '🖼', 'cube-texture': '🧊', sampler: '⚙',
  material: '🎨', scene: '🗺', shader: '📜', skeleton: '🦴',
  skin: '🩻', 'animation-clip': '🎬', audio: '🔊', font: '🔤',
  'render-pipeline': '🔧', tileset: '🧱',
  level: '🗺', character: '🧍', monster: '🐮', animation: '▶',
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
          : <span className="asset-thumb-icon">{ASSET_ICON[asset.kind] ?? '📦'}</span>
        }
      </div>
      <div className="asset-card-label">{asset.name}</div>
      <div className="asset-card-kind">{asset.kind}</div>
    </div>
  );
}
