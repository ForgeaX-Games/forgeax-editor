import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CBAsset, CBViewItem } from './types';
import type { MultiSelectAPI } from './hooks';

interface Props {
  items: CBViewItem[];
  multiSelect: MultiSelectAPI;
  onDoubleClick?: (item: CBViewItem) => void;
  onContextMenu?: (e: React.MouseEvent, item: CBViewItem) => void;
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
          const item = items[virtualRow.index]!;
          const selected = multiSelect.isSelected(item);
          const isFolder = item.type === 'folder';
          return (
            <div
              key={virtualRow.key}
              className={`cb-list-row${selected ? ' sel' : ''}${isFolder ? ' cb-list-folder' : ''}`}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: virtualRow.size,
                transform: `translateY(${virtualRow.start}px)`,
              }}
              onClick={e => multiSelect.handleClick(virtualRow.index, e)}
              onDoubleClick={() => onDoubleClick?.(item)}
              onContextMenu={e => { e.preventDefault(); onContextMenu?.(e, item); }}
            >
              <span className="cb-list-icon">{isFolder ? '📁' : (KIND_ICONS[item.kind] ?? '📦')}</span>
              <span className="cb-list-name">{item.name}</span>
              <span className="cb-list-kind">{isFolder ? 'folder' : item.kind}</span>
              <span className="cb-list-path">{isFolder ? `${item.childCount} item(s)` : item.packPath.replace(/^.*\//, '')}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
