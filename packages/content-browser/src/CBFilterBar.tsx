import {
  Button,
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

interface Props {
  filter: FilterAPI;
  sort: SortAPI;
  thumbnailSize?: number;
  onThumbnailSizeChange?: (size: number) => void;
}

export function CBFilterBar({ filter, sort, thumbnailSize, onThumbnailSizeChange }: Props) {
  const { t } = useTranslation();
  const sortLabels: Record<CBSortKey, string> = {
    name: t('editor.contentBrowser.sort.name'),
    kind: t('editor.contentBrowser.sort.kind'),
    packModifiedAt: t('editor.contentBrowser.sort.modified'),
    estimatedSize: t('editor.contentBrowser.sort.size'),
  };
  return (
    <div className="cb-filter-bar">
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
          <SelectContent>
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
