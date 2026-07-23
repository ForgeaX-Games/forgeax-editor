import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { ALL_FILTER_FAMILIES, FAMILY_FILTER_ICON } from '../family-filters';
import { fileKindLabel } from '../content-browser-format';
import type { CBAsset, CBFile, CBFilter, CBFilterFamily } from '../types';

export interface FilterAPI {
  filters: CBFilter[];
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  toggleFilter: (filterId: string) => void;
  clearFilters: () => void;
  activeFilterCount: number;
  /** Search-only projection for registry-only assets (family filter never
   * matches file-less catalog assets). */
  applyFilters: (items: CBAsset[]) => CBAsset[];
  /** Family filter for disk files (true = keep). */
  matchesFile: (file: CBFile) => boolean;
  /** Family filter for folders (true = keep) — gated by the `dir` bucket. */
  matchesFolder: () => boolean;
}

function familyLabel(family: CBFilterFamily, t: ReturnType<typeof useTranslation>['t']): string {
  return family === 'dir' ? t('editor.contentBrowser.fileKinds.dir') : fileKindLabel(t, family);
}

export function useFilter(): FilterAPI {
  const { t } = useTranslation();
  const [activeFamilies, setActiveFamilies] = useState<ReadonlySet<CBFilterFamily>>(() => new Set());
  const [searchQuery, setSearchQuery] = useState('');

  const toggleFilter = useCallback((filterId: string) => {
    const family = filterId.split(':').pop() as CBFilterFamily;
    setActiveFamilies(prev => {
      const next = new Set(prev);
      if (next.has(family)) next.delete(family);
      else next.add(family);
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => {
    setActiveFamilies(new Set());
  }, []);

  // Fixed spec-defined family chips — the type filter is static, independent of
  // what the current folder contains.
  const filters = useMemo<CBFilter[]>(
    () => ALL_FILTER_FAMILIES.map(family => ({
      id: `family:${family}`,
      family,
      label: familyLabel(family, t),
      icon: FAMILY_FILTER_ICON[family],
      active: activeFamilies.has(family),
    })),
    [activeFamilies, t],
  );

  const activeFilterCount = useMemo(() => activeFamilies.size, [activeFamilies]);

  const matchesFile = useCallback(
    (file: CBFile) => activeFamilies.size === 0 || activeFamilies.has(file.family),
    [activeFamilies],
  );

  const matchesFolder = useCallback(
    () => activeFamilies.size === 0 || activeFamilies.has('dir'),
    [activeFamilies],
  );

  const applyFilters = useCallback((items: CBAsset[]): CBAsset[] => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return items;
    return items.filter(item =>
      item.name.toLowerCase().includes(q) ||
      item.guid.toLowerCase().startsWith(q) ||
      item.kind.toLowerCase().includes(q)
    );
  }, [searchQuery]);

  return {
    filters, searchQuery, setSearchQuery, toggleFilter, clearFilters,
    activeFilterCount, applyFilters, matchesFile, matchesFolder,
  };
}
