import { memo, useCallback, type MouseEvent } from 'react';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { colorForFileFamily, ContentBrowserIcon, FileFamilyIcon } from './content-browser-icons';
import type { CBFile } from './types';

interface Props {
  file: CBFile;
  index: number;
  selected: boolean;
  expanded?: boolean;
  expandable?: boolean;
  favorite?: boolean;
  // List-level, referentially STABLE callbacks — the leaf composes its own
  // per-item handlers internally so these props never change identity across
  // renders (which is what lets memo() skip an unchanged card).
  onSelect: (item: CBFile) => void;
  onActivate: (item: CBFile) => void;
  onContextMenu: (e: MouseEvent, item: CBFile) => void;
  onToggleFavorite: (item: CBFile) => void;
  onToggleExpand: (path: string) => void;
  onClickIndex: (index: number, e: MouseEvent) => void;
}

interface FileDragDataTransfer {
  setData(type: string, data: string): void;
  effectAllowed: string;
}

/** File cards stay file subjects: callers must expand catalogued sub-assets
 * before starting an asset placement drag. */
export function writeFileDragData(
  file: Pick<CBFile, 'path' | 'diskPath' | 'name' | 'family'>,
  dataTransfer: FileDragDataTransfer,
): void {
  dataTransfer.setData('text/plain', `@${file.name}`);
  dataTransfer.setData('application/x-forgeax-file', JSON.stringify({
    path: file.path, diskPath: file.diskPath, name: file.name, family: file.family,
  }));
  dataTransfer.effectAllowed = 'copy';
}

function CBFileItemImpl({
  file,
  index,
  selected,
  expanded,
  expandable = false,
  favorite,
  onSelect,
  onActivate,
  onContextMenu,
  onToggleFavorite,
  onToggleExpand,
  onClickIndex,
}: Props) {
  const { t } = useTranslation();
  const fav = favorite ?? file.isFavorite;
  const hasAssets = file.assets.length > 0;
  const metaLabel = hasAssets ? t('editor.contentBrowser.preview.assetCount', { count: file.assets.length }) : file.kindLabel;
  const metaColor = hasAssets ? 'var(--accent-mint, #63eacf)' : colorForFileFamily(file.family);

  const handleClick = useCallback((e: MouseEvent) => {
    onSelect(file);
    onClickIndex(index, e);
  }, [onSelect, onClickIndex, file, index]);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    writeFileDragData(file, e.dataTransfer);
  }, [file]);

  return (
    <div
      className={`cb-grid-item cb-fe-card cb-file-card${selected ? ' sel' : ''}${expanded ? ' cb-pack-expanded' : ''}`}
      data-testid="cb-file-item"
      data-file-path={file.path}
      draggable
      onDragStart={handleDragStart}
      onClick={handleClick}
      onDoubleClick={() => onActivate(file)}
      onContextMenu={e => { e.preventDefault(); onContextMenu(e, file); }}
      title={file.path}
    >
      <span
        className={`cb-card-fav${fav ? ' on' : ''}`}
        title={t(fav ? 'editor.contentBrowser.contextMenu.unfavorite' : 'editor.contentBrowser.contextMenu.favorite')}
        onClick={e => { e.stopPropagation(); onToggleFavorite(file); }}
      ><ContentBrowserIcon name="star" /></span>
      {expandable && (
        <button
          type="button"
          className={`cb-pack-expand-btn${expanded ? ' open' : ''}`}
          onClick={e => { e.stopPropagation(); onToggleExpand(file.path); }}
          title={expanded ? t('editor.contentBrowser.contextMenu.collapseSubAssets', { defaultValue: 'Collapse sub-assets' }) : t('editor.contentBrowser.contextMenu.expandSubAssets')}
        >
          <ContentBrowserIcon name="chevron-down" />
        </button>
      )}
      <div className={`cb-grid-thumb cb-fe-thumb cb-file-thumb is-${file.family}`}>
        <span className="cb-file-icon"><FileFamilyIcon family={file.family} /></span>
      </div>
      <div className="cb-grid-label cb-fe-name" title={file.name}>{file.name}</div>
      <div className={`cb-card-meta${hasAssets ? ' cb-card-asset-count' : ' cb-card-kind'}`} style={{ color: metaColor }}>
        {metaLabel}
      </div>
    </div>
  );
}

// memo with default shallow prop comparison: `file` is a referentially stable
// object (useCBDerivedView no longer rebuilds it every render) and every other
// prop is a primitive value or a stable callback, so an unrelated panel
// re-render leaves all props Object.is-equal and the card is skipped entirely.
export const CBFileItem = memo(CBFileItemImpl);
