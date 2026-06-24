import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CBAsset, CBSortKey } from './types';
import type { MultiSelectAPI, SortAPI } from './hooks';

interface Props {
  items: CBAsset[];
  multiSelect: MultiSelectAPI;
  sort: SortAPI;
  onDoubleClick?: (asset: CBAsset) => void;
  onContextMenu?: (e: React.MouseEvent, asset: CBAsset) => void;
}

interface ColumnDef {
  key: CBSortKey | 'guid';
  label: string;
  width: string;
  getValue: (a: CBAsset) => string;
}

const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', width: '35%', getValue: a => a.name },
  { key: 'kind', label: 'Kind', width: '15%', getValue: a => a.kind },
  { key: 'guid', label: 'GUID', width: '25%', getValue: a => a.guid.slice(0, 8) + '…' },
  { key: 'estimatedSize', label: 'Size', width: '10%', getValue: a => a.estimatedSize ? `${(a.estimatedSize / 1024).toFixed(1)}K` : '—' },
  { key: 'packModifiedAt', label: 'Modified', width: '15%', getValue: a => a.packModifiedAt ? new Date(a.packModifiedAt).toLocaleDateString() : '—' },
];

const ROW_HEIGHT = 26;

export function CBColumn({ items, multiSelect, sort, onDoubleClick, onContextMenu }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => bodyRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  return (
    <div className="cb-column-view">
      <div className="cb-column-header">
        {COLUMNS.map(col => (
          <div
            key={col.key}
            className={`cb-column-th${sort.sortState.key === col.key ? ' sorted' : ''}`}
            style={{ width: col.width }}
            onClick={() => col.key !== 'guid' && sort.setSortKey(col.key as CBSortKey)}
          >
            {col.label}
            {sort.sortState.key === col.key && (
              <span className="cb-sort-indicator">{sort.sortState.dir === 'asc' ? ' ↑' : ' ↓'}</span>
            )}
          </div>
        ))}
      </div>
      <div ref={bodyRef} className="cb-column-body" style={{ overflow: 'auto', flex: 1 }}>
        <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
          {rowVirtualizer.getVirtualItems().map(virtualRow => {
            const asset = items[virtualRow.index]!;
            const selected = multiSelect.isSelected(asset);
            return (
              <div
                key={virtualRow.key}
                className={`cb-column-row${selected ? ' sel' : ''}`}
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
                {COLUMNS.map(col => (
                  <div key={col.key} className="cb-column-td" style={{ width: col.width }}>
                    {col.getValue(asset)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
