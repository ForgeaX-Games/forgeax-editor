import type { MouseEvent } from 'react';
import type { CBFolder } from './types';

interface Props {
  folder: CBFolder;
  selected: boolean;
  thumbnailSize?: number;
  onClick: (e: MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: MouseEvent) => void;
}

export function CBFolderItem({ folder, selected, thumbnailSize = 80, onClick, onDoubleClick, onContextMenu }: Props) {
  return (
    <div
      className={`cb-grid-item cb-grid-folder${selected ? ' sel' : ''}`}
      style={{ width: thumbnailSize + 8, height: thumbnailSize + 28 }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={e => { e.preventDefault(); onContextMenu(e); }}
      title={`${folder.name} (${folder.childCount})`}
    >
      <div className="cb-grid-thumb cb-folder-thumb" style={{ width: thumbnailSize, height: thumbnailSize }}>
        <span className="cb-grid-icon cb-folder-icon">📁</span>
        {folder.isFavorite && <span className="cb-thumb-badge">★</span>}
      </div>
      <div className="cb-grid-label" title={folder.name}>{folder.name}</div>
    </div>
  );
}
