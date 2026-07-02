import { useCallback, useMemo, useState } from 'react';
import { ASSET_KINDS, type AssetKind, type CBAsset, type CBFilter } from '../types';

const KIND_ICONS: Record<AssetKind, string> = {
  mesh: '◫', texture: '🖼', image: '🖼', 'cube-texture': '🧊', sampler: '⚙',
  material: '🎨', scene: '🗺', shader: '📜', skeleton: '🦴',
  skin: '🩻', 'animation-clip': '🎬', audio: '🔊', font: '🔤',
  'render-pipeline': '🔧', tileset: '🧱',
};

const KIND_LABELS: Record<AssetKind, string> = {
  mesh: 'Mesh', texture: 'Texture', image: 'Image', 'cube-texture': 'Cube Texture',
  sampler: 'Sampler', material: 'Material', scene: 'Scene',
  shader: 'Shader', skeleton: 'Skeleton', skin: 'Skin',
  'animation-clip': 'Animation Clip', audio: 'Audio', font: 'Font',
  'render-pipeline': 'Render Pipeline', tileset: 'Tileset',
};

function buildKindFilters(): CBFilter[] {
  return ASSET_KINDS.map(kind => ({
    id: `kind:${kind}`,
    label: KIND_LABELS[kind],
    icon: KIND_ICONS[kind],
    predicate: (item: CBAsset) => item.kind === kind,
    active: false,
  }));
}

export interface FilterAPI {
  filters: CBFilter[];
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  toggleFilter: (filterId: string) => void;
  clearFilters: () => void;
  activeFilterCount: number;
  applyFilters: (items: CBAsset[]) => CBAsset[];
}

export function useFilter(): FilterAPI {
  const [filters, setFilters] = useState<CBFilter[]>(buildKindFilters);
  const [searchQuery, setSearchQuery] = useState('');

  const toggleFilter = useCallback((filterId: string) => {
    setFilters(prev => prev.map(f =>
      f.id === filterId ? { ...f, active: !f.active } : f
    ));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters(prev => prev.map(f => ({ ...f, active: false })));
    setSearchQuery('');
  }, []);

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
