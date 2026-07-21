import type { MouseEvent } from 'react';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { ContentBrowserIcon } from './content-browser-icons';
import type { CBFolder } from './types';

interface Props {
  folder: CBFolder;
  selected: boolean;
  thumbnailSize?: number;
  onClick: (e: MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: MouseEvent) => void;
}

export function CBFolderItem({ folder, selected, onClick, onDoubleClick, onContextMenu }: Props) {
  const { t } = useTranslation();
  return (
    <div
      className={`cb-grid-item cb-fe-card cb-grid-folder${selected ? ' sel' : ''}`}
      data-testid="cb-folder-item"
      data-folder-path={folder.path}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={e => { e.preventDefault(); onContextMenu(e); }}
      title={`${folder.name} (${folder.childCount})`}
    >
      <span className={`cb-card-fav${folder.isFavorite ? ' on' : ''}`}><ContentBrowserIcon name="star" /></span>
      <div className="cb-grid-thumb cb-fe-thumb cb-folder-thumb">
        <span className="cb-grid-icon cb-folder-icon"><ContentBrowserIcon name="folder" /></span>
      </div>
      <div className="cb-grid-label cb-fe-name" title={folder.name}>{folder.name}</div>
      <div className="cb-card-meta">{t('editor.contentBrowser.preview.items', { count: folder.childCount })}</div>
    </div>
  );
}
