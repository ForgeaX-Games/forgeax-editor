import { useCallback, useState } from 'react';
import type { CBAsset, CBSortDir, CBSortKey, CBSortState } from '../types';

const COMPARATORS: Record<CBSortKey, (a: CBAsset, b: CBAsset) => number> = {
  name: (a, b) => a.name.localeCompare(b.name),
  kind: (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
  packModifiedAt: (a, b) => (b.packModifiedAt ?? 0) - (a.packModifiedAt ?? 0),
  estimatedSize: (a, b) => (b.estimatedSize ?? 0) - (a.estimatedSize ?? 0),
};

export interface SortAPI {
  sortState: CBSortState;
  setSortKey: (key: CBSortKey) => void;
  toggleDir: () => void;
  sortItems: (items: CBAsset[]) => CBAsset[];
}

export function useSort(initialKey: CBSortKey = 'name', initialDir: CBSortDir = 'asc'): SortAPI {
  const [sortState, setSortState] = useState<CBSortState>({ key: initialKey, dir: initialDir });

  const setSortKey = useCallback((key: CBSortKey) => {
    setSortState(prev => ({
      key,
      dir: prev.key === key ? (prev.dir === 'asc' ? 'desc' : 'asc') : 'asc',
    }));
  }, []);

  const toggleDir = useCallback(() => {
    setSortState(prev => ({ ...prev, dir: prev.dir === 'asc' ? 'desc' : 'asc' }));
  }, []);

  const sortItems = useCallback((items: CBAsset[]): CBAsset[] => {
    const cmp = COMPARATORS[sortState.key];
    const sorted = [...items].sort(cmp);
    return sortState.dir === 'desc' ? sorted.reverse() : sorted;
  }, [sortState]);

  return { sortState, setSortKey, toggleDir, sortItems };
}
