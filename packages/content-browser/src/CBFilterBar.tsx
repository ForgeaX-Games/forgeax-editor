import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider,
} from '@forgeax/editor-ui';
import { useTranslation } from '@forgeax/editor-core/i18n';
import type { FilterAPI, SortAPI } from './hooks';
import type { CBSortKey } from './types';
import { CONTENT_BROWSER_INTERACTION_SCOPE } from './interaction-surface';

interface Props {
  filter: FilterAPI;
  sort: SortAPI;
  thumbnailSize?: number;
  onThumbnailSizeChange?: (size: number) => void;
}

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
            aria-label={t('editor.contentBrowser.actions.filterByType')}
          >
            {filterLabel}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" interactionScope={CONTENT_BROWSER_INTERACTION_SCOPE}>
          <DropdownMenuLabel>{t('editor.contentBrowser.actions.filterByType')}</DropdownMenuLabel>
          {filter.filters.map(item => (
            <DropdownMenuCheckboxItem
              key={item.id}
              size="sm"
              checked={item.active}
              onCheckedChange={() => filter.toggleFilter(item.id)}
            >
              {item.label}
            </DropdownMenuCheckboxItem>
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
        <Input
          size="sm"
          type="text"
          placeholder={t('editor.contentBrowser.actions.searchPlaceholder')}
          value={filter.searchQuery}
          onChange={e => filter.setSearchQuery(e.target.value)}
          className="cb-search-input"
        />
        {filter.searchQuery && (
          <IconButton
            aria-label={t('editor.contentBrowser.actions.clearSearch')}
            className="cb-search-clear"
            size="sm"
            variant="chrome"
            onClick={() => filter.setSearchQuery('')}
          >
            ×
          </IconButton>
        )}
      </div>

      <div className="cb-view-controls">
        <Select
          value={sort.sortState.key}
          onValueChange={(value) => sort.setSortKey(value as CBSortKey)}
        >
          <SelectTrigger className="cb-sort-select" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent interactionScope={CONTENT_BROWSER_INTERACTION_SCOPE}>
            {Object.entries(sortLabels).map(([key, label]) => (
              <SelectItem key={key} size="sm" value={key}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button className="cb-sort-dir" size="sm" variant="subtle" onClick={sort.toggleDir} title={t('editor.contentBrowser.actions.sortDirection')}>
          {sort.sortState.dir === 'asc' ? '↑' : '↓'}
        </Button>

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
