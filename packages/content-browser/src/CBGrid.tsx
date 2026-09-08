import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useKeybindingScope } from '@forgeax/interface/core/app-shell';
import type { CBAsset, CBViewItem, CBViewMode } from './types';
import type { CBViewMode2 } from './view-mode';
import type { MultiSelectAPI } from './hooks';
import { useFolderDropZone, type CBDragPayload, type CBDropTarget } from './dnd';
import { CBAssetItem } from './CBAssetItem';
import { CBFolderItem } from './CBFolderItem';
import { CBFileItem } from './CBFileItem';

interface Props {
  items: CBViewItem[];
  thumbnailSize: number;
  multiSelect: MultiSelectAPI;
  viewMode?: CBViewMode2;
  /** While a search query is active the grid drops group lanes and flattens
   *  every match into a plain grid (decision 1). */
  searchActive?: boolean;
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
  /** viewItemKey of the item currently being inline-renamed, or null. */
  renamingKey?: string | null;
  /** Basename validator forwarded to the inline editor. */
  renameValidate?: (value: string) => string | null;
  /** Commit an inline rename (shared pipeline in ContentBrowser). */
  onRenameCommit?: (item: CBViewItem, value: string) => void;
  /** Abandon the in-flight inline rename. */
  onRenameCancel?: () => void;
  /** Internal move DnD: build a drag payload for a file/folder subject. */
  getDragPayload?: (item: CBViewItem) => CBDragPayload | null;
  /** Internal move DnD: execute a validated move dropped onto a folder tile. */
  onMoveDrop?: (payload: CBDragPayload, target: CBDropTarget) => void;
  /** The folder currently being browsed — destination for a drop onto the grid's
   *  blank area (drop into "here"). */
  currentDir?: string;
  /** Presentation layout. 'grid' = thumbnail tiles, 'list' = compact rows. Both
   *  share this component and differ only by a CSS modifier; 'column' (details
   *  table) is rendered by CBDetailsList instead. */
  layout?: CBViewMode;
}

const NOOP_MOVE = (_p: CBDragPayload, _t: CBDropTarget) => {};

// No-op fallbacks so the memo'd leaves always receive a STABLE function
// reference (a fresh `() => {}` per render would defeat their shallow-prop memo).
const NOOP_ITEM = (_item: CBViewItem) => {};
const NOOP_CTX = (_e: React.MouseEvent, _item: CBViewItem) => {};
const NOOP_PATH = (_path: string) => {};
const NOOP_RENAME = (_item: CBViewItem, _value: string) => {};
const NOOP_VOID = () => {};

