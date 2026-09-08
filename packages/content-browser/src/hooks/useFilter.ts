import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { ALL_FILTER_FAMILIES, FAMILY_FILTER_ICON } from '../family-filters';
import { fileKindLabel } from '../content-browser-format';
import { ASSET_KIND_ICON_NAMES, labelForAssetKind } from '../content-browser-icons';
import type { CBAsset, CBFile, CBFilter, CBFilterFamily, CBKindFilter } from '../types';

// Asset-kind chips shown under the file-family section. Curated to the kinds an
// author actually filters by; each has an icon in ASSET_KIND_ICON_NAMES and a
// label in the assetKinds i18n namespace.
const FILTERABLE_ASSET_KINDS = [
  'mesh',
  'material',
  'texture',
  'cube-texture',
  'animation-clip',
  'skeleton',
  'scene',
] as const;

export interface FilterAPI {
  filters: CBFilter[];
  /** Asset-kind chips (second filter axis). */
  kindFilters: CBKindFilter[];
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  /** Toggle a chip by id (`family:*` or `kind:*`). */
  toggleFilter: (filterId: string) => void;
  clearFilters: () => void;
  activeFilterCount: number;
  /** True when any asset-kind chip is active → the grid switches to the
   *  asset-centric flat view. */
  kindFilterActive: boolean;
  /** Search-only projection for registry-only assets (family filter never
   * matches file-less catalog assets). */
  applyFilters: (items: CBAsset[]) => CBAsset[];
  /** Family filter for disk files (true = keep). */
  matchesFile: (file: CBFile) => boolean;
  /** Family filter for folders (true = keep) — gated by the `dir` bucket. */
  matchesFolder: () => boolean;
  /** Asset-kind filter (true = keep). No active kind → keep all. */
  matchesAsset: (asset: CBAsset) => boolean;
}

function familyLabel(family: CBFilterFamily, t: ReturnType<typeof useTranslation>['t']): string {
  return family === 'dir' ? t('editor.contentBrowser.fileKinds.dir') : fileKindLabel(t, family);
}

export function useFilter(): FilterAPI {
  const { t } = useTranslation();
  const [activeFamilies, setActiveFamilies] = useState<ReadonlySet<CBFilterFamily>>(() => new Set());
  const [activeKinds, setActiveKinds] = useState<ReadonlySet<string>>(() => new Set());
  const [searchQuery, setSearchQuery] = useState('');

  const toggleFilter = useCallback((filterId: string) => {
    const [scope, value] = filterId.split(':');
    if (scope === 'kind') {
      setActiveKinds(prev => {
        const next = new Set(prev);
        if (next.has(value!)) next.delete(value!); else next.add(value!);
        return next;
      });
      return;
    }
    setActiveFamilies(prev => {
      const next = new Set(prev);
      const family = value as CBFilterFamily;
      if (next.has(family)) next.delete(family); else next.add(family);
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => {
    setActiveFamilies(new Set());
    setActiveKinds(new Set());
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

  const kindFilters = useMemo<CBKindFilter[]>(
    () => FILTERABLE_ASSET_KINDS.map(kind => ({
      id: `kind:${kind}`,
      kind,
      label: labelForAssetKind(kind, t),
      icon: ASSET_KIND_ICON_NAMES[kind] ?? 'package',
      active: activeKinds.has(kind),
    })),
    [activeKinds, t],
  );

  const activeFilterCount = useMemo(
    () => activeFamilies.size + activeKinds.size,
    [activeFamilies, activeKinds],
  );
  const kindFilterActive = activeKinds.size > 0;

  const matchesFile = useCallback(
    (file: CBFile) => activeFamilies.size === 0 || activeFamilies.has(file.family),
    [activeFamilies],
  );

  const matchesFolder = useCallback(
    () => activeFamilies.size === 0 || activeFamilies.has('dir'),
    [activeFamilies],
  );

  const matchesAsset = useCallback(
    (asset: CBAsset) => activeKinds.size === 0 || activeKinds.has(asset.kind),
    [activeKinds],
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
    filters, kindFilters, searchQuery, setSearchQuery, toggleFilter, clearFilters,
    activeFilterCount, kindFilterActive, applyFilters, matchesFile, matchesFolder, matchesAsset,
  };
}
