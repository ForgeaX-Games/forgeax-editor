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

// No-op fallbacks so the memo'd leaves always receive a STABLE function
// reference (a fresh `() => {}` per render would defeat their shallow-prop memo).
const NOOP_ITEM = (_item: CBViewItem) => {};
const NOOP_CTX = (_e: React.MouseEvent, _item: CBViewItem) => {};
const NOOP_PATH = (_path: string) => {};

export function CBGrid({ items, thumbnailSize, multiSelect, viewMode, expandedPacks, onTogglePackExpansion, onSelect, onDoubleClick, onContextMenu, isItemFavorite, onToggleFavorite }: Props) {
  // Pull the two stable members off the multiSelect API. `isSelected` is read
  // here (during render) to derive each card's `selected` value; `handleClick`
  // is a stable identity (latest-ref inside useMultiSelect) forwarded to leaves.
  const { isSelected, handleClick } = multiSelect;
  const isAssetMode = viewMode === 'asset';

  // Every callback below is already referentially stable (either a ContentBrowser
  // useCallback or a no-op fallback), so the memo'd item components only re-render
  // when their own `item`/`selected`/`favorite`/`expanded` actually change.
  const selectCb = onSelect ?? NOOP_ITEM;
  const activateCb = onDoubleClick ?? NOOP_ITEM;
  const contextCb = onContextMenu ?? NOOP_CTX;
  const favoriteCb = onToggleFavorite ?? NOOP_ITEM;
  const expandCb = onTogglePackExpansion ?? NOOP_PATH;

  return (
    <div className="cb-grid-view cb-fe-grid">
      {items.map((item, index) => {
        const selected = isSelected(item);
        const favorite = isItemFavorite?.(item) ?? false;
        if (item.type === 'folder') {
          return (
            <CBFolderItem
              key={item.path}
              folder={item}
              index={index}
              selected={selected}
              thumbnailSize={thumbnailSize}
              favorite={favorite}
              onSelect={selectCb}
              onActivate={activateCb}
              onContextMenu={contextCb}
              onToggleFavorite={favoriteCb}
              onClickIndex={handleClick}
            />
          );
        }
        if (item.type === 'file') {
          const hasExpandableAssets = (item.family === 'pack' || item.family === 'meta' || item.family === 'ui') && item.assets.length > 0;
          return (
            <CBFileItem
              key={item.path}
              file={item}
              index={index}
              selected={selected}
              expanded={isAssetMode ? undefined : expandedPacks?.has(item.path)}
              expandable={!isAssetMode && hasExpandableAssets}
              favorite={favorite}
              onSelect={selectCb}
              onActivate={activateCb}
              onContextMenu={contextCb}
              onToggleFavorite={favoriteCb}
              onToggleExpand={expandCb}
              onClickIndex={handleClick}
            />
          );
        }
        return (
          <CBAssetItem
            key={item.guid}
            asset={item}
            index={index}
            selected={selected}
            thumbnailSize={thumbnailSize}
            favorite={favorite}
            onSelect={selectCb}
            onActivate={activateCb}
            onContextMenu={contextCb}
            onToggleFavorite={favoriteCb}
            onClickIndex={handleClick}
          />
        );
      })}
    </div>
  );
}
