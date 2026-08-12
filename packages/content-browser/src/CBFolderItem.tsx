import { memo, useCallback, type MouseEvent } from 'react';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { ContentBrowserIcon } from './content-browser-icons';
import type { CBFolder } from './types';

interface Props {
  folder: CBFolder;
  index: number;
  selected: boolean;
  tabIndex: number;
  thumbnailSize?: number;
  favorite?: boolean;
  onSelect: (item: CBFolder) => void;
  onActivate: (item: CBFolder) => void;
  onContextMenu: (e: MouseEvent, item: CBFolder) => void;
  onToggleFavorite: (item: CBFolder) => void;
  onClickIndex: (index: number, e: MouseEvent) => void;
  onFocusItem: (item: CBFolder) => void;
}

function CBFolderItemImpl({
  folder,
  index,
  selected,
  tabIndex,
  favorite,
  onSelect,
  onActivate,
  onContextMenu,
  onToggleFavorite,
  onClickIndex,
  onFocusItem,
}: Props) {
  const { t } = useTranslation();
  const fav = favorite ?? folder.isFavorite;

  const handleClick = useCallback((e: MouseEvent) => {
    onSelect(folder);
    onClickIndex(index, e);
  }, [onSelect, onClickIndex, folder, index]);

  return (
    <div
      className={`cb-grid-item cb-fe-card cb-grid-folder${selected ? ' sel' : ''}`}
      data-testid="cb-folder-item"
      data-folder-path={folder.path}
      tabIndex={tabIndex}
      onFocus={() => onFocusItem(folder)}
      onClick={handleClick}
      onDoubleClick={() => onActivate(folder)}
      onContextMenu={e => { e.preventDefault(); onContextMenu(e, folder); }}
      title={`${folder.name} (${folder.childCount})`}
    >
      <span
        className={`cb-card-fav${fav ? ' on' : ''}`}
        title={t(fav ? 'editor.contentBrowser.contextMenu.unfavorite' : 'editor.contentBrowser.contextMenu.favorite')}
        onClick={e => { e.stopPropagation(); onToggleFavorite(folder); }}
      ><ContentBrowserIcon name="star" /></span>
      <div className="cb-grid-thumb cb-fe-thumb cb-folder-thumb">
        <span className="cb-grid-icon cb-folder-icon"><ContentBrowserIcon name="folder" /></span>
      </div>
      <div className="cb-grid-label cb-fe-name" title={folder.name}>{folder.name}</div>
      {/* Folders have no type; keep the type row's height so the name stays
        * vertically aligned with file/asset cards (no collapse). */}
      <div className="cb-card-meta cb-card-kind" aria-hidden="true">&nbsp;</div>
    </div>
  );
}

export const CBFolderItem = memo(CBFolderItemImpl);
