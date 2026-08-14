import { memo, useCallback, type CSSProperties, type MouseEvent } from 'react';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { ContentBrowserIcon, FILE_FAMILY_COLORS } from './content-browser-icons';
import { CBInlineRename } from './CBInlineRename';
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
  renaming?: boolean;
  renameValidate?: (value: string) => string | null;
  onRenameCommit?: (item: CBFolder, value: string) => void;
  onRenameCancel?: () => void;
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
  renaming = false,
  renameValidate,
  onRenameCommit,
  onRenameCancel,
}: Props) {
  const { t } = useTranslation();
  const fav = favorite ?? folder.isFavorite;

  const handleClick = useCallback((e: MouseEvent) => {
    // Focus the card so the grid's focused-item ref updates — this is what lets
    // F2 (and other focused-item commands) act on THIS folder, mirroring the
    // asset/file cards.
    (e.currentTarget as HTMLDivElement).focus();
    onSelect(folder);
    onClickIndex(index, e);
  }, [onSelect, onClickIndex, folder, index]);

  return (
    <div
      className={`cb-grid-item cb-fe-card cb-grid-folder${selected ? ' sel' : ''}`}
      style={{ '--cb-type-color': FILE_FAMILY_COLORS.dir } as CSSProperties}
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
      {/* Folders have no type, so the name is free to use the full fixed-height
        * label block (4 lines) instead of the 3 lines file/asset cards leave
        * for their type row. The block height is identical either way. */}
      {renaming ? (
        <CBInlineRename
          initial={folder.name}
          validate={renameValidate}
          onCommit={(value) => onRenameCommit?.(folder, value)}
          onCancel={() => onRenameCancel?.()}
          ariaLabel={t('editor.contentBrowser.contextMenu.rename')}
        />
      ) : (
        <div className="cb-fe-label">
          <div className="cb-grid-label cb-fe-name" title={folder.name}>{folder.name}</div>
        </div>
      )}
    </div>
  );
}

export const CBFolderItem = memo(CBFolderItemImpl);
