import {
  Button,
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Slider,
} from '@forgeax/editor-ui';
import {
  ArrowDownWideNarrow,
  ArrowUpDown,
  ArrowUpNarrowWide,
  CaseSensitive,
  Clock,
  Filter,
  HardDrive,
  Search,
  Shapes,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from '@forgeax/editor-core/i18n';
import type { FilterAPI, SortAPI } from './hooks';
import type { CBSortDir, CBSortKey } from './types';
import { ContentBrowserIcon, FILE_FAMILY_ICON_NAMES } from './content-browser-icons';
import { CONTENT_BROWSER_INTERACTION_SCOPE } from './interaction-surface';

interface Props {
  filter: FilterAPI;
  sort: SortAPI;
  thumbnailSize?: number;
  onThumbnailSizeChange?: (size: number) => void;
}

const SORT_KEYS: readonly CBSortKey[] = ['name', 'kind', 'packModifiedAt', 'estimatedSize'];
const SORT_KEY_ICONS: Record<CBSortKey, LucideIcon> = {
  name: CaseSensitive,
  kind: Shapes,
  packModifiedAt: Clock,
  estimatedSize: HardDrive,
};
const SORT_DIRS: readonly (readonly [CBSortDir, LucideIcon])[] = [
  ['asc', ArrowUpNarrowWide],
  ['desc', ArrowDownWideNarrow],
];

export function CBFilterBar({ filter, sort, thumbnailSize, onThumbnailSizeChange }: Props) {
  const { t } = useTranslation();
  const activeFilters = filter.filters.filter(item => item.active);
  const filterLabel = activeFilters.length === 0
    ? t('editor.contentBrowser.actions.filterAll')
    : activeFilters.length === 1
      ? activeFilters[0]!.label
      : t('editor.contentBrowser.actions.filterByType');
  const sortLabels: Record<CBSortKey, string> = {
    name: t('editor.contentBrowser.sort.name'),
    kind: t('editor.contentBrowser.sort.kind'),
    packModifiedAt: t('editor.contentBrowser.sort.modified'),
    estimatedSize: t('editor.contentBrowser.sort.size'),
  };
  return (
    <div className="cb-filter-bar">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="subtle"
            className={`cb-filter-trigger${activeFilters.length > 0 ? ' is-active' : ''}`}
            aria-label={t('editor.contentBrowser.actions.filterByType')}
          >
            <Filter />
            {filterLabel}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" interactionScope={CONTENT_BROWSER_INTERACTION_SCOPE}>
          <DropdownMenuLabel>{t('editor.contentBrowser.actions.filterByType')}</DropdownMenuLabel>
          {filter.filters.map(item => (
            <DropdownMenuItem
              key={item.id}
              size="sm"
              className="cb-filter-option"
              data-active={item.active ? 'true' : 'false'}
              onSelect={(event) => {
                // Keep the menu open so several families can be toggled at once.
                event.preventDefault();
                filter.toggleFilter(item.id);
              }}
            >
              <Checkbox size="menu" checked={item.active} tabIndex={-1} className="pointer-events-none" />
              <ContentBrowserIcon name={FILE_FAMILY_ICON_NAMES[item.family]} className="cb-filter-option-icon" />
              {item.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            size="sm"
            disabled={filter.activeFilterCount === 0}
            onSelect={filter.clearFilters}
          >
            {t('editor.contentBrowser.actions.clearFilters')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="cb-search-box">
        <Search className="cb-search-icon" aria-hidden="true" />
        <input
          className="cb-search-input"
          type="text"
          placeholder={t('editor.contentBrowser.actions.searchPlaceholder')}
          value={filter.searchQuery}
          onChange={e => filter.setSearchQuery(e.target.value)}
        />
        {filter.searchQuery && (
          <IconButton
            aria-label={t('editor.contentBrowser.actions.clearSearch')}
            className="cb-search-clear"
            size="sm"
            variant="chrome"
            onClick={() => filter.setSearchQuery('')}
          >
            <X />
          </IconButton>
        )}
      </div>

      <div className="cb-view-controls">
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="subtle"
              className="cb-sort-trigger"
              aria-label={t('editor.contentBrowser.actions.sortDirection')}
            >
              <ArrowUpDown />
              {sortLabels[sort.sortState.key]}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" interactionScope={CONTENT_BROWSER_INTERACTION_SCOPE}>
            <DropdownMenuLabel>{t('editor.contentBrowser.sort.by')}</DropdownMenuLabel>
            {SORT_KEYS.map(key => {
              const active = sort.sortState.key === key;
              const Icon = SORT_KEY_ICONS[key];
              return (
                <DropdownMenuItem
                  key={key}
                  size="sm"
                  className="cb-filter-option"
                  data-active={active ? 'true' : 'false'}
                  onSelect={(event) => {
                    // Mirror the filter menu: keep it open so the key + order can
                    // both be set in one visit.
                    event.preventDefault();
                    sort.setSortKey(key);
                  }}
                >
                  <span className="cb-radio-menu" data-checked={active ? 'true' : 'false'} aria-hidden="true" />
                  <Icon className="cb-filter-option-icon" />
                  {sortLabels[key]}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t('editor.contentBrowser.sort.order')}</DropdownMenuLabel>
            {SORT_DIRS.map(([dir, Icon]) => {
              const active = sort.sortState.dir === dir;
              return (
                <DropdownMenuItem
                  key={dir}
                  size="sm"
                  className="cb-filter-option"
                  data-active={active ? 'true' : 'false'}
                  onSelect={(event) => {
                    event.preventDefault();
                    if (sort.sortState.dir !== dir) sort.toggleDir();
                  }}
                >
                  <span className="cb-radio-menu" data-checked={active ? 'true' : 'false'} aria-hidden="true" />
                  <Icon className="cb-filter-option-icon" />
                  {t(dir === 'asc' ? 'editor.contentBrowser.sort.asc' : 'editor.contentBrowser.sort.desc')}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        {thumbnailSize != null && onThumbnailSizeChange && (
          <Slider
            className="cb-thumb-slider"
            size="sm"
            min={48}
            max={200}
            step={4}
            value={thumbnailSize}
            onChange={e => onThumbnailSizeChange(Number(e.target.value))}
            title={t('editor.contentBrowser.actions.thumbnailSize', { size: thumbnailSize })}
          />
        )}
      </div>
    </div>
  );
}
