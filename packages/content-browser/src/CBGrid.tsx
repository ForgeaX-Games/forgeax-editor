import type { CBViewItem } from './types';
import type { CBViewMode2 } from './view-mode';
import type { MultiSelectAPI } from './hooks';
import { CBAssetItem } from './CBAssetItem';
import { CBFolderItem } from './CBFolderItem';
import { CBFileItem } from './CBFileItem';

interface Props {
  items: CBViewItem[];
  thumbnailSize: number;
  multiSelect: MultiSelectAPI;
  selectedPath?: string | null;
  viewMode?: CBViewMode2;
  expandedPacks?: ReadonlySet<string>;
  onTogglePackExpansion?: (filePath: string) => void;
  onSelect?: (item: CBViewItem) => void;
  onDoubleClick?: (item: CBViewItem) => void;
  onContextMenu?: (e: React.MouseEvent, item: CBViewItem) => void;
}

function selectedKey(item: CBViewItem): string {
  if (item.type === 'asset') return item.packPath;
  return item.path;
}

export function CBGrid({ items, thumbnailSize, multiSelect, selectedPath, viewMode, expandedPacks, onTogglePackExpansion, onSelect, onDoubleClick, onContextMenu }: Props) {
  return (
    <div className="cb-grid-view cb-fe-grid">
      {items.map((item, index) => {
        const isSelected = selectedPath != null
          ? selectedPath === selectedKey(item)
          : multiSelect.isSelected(item);
        if (item.type === 'folder') {
          return (
            <CBFolderItem
              key={item.path}
              folder={item}
              selected={isSelected}
              thumbnailSize={thumbnailSize}
              onClick={e => { onSelect?.(item); multiSelect.handleClick(index, e); }}
              onDoubleClick={() => onDoubleClick?.(item)}
              onContextMenu={e => onContextMenu?.(e, item)}
            />
          );
        }
        if (item.type === 'file') {
          const isAssetMode = viewMode === 'asset';
          const hasExpandableAssets = (item.family === 'pack' || item.family === 'meta') && item.assets.length > 0;
          return (
            <CBFileItem
              key={item.path}
              file={item}
              selected={isSelected}
              expanded={isAssetMode ? (hasExpandableAssets || undefined) : expandedPacks?.has(item.path)}
              onToggleExpand={!isAssetMode && hasExpandableAssets
                ? () => onTogglePackExpansion?.(item.path)
                : undefined}
              onClick={e => { onSelect?.(item); multiSelect.handleClick(index, e); }}
              onDoubleClick={() => onDoubleClick?.(item)}
              onContextMenu={e => onContextMenu?.(e, item)}
            />
          );
        }
        return (
          <CBAssetItem
            key={item.guid}
            asset={item}
            selected={isSelected}
            thumbnailSize={thumbnailSize}
            onClick={e => { onSelect?.(item); multiSelect.handleClick(index, e); }}
            onDoubleClick={() => onDoubleClick?.(item)}
            onContextMenu={e => onContextMenu?.(e, item)}
          />
        );
      })}
    </div>
  );
}
