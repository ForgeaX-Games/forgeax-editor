import { useRef, type CSSProperties } from 'react';
import { useKeybindingScope } from '@forgeax/interface/core/app-shell';
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
  onFocusItem?: (item: CBViewItem) => void;
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

export function CBGrid({ items, thumbnailSize, multiSelect, viewMode, expandedPacks, onTogglePackExpansion, onSelect, onDoubleClick, onContextMenu, onFocusItem, isItemFavorite, onToggleFavorite }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  useKeybindingScope(rootRef, 'editor.contentBrowser.grid');
  // Pull the two stable members off the multiSelect API. `isSelected` is read
  // here (during render) to derive each card's `selected` value; `handleClick`
  // is a stable identity (latest-ref inside useMultiSelect) forwarded to leaves.
  const { isSelected, handleClick, clearSelection } = multiSelect;
  const isAssetMode = viewMode === 'asset';

  // Blank-area deselect: clicking the grid background/gaps (not a card) clears the
  // Content Browser selection. The `.cb-asset-view` container in ContentBrowser is
  // fully covered by this grid, so its own blank-click handler rarely fires — this
  // catches clicks that land between/around cards.
  const handleBlankClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) clearSelection();
  };

  // Every callback below is already referentially stable (either a ContentBrowser
  // useCallback or a no-op fallback), so the memo'd item components only re-render
  // when their own `item`/`selected`/`favorite`/`expanded` actually change.
  const selectCb = onSelect ?? NOOP_ITEM;
  const activateCb = onDoubleClick ?? NOOP_ITEM;
  const contextCb = onContextMenu ?? NOOP_CTX;
  const favoriteCb = onToggleFavorite ?? NOOP_ITEM;
  const focusCb = onFocusItem ?? NOOP_ITEM;
  const expandCb = onTogglePackExpansion ?? NOOP_PATH;
  const selectedTabStop = multiSelect.selection.items[0];
  const tabStopKey = selectedTabStop
    ? (selectedTabStop.type === 'asset' ? selectedTabStop.guid : selectedTabStop.path)
    : items[0]?.type === 'asset' ? items[0].guid : items[0]?.path;

  return (
    <div
      ref={rootRef}
      className="cb-grid-view cb-fe-grid"
      style={{ '--cb-thumb': `${thumbnailSize}px` } as CSSProperties}
      onClick={handleBlankClick}
    >
      {items.map((item, index) => {
        const selected = isSelected(item);
        const itemKey = item.type === 'asset' ? item.guid : item.path;
        const tabIndex = itemKey === tabStopKey ? 0 : -1;
        const favorite = isItemFavorite?.(item) ?? false;
        if (item.type === 'folder') {
          return (
            <CBFolderItem
              key={item.path}
              folder={item}
              index={index}
              selected={selected}
              tabIndex={tabIndex}
              thumbnailSize={thumbnailSize}
              favorite={favorite}
              onSelect={selectCb}
              onActivate={activateCb}
              onContextMenu={contextCb}
              onToggleFavorite={favoriteCb}
              onClickIndex={handleClick}
              onFocusItem={focusCb}
            />
          );
        }
        if (item.type === 'file') {
          const hasExpandableAssets = item.assets.length > 0;
          return (
            <CBFileItem
              key={item.path}
              file={item}
              index={index}
              selected={selected}
              tabIndex={tabIndex}
              expanded={isAssetMode ? undefined : expandedPacks?.has(item.path)}
              expandable={!isAssetMode && hasExpandableAssets}
              favorite={favorite}
              onSelect={selectCb}
              onActivate={activateCb}
              onContextMenu={contextCb}
              onToggleFavorite={favoriteCb}
              onToggleExpand={expandCb}
              onClickIndex={handleClick}
              onFocusItem={focusCb}
            />
          );
        }
        return (
          <CBAssetItem
            key={item.guid}
            asset={item}
            index={index}
            selected={selected}
            tabIndex={tabIndex}
            thumbnailSize={thumbnailSize}
            favorite={favorite}
            onSelect={selectCb}
            onActivate={activateCb}
            onContextMenu={contextCb}
            onToggleFavorite={favoriteCb}
            onClickIndex={handleClick}
            onFocusItem={focusCb}
          />
        );
      })}
    </div>
  );
}
