import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { CBAsset, CBFile, CBFolder, CBSelection } from '../types';
import {
  gateway,
  useAssetSelectionList,
  useAssetSelection,
  clearAssetSelection,
  registerAssetSelectAllHandler,
  useFolderSelectionSet,
} from '@forgeax/editor-core';

type Selectable = CBAsset | CBFolder | CBFile;

function itemKey(item: Selectable): string {
  return item.type === 'asset' ? (item as CBAsset).guid : item.path;
}

/** Map a CBAsset to the store's SelectedAsset shape (single source of truth). */
function toSelectedAsset(a: CBAsset) {
  return { guid: a.guid, kind: a.kind, name: a.name, payload: a.payload, packPath: a.packPath };
}

export interface MultiSelectAPI {
  selection: CBSelection;
  handleClick: (index: number, e: React.MouseEvent) => void;
  selectAll: () => void;
  clearSelection: () => void;
  isSelected: (item: Selectable) => boolean;
}

/**
 * Multi-select hook — M3 T3-1 thin-shell over the asset-selection store.
 *
 * Selection is now a SESSION-domain op (setAssetSelection): the store is the SSOT
 * and `useAssetSelectionList` is the reactive read. This hook no longer holds its
 * own selection state; every mutation batches the FINAL selection set and
 * dispatches one `setAssetSelection` op (batching — T0-6), so the global keyboard
 * router (which dispatches the same op) and the mouse here share one source of
 * truth and stay in sync (no dual-state drift, AC-B3).
 *
 * `anchorIndexRef` stays a purely local UI concept (shift-range anchor); it is NOT
 * part of the op payload (C2-3).
 */
export function useMultiSelect(items: Selectable[]): MultiSelectAPI {
  const selectedList = useAssetSelectionList();
  const primary = useAssetSelection();
  const selectedGuids = useMemo(() => new Set(selectedList.map((a) => a.guid)), [selectedList]);
  const anchorIndexRef = useRef<number>(-1);

  // D3a: folder selection paths (reactive, driven by setFolderSelection session op).
  const folderPaths = useFolderSelectionSet();

  const dispatchSet = useCallback((next: Selectable[], primaryItem: Selectable | null) => {
    const assets = next
      .filter((i): i is CBAsset => i.type === 'asset')
      .map(toSelectedAsset);
    const p = primaryItem && primaryItem.type === 'asset'
      ? toSelectedAsset(primaryItem as CBAsset)
      : (assets[0] ?? null);
    gateway.dispatch({ kind: 'setAssetSelection', assets, primary: p });
  }, []);

  const handleClick = useCallback((index: number, e: React.MouseEvent) => {
    const item = items[index];
    if (!item) return;
    // D3a: folder clicks dispatch setFolderSelection (session op, AI parity).
    if (item.type === 'folder') {
      // Clear asset selection (mutually exclusive).
      clearAssetSelection();
      gateway.dispatch({ kind: 'setFolderSelection', paths: [item.path] });
      anchorIndexRef.current = index;
      return;
    }
    if (item.type === 'file') {
      clearAssetSelection();
      gateway.dispatch({ kind: 'setFolderSelection', paths: [] });
      anchorIndexRef.current = index;
      return;
    }
    const key = itemKey(item);
    let next: Selectable[];
    if (e.shiftKey && anchorIndexRef.current >= 0) {
      const start = Math.min(anchorIndexRef.current, index);
      const end = Math.max(anchorIndexRef.current, index);
      next = items.slice(start, end + 1);
    } else if (e.ctrlKey || e.metaKey) {
      const base = items.filter((i) => selectedGuids.has(itemKey(i)));
      if (selectedGuids.has(key)) next = base.filter((i) => itemKey(i) !== key);
      else next = [...base, item];
    } else {
      next = [item];
    }
    dispatchSet(next, item);
    anchorIndexRef.current = index;
  }, [items, selectedGuids, dispatchSet]);

  const selectAll = useCallback(() => {
    dispatchSet(items, items[items.length - 1] ?? null);
  }, [items, dispatchSet]);

  const clearSelection = useCallback(() => {
    clearAssetSelection();
  }, []);

  const isSelected = useCallback(
    (item: Selectable): boolean => {
      if (item.type === 'folder') {
        return folderPaths.has(item.path);
      }
      if (item.type === 'file') return false;
      return selectedGuids.has(itemKey(item));
    },
    [selectedGuids, folderPaths],
  );

  // Bridge Ctrl+A (asset scope) from the global keyboard router to this hook's
  // live item list. Registered on mount, cleared on unmount.
  useEffect(() => {
    registerAssetSelectAllHandler(() => selectAll());
    return () => registerAssetSelectAllHandler(null);
  }, [selectAll]);

  // selection mirrors the store (so the router's dispatch is reflected here too).
  const selection: CBSelection = {
    items: items.filter((i) => selectedGuids.has(itemKey(i))),
    primary: (primary
      ? (items.find((i) => i.type === 'asset' && (i as CBAsset).guid === primary.guid) ?? null)
      : null) as CBSelection['primary'],
  };

  return { selection, handleClick, selectAll, clearSelection, isSelected };
}
