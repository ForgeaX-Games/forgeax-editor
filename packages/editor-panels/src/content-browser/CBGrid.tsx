import { useRef, useMemo, useCallback, useEffect, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CBAsset } from './types';
import type { MultiSelectAPI } from './hooks';

interface Props {
  items: CBAsset[];
  thumbnailSize: number;
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

const GAP = 8;
const LABEL_HEIGHT = 28;

export function CBGrid({ items, thumbnailSize, multiSelect, onDoubleClick, onContextMenu }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(400);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const itemWidth = thumbnailSize + GAP;
  const itemHeight = thumbnailSize + LABEL_HEIGHT;
  const columnCount = Math.max(1, Math.floor((containerWidth + GAP) / itemWidth));
  const rowCount = Math.ceil(items.length / columnCount);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => itemHeight + GAP,
    overscan: 3,
  });

  const getItemsForRow = useCallback((rowIndex: number) => {
    const start = rowIndex * columnCount;
    return items.slice(start, start + columnCount);
  }, [items, columnCount]);

  return (
    <div ref={parentRef} className="cb-grid-view" style={{ overflow: 'auto', flex: 1 }}>
      <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
        {rowVirtualizer.getVirtualItems().map(virtualRow => {
          const rowItems = getItemsForRow(virtualRow.index);
          const baseIndex = virtualRow.index * columnCount;
          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: virtualRow.size,
                transform: `translateY(${virtualRow.start}px)`,
                display: 'flex',
                gap: `${GAP}px`,
                padding: `0 ${GAP}px`,
              }}
            >
              {rowItems.map((asset, colIdx) => {
                const flatIndex = baseIndex + colIdx;
                const selected = multiSelect.isSelected(asset);
                return (
                  <div
                    key={asset.guid}
                    className={`cb-grid-item${selected ? ' sel' : ''}`}
                    style={{ width: itemWidth, height: itemHeight }}
                    onClick={e => multiSelect.handleClick(flatIndex, e)}
                    onDoubleClick={() => onDoubleClick?.(asset)}
                    onContextMenu={e => { e.preventDefault(); onContextMenu?.(e, asset); }}
                  >
                    <div className="cb-grid-thumb" style={{ width: thumbnailSize, height: thumbnailSize }}>
                      {asset.thumbnailUrl ? (
                        <img src={asset.thumbnailUrl} alt={asset.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        <span className="cb-grid-icon">{KIND_ICONS[asset.kind] ?? '📦'}</span>
                      )}
                    </div>
                    <div className="cb-grid-label" title={`${asset.name}\n${asset.kind} · ${asset.guid}`}>
                      {asset.name}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