export function CBGrid({ items, thumbnailSize, multiSelect, searchActive = false, expandedPacks, onTogglePackExpansion, onSelect, onDoubleClick, onContextMenu, onFocusItem, isItemFavorite, onToggleFavorite, renamingKey, renameValidate, onRenameCommit, onRenameCancel, getDragPayload, onMoveDrop, currentDir, layout = 'grid' }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  useKeybindingScope(rootRef, 'editor.contentBrowser.grid');

  // Connected group background: rather than a wrapper element (which would break
  // the grid flow), we MEASURE the member cards (`[data-cb-group]`) and paint one
  // absolutely-positioned backdrop per wrapped row behind them. Bucketing members
  // by `offsetTop` yields the "paragraph highlight" shape — a ragged first/last
  // row and full-width middle rows — and a small pad bleeds each rect into the
  // grid gap so consecutive rows join into one continuous surface.
  const [backdrops, setBackdrops] = useState<{ key: string; left: number; top: number; width: number; height: number; radius: string }[]>([]);
  const measureGroups = useCallback(() => {
    const container = rootRef.current;
    if (!container) { setBackdrops(prev => (prev.length ? [] : prev)); return; }
    const members = container.querySelectorAll<HTMLElement>('[data-cb-group]');
    if (members.length === 0) { setBackdrops(prev => (prev.length ? [] : prev)); return; }
    const byGroup = new Map<string, HTMLElement[]>();
    members.forEach(el => {
      const key = el.dataset.cbGroup;
      if (!key) return;
      const list = byGroup.get(key);
      if (list) list.push(el); else byGroup.set(key, [el]);
    });
    const pad = layout === 'list' ? 2 : 4;
    const radius = 8;
    // Padding-box right edge (inside any scrollbar); left edge is offset origin 0.
    const containerRight = container.clientWidth;
    const next: { key: string; left: number; top: number; width: number; height: number; radius: string }[] = [];
    for (const [key, els] of byGroup) {
      const rows: { top: number; els: HTMLElement[] }[] = [];
      for (const el of els) {
        const top = el.offsetTop;
        const row = rows.find(r => Math.abs(r.top - top) <= 4);
        if (row) row.els.push(el); else rows.push({ top, els: [el] });
      }
      const multiRow = rows.length > 1;
      rows.forEach((row, idx) => {
        let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
        for (const el of row.els) {
          left = Math.min(left, el.offsetLeft);
          right = Math.max(right, el.offsetLeft + el.offsetWidth);
          top = Math.min(top, el.offsetTop);
          bottom = Math.max(bottom, el.offsetTop + el.offsetHeight);
        }
        // Paragraph continuation: a wrapped run runs its non-terminal edge out to
        // the container border so consecutive rows connect — every row but the
        // first extends its LEFT to the container edge, every row but the last
        // extends its RIGHT. The extended edge is squared (radius 0) so the rows
        // read as one continued block; the ragged ends keep their rounded corners.
        const extendLeft = multiRow && idx > 0;
        const extendRight = multiRow && idx < rows.length - 1;
        const x0 = extendLeft ? 0 : left - pad;
        const x1 = extendRight ? containerRight : right + pad;
        const tl = extendLeft ? 0 : radius;
        const bl = extendLeft ? 0 : radius;
        const tr = extendRight ? 0 : radius;
        const br = extendRight ? 0 : radius;
        next.push({
          key: `${key}#${idx}`,
          left: x0,
          top: top - pad,
          width: x1 - x0,
          height: bottom - top + pad * 2,
          radius: `${tl}px ${tr}px ${br}px ${bl}px`,
        });
      });
    }
    setBackdrops(next);
  }, [layout]);

  useLayoutEffect(() => {
    measureGroups();
    const container = rootRef.current;
    if (!container) return;
    let raf = 0;
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measureGroups); };
    const ro = new ResizeObserver(schedule);
    ro.observe(container);
    container.querySelectorAll<HTMLElement>('[data-cb-group]').forEach(el => ro.observe(el));
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [measureGroups, items, expandedPacks, thumbnailSize, searchActive]);
  // Blank-area move drop: dropping onto the grid background (not a card) lands
  // the subjects in the folder being browsed. Folder-tile drop zones stopPropagation
  // first, so this only fires for genuine background drops. `same-parent` moves
  // (an item already in this folder) are rejected by the shared policy.
  const gridDropTarget = useMemo<CBDropTarget>(() => ({ kind: 'grid-blank', path: currentDir ?? 'assets' }), [currentDir]);
  const { isOver: gridDropOver, verdict: gridDropVerdict, dropProps: gridDropProps } = useFolderDropZone(gridDropTarget, onMoveDrop ?? NOOP_MOVE);
  const gridDropClass = gridDropOver && gridDropVerdict
    ? gridDropVerdict.ok ? ' cb-drop-ok' : ' cb-drop-reject'
    : '';
  // Pull the two stable members off the multiSelect API. `isSelected` is read
  // here (during render) to derive each card's `selected` value; `handleClick`
  // is a stable identity (latest-ref inside useMultiSelect) forwarded to leaves.
  const { isSelected, handleClick, clearSelection } = multiSelect;

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
  const renameCommitCb = onRenameCommit ?? NOOP_RENAME;
  const renameCancelCb = onRenameCancel ?? NOOP_VOID;
  const selectedTabStop = multiSelect.selection.items[0];
  const tabStopKey = selectedTabStop
    ? (selectedTabStop.type === 'asset' ? selectedTabStop.guid : selectedTabStop.path)
    : items[0]?.type === 'asset' ? items[0].guid : items[0]?.path;

  // Grouping: a glb/fbx file whose members are imported sub-assets is a
  // "resource group". Collapsed it renders as ONE group card (stack + count).
  // Expanded it INLINE-UNPACKS into a full-width container that carries the
  // parent card as its first tile and the sub-assets flowing to its right, all
  // sharing one connected background surface. Groups expand independently (no
  // accordion). `index` is ALWAYS the item's real position in the flat `items`
  // array so the multi-select shift-range contract is untouched. Search flattens
  // everything (grouping off).
  const grouping = !searchActive;

  const renderFolder = (folder: Extract<CBViewItem, { type: 'folder' }>, index: number, tabIndex: number, favorite: boolean, renaming: boolean): ReactNode => (
    <CBFolderItem
      key={folder.path}
      folder={folder}
      index={index}
      selected={isSelected(folder)}
      tabIndex={tabIndex}
      thumbnailSize={thumbnailSize}
      favorite={favorite}
      onSelect={selectCb}
      onActivate={activateCb}
      onContextMenu={contextCb}
      onToggleFavorite={favoriteCb}
      onClickIndex={handleClick}
      onFocusItem={focusCb}
      getDragPayload={getDragPayload}
      onMoveDrop={onMoveDrop}
      renaming={renaming}
      renameValidate={renameValidate}
      onRenameCommit={renameCommitCb}
      onRenameCancel={renameCancelCb}
    />
  );

  const renderFileCard = (file: Extract<CBViewItem, { type: 'file' }>, index: number, tabIndex: number, favorite: boolean, renaming: boolean, expanded = false, groupKey?: string): ReactNode => {
    // Only a MULTI-member file (≥2) is a foldable container that shows a member
    // count badge + chevron. A 1:1 file never reaches the grid as a file card —
    // its lone asset is promoted to a standalone asset card upstream (viewItems),
    // so the file card would be a confusing duplicate. Search flattens everything,
    // so no badge while searching.
    const groupCount = grouping && file.assets.length >= 2 ? file.assets.length : 0;
    return (
      <CBFileItem
        key={file.path}
        file={file}
        index={index}
        selected={isSelected(file)}
        tabIndex={tabIndex}
        expanded={expanded}
        groupCount={groupCount}
        favorite={favorite}
        onSelect={selectCb}
        onActivate={activateCb}
        onContextMenu={contextCb}
        onToggleFavorite={favoriteCb}
        onToggleExpand={expandCb}
        onClickIndex={handleClick}
        onFocusItem={focusCb}
        groupKey={groupKey}
        getDragPayload={getDragPayload}
        renaming={renaming}
        renameValidate={renameValidate}
        onRenameCommit={renameCommitCb}
        onRenameCancel={renameCancelCb}
      />
    );
  };

  const renderAsset = (asset: CBAsset, index: number, tabIndex: number, favorite: boolean, renaming: boolean, groupKey?: string): ReactNode => (
    <CBAssetItem
      key={asset.guid}
      asset={asset}
      index={index}
      selected={isSelected(asset)}
      tabIndex={tabIndex}
      thumbnailSize={thumbnailSize}
      favorite={favorite}
      onSelect={selectCb}
      onActivate={activateCb}
      onContextMenu={contextCb}
      onToggleFavorite={favoriteCb}
      onClickIndex={handleClick}
      onFocusItem={focusCb}
      groupKey={groupKey}
      renaming={renaming}
      renameValidate={renameValidate}
      onRenameCommit={renameCommitCb}
      onRenameCancel={renameCancelCb}
    />
  );

  const tabIndexOf = (item: CBViewItem): number => {
    const key = item.type === 'asset' ? item.guid : item.path;
    return key === tabStopKey ? 0 : -1;
  };
  const renderCard = (item: CBViewItem, index: number): ReactNode => {
    const favorite = isItemFavorite?.(item) ?? false;
    const key = item.type === 'asset' ? item.guid : item.path;
    const renaming = renamingKey != null && renamingKey === key;
    const tabIndex = tabIndexOf(item);
    if (item.type === 'folder') return renderFolder(item, index, tabIndex, favorite, renaming);
    if (item.type === 'file') return renderFileCard(item, index, tabIndex, favorite, renaming);
    return renderAsset(item, index, tabIndex, favorite, renaming);
  };

  // Walk the flat list, folding "expanded file + its contiguous sub-assets" into
  // one inline-unpacked group container. Membership is decided by the file's own
  // `assets` guids so trailing registry-only assets never get swept into a group.
  const nodes: ReactNode[] = [];
  for (let i = 0; i < items.length; ) {
    const item = items[i];
    if (!item) { i++; continue; }
    if (grouping && item.type === 'file' && item.assets.length >= 2 && expandedPacks?.has(item.path)) {
      const groupFile = item;
      const fileIndex = i;
      const guids = new Set(groupFile.assets.map(a => a.guid));
      // Inline unpack: push the parent cover card + its sub-assets straight into
      // the SAME flowing grid (NO full-row band), so they wrap in place exactly
      // like an un-collapsed flat listing. Every card carries `cb-group-member`,
      // whose tint bleeds into the grid gaps so the contiguous run reads as one
      // connected surface even across wrapped rows. The parent card's count badge
      // doubles as the collapse control.
      const parentFavorite = isItemFavorite?.(groupFile) ?? false;
      const parentRenaming = renamingKey != null && renamingKey === groupFile.path;
      nodes.push(renderFileCard(groupFile, fileIndex, tabIndexOf(groupFile), parentFavorite, parentRenaming, true, groupFile.path));
      let j = i + 1;
      for (; j < items.length; j++) {
        const next = items[j];
        if (!next || next.type !== 'asset' || !guids.has(next.guid)) break;
        const favorite = isItemFavorite?.(next) ?? false;
        const renaming = renamingKey != null && renamingKey === next.guid;
        nodes.push(renderAsset(next, j, tabIndexOf(next), favorite, renaming, groupFile.path));
      }
      i = j;
      continue;
    }
    nodes.push(renderCard(item, i));
    i++;
  }

  return (
    <div
      ref={rootRef}
      className={`cb-grid-view cb-fe-grid cb-layout-${layout}${gridDropClass}`}
      style={{ '--cb-thumb': `${thumbnailSize}px` } as CSSProperties}
      onClick={handleBlankClick}
      {...gridDropProps}
    >
      {backdrops.length > 0 && (
        <div className="cb-group-backdrops" aria-hidden="true">
          {backdrops.map(b => (
            <div key={b.key} className="cb-group-backdrop" style={{ left: b.left, top: b.top, width: b.width, height: b.height, borderRadius: b.radius }} />
          ))}
        </div>
      )}
      {nodes}
    </div>
  );
}
