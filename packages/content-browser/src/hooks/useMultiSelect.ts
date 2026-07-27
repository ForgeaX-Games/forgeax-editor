import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { CBAsset, CBFile, CBFolder, CBSelection } from '../types';
import {
  gateway,
  useAssetSelectionList,
  useAssetSelection,
  clearAssetSelection,
  registerAssetSelectAllHandler,
  useFolderSelectionSet,
  type PathSelectionItem,
} from '@forgeax/editor-core';

type Selectable = CBAsset | CBFolder | CBFile;

function itemKey(item: Selectable): string {
  return item.type === 'asset' ? (item as CBAsset).guid : item.path;
}

/** Map a CBAsset to the store's SelectedAsset shape (single source of truth). */
function toSelectedAsset(a: CBAsset) {
  return { guid: a.guid, kind: a.kind, name: a.name, payload: a.payload, packPath: a.packPath };
}

/** Map a folder/file item to the typed PathSelectionItem for the store. */
function toPathItem(item: CBFolder | CBFile): PathSelectionItem {
  return { path: item.path, kind: item.type === 'folder' ? 'dir' : 'file' };
}

export interface MultiSelectAPI {
  selection: CBSelection;
  handleClick: (index: number, e: React.MouseEvent) => void;
  selectAll: () => void;
  clearSelection: () => void;
  isSelected: (item: Selectable) => boolean;
}

/**
 * Multi-select hook — unified selection for ALL content browser item types.
 *
 * Plan-E: Ctrl+Click / Shift+Click work uniformly across assets, folders, and
 * files. Each click batches the FINAL selection set and dispatches BOTH
 * `setAssetSelection` (for engine assets) and `setFolderSelection` (for
 * folder/file paths, carrying item kind for correct Delete routing).
 *
 * Domain invariant: the folder-selection store has a dedup guard (empty→empty
 * is a no-op) and last-selection-domain only advances when the new selection is
 * non-empty. This prevents "clicking an asset" from polluting domain to 'folder'.
 *
 * `anchorIndexRef` stays a purely local UI concept (shift-range anchor); it is
 * NOT part of the op payload (C2-3).
 */
export function useMultiSelect(items: Selectable[]): MultiSelectAPI {
  const selectedList = useAssetSelectionList();
  const primary = useAssetSelection();
  const selectedGuids = useMemo(() => new Set(selectedList.map((a) => a.guid)), [selectedList]);
  const anchorIndexRef = useRef<number>(-1);

  // D3a: folder/file selection paths (reactive, driven by setFolderSelection session op).
  const folderPaths = useFolderSelectionSet();

  const isItemSelected = useCallback((item: Selectable): boolean => {
    if (item.type === 'folder' || item.type === 'file') return folderPaths.has(item.path);
    return selectedGuids.has(itemKey(item));
  }, [selectedGuids, folderPaths]);

  /** Dispatch both selection ops from the unified batch. The stores' dedup
   *  guards ensure empty dispatches don't pollute lastSelectionDomain. */
  const dispatchSet = useCallback((next: Selectable[], primaryItem: Selectable | null) => {
    const assets = next
      .filter((i): i is CBAsset => i.type === 'asset')
      .map(toSelectedAsset);
    const pathItems: PathSelectionItem[] = next
      .filter((i): i is CBFolder | CBFile => i.type === 'folder' || i.type === 'file')
      .map(toPathItem);
    const p = primaryItem && primaryItem.type === 'asset'
      ? toSelectedAsset(primaryItem as CBAsset)
      : (assets[0] ?? null);
    gateway.dispatch({ kind: 'setAssetSelection', assets, primary: p });
    gateway.dispatch({ kind: 'setFolderSelection', items: pathItems });
  }, []);

  // Read `items` / `isItemSelected` through latest-refs so the click/select-all
  // handlers keep a STABLE identity across renders and across selection changes.
  // These handlers are passed down to every memo'd grid item; if they changed
  // identity (as they would with `items`/`isItemSelected` in the dep array) a
  // single selection change would re-render EVERY item instead of only the ones
  // whose `selected` flag flips. dispatchSet is already stable ([] deps).
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const isSelectedRef = useRef(isItemSelected);
  isSelectedRef.current = isItemSelected;

  const handleClick = useCallback((index: number, e: React.MouseEvent) => {
    const list = itemsRef.current;
    const isSel = isSelectedRef.current;
    const item = list[index];
    if (!item) return;
    const key = itemKey(item);
    let next: Selectable[];
    if (e.shiftKey && anchorIndexRef.current >= 0) {
      const start = Math.min(anchorIndexRef.current, index);
      const end = Math.max(anchorIndexRef.current, index);
      next = list.slice(start, end + 1);
    } else if (e.ctrlKey || e.metaKey) {
      const base = list.filter(isSel);
      if (isSel(item)) next = base.filter((i) => itemKey(i) !== key);
      else next = [...base, item];
    } else {
      next = [item];
    }
    dispatchSet(next, item);
    anchorIndexRef.current = index;
  }, [dispatchSet]);

  const selectAll = useCallback(() => {
    const list = itemsRef.current;
    dispatchSet(list, list[list.length - 1] ?? null);
  }, [dispatchSet]);

  const clearSelection = useCallback(() => {
    clearAssetSelection();
    gateway.dispatch({ kind: 'setFolderSelection', items: [] });
  }, []);

  const isSelected = isItemSelected;

  // Bridge Ctrl+A (asset scope) from the global keyboard router to this hook's
  // live item list. Registered on mount, cleared on unmount.
  useEffect(() => {
    registerAssetSelectAllHandler(() => selectAll());
    return () => registerAssetSelectAllHandler(null);
  }, [selectAll]);

  // selection mirrors both stores (so the router's dispatch is reflected here too).
  const selection: CBSelection = {
    items: items.filter(isItemSelected),
    primary: (primary
      ? (items.find((i) => i.type === 'asset' && (i as CBAsset).guid === primary.guid) ?? null)
      : null) as CBSelection['primary'],
  };

  return { selection, handleClick, selectAll, clearSelection, isSelected };
}
