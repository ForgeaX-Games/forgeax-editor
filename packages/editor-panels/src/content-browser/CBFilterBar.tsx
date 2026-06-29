import type { FilterAPI, SortAPI } from './hooks';
import type { CBSortKey, CBViewMode } from './types';

interface Props {
  filter: FilterAPI;
  sort: SortAPI;
  viewMode: CBViewMode;
  onViewModeChange: (mode: CBViewMode) => void;
  thumbnailSize?: number;
  onThumbnailSizeChange?: (size: number) => void;
}

const SORT_LABELS: Record<CBSortKey, string> = {
  name: 'Name',
  kind: 'Kind',
  packModifiedAt: 'Modified',
  estimatedSize: 'Size',
};

export function CBFilterBar({ filter, sort, viewMode, onViewModeChange, thumbnailSize, onThumbnailSizeChange }: Props) {
  return (
    <div className="cb-filter-bar">
      <div className="cb-search-box">
        <input
          type="text"
          placeholder="Search assets…"
          value={filter.searchQuery}
          onChange={e => filter.setSearchQuery(e.target.value)}
          className="cb-search-input"
        />
        {filter.searchQuery && (
          <button className="cb-search-clear" onClick={() => filter.setSearchQuery('')}>×</button>
        )}
      </div>

      <div className="cb-filter-pills">
        {filter.filters.map(f => (
          <button
            key={f.id}
            className={`cb-filter-pill${f.active ? ' active' : ''}`}
            onClick={() => filter.toggleFilter(f.id)}
            title={f.label}
          >
            {f.icon && <span className="cb-pill-icon">{f.icon}</span>}
            <span className="cb-pill-label">{f.label}</span>
          </button>
        ))}
        {filter.activeFilterCount > 0 && (
          <button className="cb-filter-clear" onClick={filter.clearFilters}>Clear</button>
        )}
      </div>

      <div className="cb-view-controls">
        <select
          className="cb-sort-select"
          value={sort.sortState.key}
          onChange={e => sort.setSortKey(e.target.value as CBSortKey)}
        >
          {Object.entries(SORT_LABELS).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        <button className="cb-sort-dir" onClick={sort.toggleDir} title="Toggle sort direction">
          {sort.sortState.dir === 'asc' ? '↑' : '↓'}
        </button>

        {viewMode === 'grid' && thumbnailSize != null && onThumbnailSizeChange && (
          <>
            <span className="cb-view-separator" />
            <input
              type="range"
              className="cb-thumb-slider"
              min={48}
              max={200}
              step={4}
              value={thumbnailSize}
              onChange={e => onThumbnailSizeChange(Number(e.target.value))}
              title={`Thumbnail size: ${thumbnailSize}px`}
            />
          </>
        )}

        <span className="cb-view-separator" />

        <button
          className={`cb-view-btn${viewMode === 'grid' ? ' on' : ''}`}
          onClick={() => onViewModeChange('grid')}
          title="Grid view"
        >⊞</button>
        <button
          className={`cb-view-btn${viewMode === 'list' ? ' on' : ''}`}
          onClick={() => onViewModeChange('list')}
          title="List view"
        >≡</button>
        <button
          className={`cb-view-btn${viewMode === 'column' ? ' on' : ''}`}
          onClick={() => onViewModeChange('column')}
          title="Column view"
        >⊟</button>
      </div>
    </div>
  );
}
