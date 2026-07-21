import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CBAsset, CBFile, CBViewItem } from './types';
import type { MultiSelectAPI } from './hooks';
import { ContentBrowserIcon, iconNameForAssetKind, iconNameForFileFamily } from './content-browser-icons';

interface Props {
  items: CBViewItem[];
  multiSelect: MultiSelectAPI;
  onDoubleClick?: (item: CBViewItem) => void;
  onContextMenu?: (e: React.MouseEvent, item: CBViewItem) => void;
}

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
          const isFile = item.type === 'file';
          const iconName = isFolder ? 'folder'
            : isFile ? iconNameForFileFamily((item as CBFile).family)
            : iconNameForAssetKind((item as CBAsset).kind);
          const kindLabel = isFolder ? 'folder'
            : isFile ? (item as CBFile).kindLabel
            : (item as CBAsset).kind;
          const detail = isFolder ? `${item.childCount} item(s)`
            : isFile ? (item as CBFile).path
            : (item as CBAsset).packPath.replace(/^.*\//, '');
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
              <span className="cb-list-icon">
                <ContentBrowserIcon name={iconName} />
              </span>
              <span className="cb-list-name">{item.name}</span>
              <span className="cb-list-kind">{kindLabel}</span>
              <span className="cb-list-path">{detail}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
