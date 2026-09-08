import { memo, useCallback, type CSSProperties, type MouseEvent } from 'react';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { colorForFileFamily, ContentBrowserIcon, FileFamilyIcon } from './content-browser-icons';
import { CBInlineRename } from './CBInlineRename';
import { beginActiveDrag, endActiveDrag, writeDragPayload, type CBDragPayload } from './dnd';
import type { CBFile } from './types';

interface Props {
  file: CBFile;
  index: number;
  selected: boolean;
  tabIndex: number;
  expanded?: boolean;
  /** Number of catalog members this file owns. >=1 shows the count badge (the sole
   *  expand affordance, so a container file reveals its members inline instead of
   *  double-listing the file next to its one asset); >=2 also stacks the card into
   *  a "pile". Files with no content pass 0 → plain card, no expand. */
  groupCount?: number;
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
  onFocusItem: (item: CBFile) => void;
  /** Group path when this card is the leftmost tile of an inline-unpacked
   *  resource group. Emitted as `data-cb-group` so CBGrid can measure it into
   *  the connected per-row backdrop. */
  groupKey?: string;
  /** Build the internal move payload for a drag starting on this file (returns
   *  null to leave the drag copy-only). Threaded from ContentBrowser so the
   *  payload reflects the live multi-selection. */
  getDragPayload?: (item: CBFile) => CBDragPayload | null;
  renaming?: boolean;
  renameValidate?: (value: string) => string | null;
  onRenameCommit?: (item: CBFile, value: string) => void;
  onRenameCancel?: () => void;
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
  tabIndex,
  expanded,
  groupCount = 0,
  favorite,
  onSelect,
  onActivate,
  onContextMenu,
  onToggleFavorite,
  onToggleExpand,
  onClickIndex,
  onFocusItem,
  groupKey,
  getDragPayload,
  renaming = false,
  renameValidate,
  onRenameCommit,
  onRenameCancel,
}: Props) {
  const { t } = useTranslation();
  const fav = favorite ?? file.isFavorite;
  // A container file (owns >=1 catalog member) shows the expand badge so its
  // members reveal inline; it also stacks into a pile at >=2. Files with no
  // content (groupCount 0) get neither.
  const isPackage = groupCount >= 1;
  const isStacked = groupCount >= 2;

  const handleClick = useCallback((e: MouseEvent) => {
    // Focus the card so the grid's focused-item ref updates — this is what lets
    // F2 (and other focused-item commands) act on THIS file. Mirrors the asset
    // card; without it a file click leaves focus on the last-focused asset.
    (e.currentTarget as HTMLDivElement).focus();
    onSelect(file);
    onClickIndex(index, e);
  }, [onSelect, onClickIndex, file, index]);

  // Group card: the card body only SELECTS (decision 2). Expansion is a
  // deliberate, separate hit target — the count badge — so selecting a resource
  // group never forces it open. The badge selects first, then TOGGLES the inline
  // unpack (expand when collapsed, collapse when already open).
  const handleBadgeClick = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    onSelect(file);
    onClickIndex(index, e);
    onToggleExpand(file.path);
  }, [onSelect, onClickIndex, file, index, onToggleExpand]);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    // Keep the copy-oriented payload (viewport placement / inspector assign) AND
    // layer the internal move payload so a folder drop can relocate the file.
    writeFileDragData(file, e.dataTransfer);
    const payload = getDragPayload?.(file) ?? null;
    if (payload && payload.entries.length > 0) {
      writeDragPayload(e.dataTransfer, payload);
      beginActiveDrag(payload);
      e.dataTransfer.effectAllowed = 'copyMove';
    }
  }, [file, getDragPayload]);
  const handleDragEnd = useCallback(() => { endActiveDrag(); }, []);

  return (
    <div
      className={`cb-grid-item cb-fe-card cb-file-card${selected ? ' sel' : ''}${expanded ? ' cb-pack-expanded' : ''}${isStacked ? ' cb-group-card' : ''}${groupKey ? ' cb-group-member' : ''}`}
      style={{ '--cb-type-color': colorForFileFamily(file.family) } as CSSProperties}
      data-cb-group={groupKey}
      data-testid="cb-file-item"
      data-file-path={file.path}
      tabIndex={tabIndex}
      onFocus={() => onFocusItem(file)}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
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
      <div className={`cb-grid-thumb cb-fe-thumb cb-file-thumb is-${file.family}`}>
        <span className="cb-file-icon"><FileFamilyIcon family={file.family} /></span>
        {/* Count badge is the ONLY expand affordance; every container file (any
            file that owns catalog content, single-member packs included) gets it
            so its members reveal inline. Content-less files never expand. */}
        {isPackage && (
          <button
            type="button"
            className={`cb-group-badge${expanded ? ' open' : ''}`}
            title={t('editor.contentBrowser.contextMenu.expandSubAssets')}
            onClick={handleBadgeClick}
          >
            <span className="cb-group-badge-num">{groupCount}</span>
            <ContentBrowserIcon name="chevron-down" />
          </button>
        )}
      </div>
      {renaming ? (
        <CBInlineRename
          initial={file.name}
          validate={renameValidate}
          onCommit={(value) => onRenameCommit?.(file, value)}
          onCancel={() => onRenameCancel?.()}
          ariaLabel={t('editor.contentBrowser.contextMenu.rename')}
        />
      ) : (
        <div className="cb-fe-label has-kind">
          <div className="cb-grid-label cb-fe-name" title={file.name}>{file.name}</div>
          <div className="cb-card-meta cb-card-kind">{file.kindLabel}</div>
        </div>
      )}
    </div>
  );
}

// memo with default shallow prop comparison: `file` is a referentially stable
// object (useCBDerivedView no longer rebuilds it every render) and every other
// prop is a primitive value or a stable callback, so an unrelated panel
// re-render leaves all props Object.is-equal and the card is skipped entirely.
export const CBFileItem = memo(CBFileItemImpl);
