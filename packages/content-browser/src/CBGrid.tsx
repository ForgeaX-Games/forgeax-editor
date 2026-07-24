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
  viewMode?: CBViewMode2;
  expandedPacks?: ReadonlySet<string>;
  onTogglePackExpansion?: (filePath: string) => void;
  onSelect?: (item: CBViewItem) => void;
  onDoubleClick?: (item: CBViewItem) => void;
  onContextMenu?: (e: React.MouseEvent, item: CBViewItem) => void;
  /** Whether the item is in the favorites list — lights the card's ⭐. */
  isItemFavorite?: (item: CBViewItem) => boolean;
  /** Toggle the item's favorite state (drives both the card ⭐ and the
   *  header "favorites only" filter's contents). */
  onToggleFavorite?: (item: CBViewItem) => void;
}

export function CBGrid({ items, thumbnailSize, multiSelect, viewMode, expandedPacks, onTogglePackExpansion, onSelect, onDoubleClick, onContextMenu, isItemFavorite, onToggleFavorite }: Props) {
  return (
    <div className="cb-grid-view cb-fe-grid">
      {items.map((item, index) => {
        const isSelected = multiSelect.isSelected(item);
        const favorite = isItemFavorite?.(item) ?? false;
        const toggleFavorite = onToggleFavorite ? () => onToggleFavorite(item) : undefined;
        if (item.type === 'folder') {
          return (
            <CBFolderItem
              key={item.path}
              folder={item}
              selected={isSelected}
              thumbnailSize={thumbnailSize}
              favorite={favorite}
              onToggleFavorite={toggleFavorite}
              onClick={e => { onSelect?.(item); multiSelect.handleClick(index, e); }}
              onDoubleClick={() => onDoubleClick?.(item)}
              onContextMenu={e => onContextMenu?.(e, item)}
            />
          );
        }
        if (item.type === 'file') {
          const isAssetMode = viewMode === 'asset';
          const hasExpandableAssets = (item.family === 'pack' || item.family === 'meta' || item.family === 'ui') && item.assets.length > 0;
          return (
            <CBFileItem
              key={item.path}
              file={item}
              selected={isSelected}
              expanded={isAssetMode ? undefined : expandedPacks?.has(item.path)}
              favorite={favorite}
              onToggleFavorite={toggleFavorite}
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
            favorite={favorite}
            onToggleFavorite={toggleFavorite}
            onClick={e => { onSelect?.(item); multiSelect.handleClick(index, e); }}
            onDoubleClick={() => onDoubleClick?.(item)}
            onContextMenu={e => onContextMenu?.(e, item)}
          />
        );
      })}
    </div>
  );
}
