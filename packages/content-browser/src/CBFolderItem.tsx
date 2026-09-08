import { memo, useCallback, useMemo, type CSSProperties, type MouseEvent } from 'react';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { ContentBrowserIcon, FILE_FAMILY_COLORS } from './content-browser-icons';
import { CBInlineRename } from './CBInlineRename';
import {
  dropRejectFallback,
  useDragSource,
  useFolderDropZone,
  type CBDragPayload,
  type CBDropTarget,
} from './dnd';
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
  /** Build the internal move payload for a drag starting on this folder. */
  getDragPayload?: (item: CBFolder) => CBDragPayload | null;
  /** Execute a move dropped onto this folder (validated + dispatched upstream). */
  onMoveDrop?: (payload: CBDragPayload, target: CBDropTarget) => void;
  renaming?: boolean;
  renameValidate?: (value: string) => string | null;
  onRenameCommit?: (item: CBFolder, value: string) => void;
  onRenameCancel?: () => void;
}

const NOOP_MOVE = (_p: CBDragPayload, _t: CBDropTarget) => {};

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
  getDragPayload,
  onMoveDrop,
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

  // The folder card is BOTH a move source (drag it into another folder) and a
  // move target (drop files/folders into it). The drop-zone verdict drives the
  // accept/reject styling + the "why not" title (point 3).
  const buildPayload = useCallback(() => getDragPayload?.(folder) ?? null, [getDragPayload, folder]);
  const dragSource = useDragSource(buildPayload);
  const dropTarget = useMemo<CBDropTarget>(() => ({ kind: 'folder-tile', path: folder.path }), [folder.path]);
  const { isOver, verdict, dropProps } = useFolderDropZone(dropTarget, onMoveDrop ?? NOOP_MOVE);
  const dropClass = isOver && verdict
    ? verdict.ok ? ' cb-drop-ok' : ' cb-drop-reject'
    : '';
  const rejectTitle = isOver && verdict && !verdict.ok ? dropRejectFallback(verdict.reason) : undefined;

  return (
    <div
      className={`cb-grid-item cb-fe-card cb-grid-folder${selected ? ' sel' : ''}${dropClass}`}
      style={{ '--cb-type-color': FILE_FAMILY_COLORS.dir } as CSSProperties}
      data-testid="cb-folder-item"
      data-folder-path={folder.path}
      tabIndex={tabIndex}
      onFocus={() => onFocusItem(folder)}
      {...dragSource}
      {...dropProps}
      onClick={handleClick}
      onDoubleClick={() => onActivate(folder)}
      onContextMenu={e => { e.preventDefault(); onContextMenu(e, folder); }}
      title={rejectTitle ?? `${folder.name} (${folder.childCount})`}
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
