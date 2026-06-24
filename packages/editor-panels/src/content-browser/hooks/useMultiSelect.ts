import { useCallback, useRef, useState } from 'react';
import type { CBAsset, CBFolder, CBSelection } from '../types';

type Selectable = CBAsset | CBFolder;

function itemKey(item: Selectable): string {
  return item.type === 'asset' ? (item as CBAsset).guid : (item as CBFolder).path;
}

export interface MultiSelectAPI {
  selection: CBSelection;
  handleClick: (index: number, e: React.MouseEvent) => void;
  selectAll: () => void;
  clearSelection: () => void;
  isSelected: (item: Selectable) => boolean;
}

/**
 * Multi-select hook supporting:
 * - Single click: select one item
 * - Ctrl/Cmd + click: toggle item in selection
 * - Shift + click: range select from last anchor
 * - Ctrl+A: select all
 */
export function useMultiSelect(items: Selectable[]): MultiSelectAPI {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [primary, setPrimary] = useState<Selectable | null>(null);
  const anchorIndexRef = useRef<number>(-1);

  const handleClick = useCallback((index: number, e: React.MouseEvent) => {
    const item = items[index];
    if (!item) return;
    const key = itemKey(item);

    if (e.shiftKey && anchorIndexRef.current >= 0) {
      const start = Math.min(anchorIndexRef.current, index);
      const end = Math.max(anchorIndexRef.current, index);
      const rangeKeys = items.slice(start, end + 1).map(itemKey);
      if (e.ctrlKey || e.metaKey) {
        setSelectedKeys(prev => new Set([...prev, ...rangeKeys]));
      } else {
        setSelectedKeys(new Set(rangeKeys));
      }
      setPrimary(item);
    } else if (e.ctrlKey || e.metaKey) {
      setSelectedKeys(prev => {
        const next = new Set(prev);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
      setPrimary(item);
      anchorIndexRef.current = index;
    } else {
      setSelectedKeys(new Set([key]));
      setPrimary(item);
      anchorIndexRef.current = index;
    }
  }, [items]);

  const selectAll = useCallback(() => {
    setSelectedKeys(new Set(items.map(itemKey)));
    setPrimary(items[items.length - 1] ?? null);
  }, [items]);

  const clearSelection = useCallback(() => {
    setSelectedKeys(new Set());
    setPrimary(null);
    anchorIndexRef.current = -1;
  }, []);

  const isSelected = useCallback((item: Selectable): boolean => {
    return selectedKeys.has(itemKey(item));
  }, [selectedKeys]);

  const selection: CBSelection = {
    items: items.filter(i => selectedKeys.has(itemKey(i))),
    primary,
  };

  return { selection, handleClick, selectAll, clearSelection, isSelected };
}
