import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildKindFilters } from '../asset-kind-filters';
import type { CBAsset, CBFilter } from '../types';

export interface FilterAPI {
  filters: CBFilter[];
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  toggleFilter: (filterId: string) => void;
  clearFilters: () => void;
  activeFilterCount: number;
  applyFilters: (items: CBAsset[]) => CBAsset[];
}

export function useFilter(observedKinds: readonly string[] = []): FilterAPI {
  const filterDefinitions = useMemo(() => buildKindFilters(observedKinds), [observedKinds]);
  const [activeFilterIds, setActiveFilterIds] = useState<ReadonlySet<string>>(() => new Set());
  const [searchQuery, setSearchQuery] = useState('');

  const toggleFilter = useCallback((filterId: string) => {
    setActiveFilterIds(prev => {
      const next = new Set(prev);
      if (next.has(filterId)) next.delete(filterId);
      else next.add(filterId);
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => {
    setActiveFilterIds(new Set());
    setSearchQuery('');
  }, []);

  // Remove hidden active state when a catalog-only kind disappears.
  useEffect(() => {
    const availableIds = new Set(filterDefinitions.map(filter => filter.id));
    setActiveFilterIds(prev => {
      const next = new Set([...prev].filter(id => availableIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [filterDefinitions]);

  const filters = useMemo(
    () => filterDefinitions.map(filter => ({
      ...filter,
      active: activeFilterIds.has(filter.id),
    })),
    [filterDefinitions, activeFilterIds],
  );

  const activeFilterCount = useMemo(() => filters.filter(f => f.active).length, [filters]);

  const applyFilters = useCallback((items: CBAsset[]): CBAsset[] => {
    let result = items;

    const activeKindFilters = filters.filter(f => f.active);
    if (activeKindFilters.length > 0) {
      result = result.filter(item =>
        activeKindFilters.some(f => f.predicate(item))
      );
    }

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter(item =>
        item.name.toLowerCase().includes(q) ||
        item.guid.toLowerCase().startsWith(q) ||
        item.kind.toLowerCase().includes(q)
      );
    }

    return result;
  }, [filters, searchQuery]);

  return { filters, searchQuery, setSearchQuery, toggleFilter, clearFilters, activeFilterCount, applyFilters };
}
