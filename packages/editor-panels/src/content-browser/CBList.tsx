import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CBAsset } from './types';
import type { MultiSelectAPI } from './hooks';

interface Props {
  items: CBAsset[];
  multiSelect: MultiSelectAPI;
  onDoubleClick?: (asset: CBAsset) => void;
  onContextMenu?: (e: React.MouseEvent, asset: CBAsset) => void;
}

const KIND_ICONS: Record<string, string> = {
  mesh: '◫', texture: '🖼', 'cube-texture': '🧊', sampler: '⚙',
  material: '🎨', scene: '🗺', shader: '📜', skeleton: '🦴',
  skin: '🩻', 'animation-clip': '🎬', audio: '🔊', font: '🔤',
  'render-pipeline': '🔧', tileset: '🧱',
};

const ROW_HEIGHT = 28;

export function CBList({ items, multiSelect, onDoubleClick, onContextMenu }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  return (
    <div ref={parentRef} className="cb-list-view" style={{ overflow: 'auto', flex: 1 }}>
      <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
        {rowVirtualizer.getVirtualItems().map(virtualRow => {
          const asset = items[virtualRow.index]!;
          const selected = multiSelect.isSelected(asset);
          return (
            <div
              key={virtualRow.key}
              className={`cb-list-row${selected ? ' sel' : ''}`}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: virtualRow.size,
                transform: `translateY(${virtualRow.start}px)`,
              }}
              onClick={e => multiSelect.handleClick(virtualRow.index, e)}
              onDoubleClick={() => onDoubleClick?.(asset)}
              onContextMenu={e => { e.preventDefault(); onContextMenu?.(e, asset); }}
            >
              <span className="cb-list-icon">{KIND_ICONS[asset.kind] ?? '📦'}</span>
              <span className="cb-list-name">{asset.name}</span>
              <span className="cb-list-kind">{asset.kind}</span>
              <span className="cb-list-path">{asset.packPath.replace(/^.*\//, '')}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
