import { useEffect, useRef, useState } from 'react';
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

/** Kind filter as a collapsible dropdown (multi-select, OR semantics). */
function CBKindDropdown({ filter }: { filter: FilterAPI }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Clear only kind filters; leave the search query untouched.
  const clearKinds = () => {
    filter.filters.filter(f => f.active).forEach(f => filter.toggleFilter(f.id));
  };

  const active = filter.filters.filter(f => f.active);
  const triggerLabel =
    active.length === 0 ? 'All Types'
    : active.length === 1 ? active[0]!.label
    : `${active.length} types`;

  return (
    <div className="cb-kind-dropdown" ref={rootRef}>
      <button
        type="button"
        className={`cb-kind-trigger${active.length > 0 ? ' active' : ''}`}
        onClick={() => setOpen(o => !o)}
        title="Filter by asset kind"
      >
        {active.length === 1 && active[0]!.icon && (
          <span className="cb-pill-icon">{active[0]!.icon}</span>
        )}
        <span className="cb-kind-trigger-label">{triggerLabel}</span>
        <span className="cb-kind-caret">▾</span>
      </button>

      {open && (
        <div className="cb-kind-menu" role="listbox">
          <button
            type="button"
            className={`cb-kind-option${active.length === 0 ? ' sel' : ''}`}
            onClick={clearKinds}
          >
            <span className="cb-kind-check">{active.length === 0 ? '✓' : ''}</span>
            <span className="cb-kind-option-label">All Types</span>
          </button>
          <div className="cb-kind-divider" />
          {filter.filters.map(f => (
            <button
              key={f.id}
              type="button"
              className={`cb-kind-option${f.active ? ' sel' : ''}`}
              onClick={() => filter.toggleFilter(f.id)}
            >
              <span className="cb-kind-check">{f.active ? '✓' : ''}</span>
              {f.icon && <span className="cb-pill-icon">{f.icon}</span>}
              <span className="cb-kind-option-label">{f.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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

      <CBKindDropdown filter={filter} />

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
