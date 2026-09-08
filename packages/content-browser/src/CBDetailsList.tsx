import { useCallback, useMemo, useRef, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { useKeybindingScope } from '@forgeax/interface/core/app-shell';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { colorForAssetKind, colorForFileFamily, ContentBrowserIcon, iconNameForAssetKind, iconNameForFileFamily, labelForAssetKind } from './content-browser-icons';
import { CBInlineRename } from './CBInlineRename';
import {
  dropRejectFallback,
  useDragSource,
  useFolderDropZone,
  type CBDragPayload,
  type CBDropTarget,
} from './dnd';
import type { MultiSelectAPI } from './hooks';
import type { SortAPI } from './hooks/useSort';
import type { CBSortKey, CBViewItem } from './types';

// ── Details view (UE "Details") — a sortable table twin of the tile grid with
// name/type/size/modified columns. Reuses the SAME interaction contract
// (selection / activate / context / rename / DnD) as CBGrid so behaviour stays
// identical. (UE "List" is the mini-tile row form and is rendered by CBGrid.)

/** Column spec: which sort key it maps to, its i18n label, cell class, and its
 *  grid track width. `name` always fills the remaining space. */
interface ColumnSpec {
  key: CBSortKey;
  labelKey: string;
  cellClass: string;
  track: string;
}

const COLUMNS: readonly ColumnSpec[] = [
  { key: 'name', labelKey: 'editor.contentBrowser.details.colName', cellClass: 'cb-details-name', track: 'minmax(160px, 1fr)' },
  { key: 'kind', labelKey: 'editor.contentBrowser.details.colType', cellClass: 'cb-details-type', track: '160px' },
  { key: 'estimatedSize', labelKey: 'editor.contentBrowser.details.colSize', cellClass: 'cb-details-size', track: '90px' },
  { key: 'packModifiedAt', labelKey: 'editor.contentBrowser.details.colModified', cellClass: 'cb-details-modified', track: '130px' },
];
const GRID_TEMPLATE = COLUMNS.map((c) => c.track).join(' ');

interface Props {
  items: CBViewItem[];
  multiSelect: MultiSelectAPI;
  sort: SortAPI;
  onSelect?: (item: CBViewItem) => void;
  onDoubleClick?: (item: CBViewItem) => void;
  onContextMenu?: (e: MouseEvent, item: CBViewItem) => void;
  onFocusItem?: (item: CBViewItem) => void;
  renamingKey?: string | null;
  renameValidate?: (value: string) => string | null;
  onRenameCommit?: (item: CBViewItem, value: string) => void;
  onRenameCancel?: () => void;
  getDragPayload?: (item: CBViewItem) => CBDragPayload | null;
  onMoveDrop?: (payload: CBDragPayload, target: CBDropTarget) => void;
}

const NOOP_ITEM = (_item: CBViewItem) => {};
const NOOP_CTX = (_e: MouseEvent, _item: CBViewItem) => {};
const NOOP_RENAME = (_item: CBViewItem, _value: string) => {};
const NOOP_VOID = () => {};
const NOOP_MOVE = (_p: CBDragPayload, _t: CBDropTarget) => {};

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ms: number | undefined): string {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

interface RowMeta {
  iconName: string;
  /** Type-derived tint for the leading icon — mirrors the tile grid so kinds
   *  read the same in both views (folders amber, per-kind/family colours). */
  iconColor: string;
  typeLabel: string;
  sizeLabel: string;
  modifiedLabel: string;
}

const FOLDER_ICON_COLOR = 'var(--accent-amber, #ffc966)';

function metaForItem(item: CBViewItem, t: ReturnType<typeof useTranslation>['t']): RowMeta {
  if (item.type === 'folder') {
    return {
      iconName: 'folder',
      iconColor: FOLDER_ICON_COLOR,
      typeLabel: t('editor.contentBrowser.details.typeFolder'),
      sizeLabel: t('editor.contentBrowser.details.itemCount', { count: item.childCount }),
      modifiedLabel: '',
    };
  }
  if (item.type === 'file') {
    return {
      iconName: iconNameForFileFamily(item.family),
      iconColor: colorForFileFamily(item.family),
      typeLabel: item.kindLabel || item.family,
      sizeLabel: '',
      modifiedLabel: '',
    };
  }
  return {
    iconName: iconNameForAssetKind(item.kind),
    iconColor: colorForAssetKind(item.kind),
    typeLabel: labelForAssetKind(item.kind, t),
    sizeLabel: formatBytes(item.estimatedSize),
    modifiedLabel: formatDate(item.packModifiedAt),
  };
}

function CBDetailsRow({
  item,
  index,
  selected,
  meta,
  onSelect,
  onActivate,
  onContextMenu,
  onClickIndex,
  onFocusItem,
  getDragPayload,
  onMoveDrop,
  renaming,
  renameValidate,
  onRenameCommit,
  onRenameCancel,
}: {
  item: CBViewItem;
  index: number;
  selected: boolean;
  meta: RowMeta;
  onSelect: (item: CBViewItem) => void;
  onActivate: (item: CBViewItem) => void;
  onContextMenu: (e: MouseEvent, item: CBViewItem) => void;
  onClickIndex: (index: number, e: MouseEvent) => void;
  onFocusItem: (item: CBViewItem) => void;
  getDragPayload?: (item: CBViewItem) => CBDragPayload | null;
  onMoveDrop?: (payload: CBDragPayload, target: CBDropTarget) => void;
  renaming: boolean;
  renameValidate?: (value: string) => string | null;
  onRenameCommit?: (item: CBViewItem, value: string) => void;
  onRenameCancel?: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const isFolder = item.type === 'folder';

  const handleClick = useCallback((e: MouseEvent) => {
    (e.currentTarget as HTMLDivElement).focus();
    onSelect(item);
    onClickIndex(index, e);
  }, [onSelect, onClickIndex, item, index]);

  const buildPayload = useCallback(() => getDragPayload?.(item) ?? null, [getDragPayload, item]);
  const dragSource = useDragSource(buildPayload);
  const dropTarget = useMemo<CBDropTarget>(
    () => ({ kind: 'folder-tile', path: isFolder ? item.path : '' }),
    [isFolder, item],
  );
  // Only folders host drops; non-folder rows still register the zone but its
  // policy verdict will reject (unsupported target path), so it's inert.
  const { isOver, verdict, dropProps } = useFolderDropZone(dropTarget, onMoveDrop ?? NOOP_MOVE);
  const dropClass = isFolder && isOver && verdict ? (verdict.ok ? ' cb-drop-ok' : ' cb-drop-reject') : '';
  const rejectTitle = isFolder && isOver && verdict && !verdict.ok ? dropRejectFallback(verdict.reason) : undefined;

  return (
    <div
      className={`cb-details-row${selected ? ' sel' : ''}${dropClass}`}
      role="row"
      data-testid="cb-details-row"
      tabIndex={selected ? 0 : -1}
      onFocus={() => onFocusItem(item)}
      {...dragSource}
      {...(isFolder ? dropProps : {})}
      onClick={handleClick}
      onDoubleClick={() => onActivate(item)}
      onContextMenu={e => { e.preventDefault(); onContextMenu(e, item); }}
      title={rejectTitle}
    >
      <div className="cb-details-cell cb-details-name" role="gridcell">
        <span className="cb-details-icon" style={{ color: meta.iconColor }}><ContentBrowserIcon name={meta.iconName} /></span>
        {renaming ? (
          <CBInlineRename
            initial={item.name}
            validate={renameValidate}
            onCommit={(value) => onRenameCommit?.(item, value)}
            onCancel={() => onRenameCancel?.()}
            ariaLabel={t('editor.contentBrowser.contextMenu.rename')}
          />
        ) : (
          <span className="cb-details-label" title={item.name}>{item.name}</span>
        )}
      </div>
      <div className="cb-details-cell cb-details-type" role="gridcell">{meta.typeLabel}</div>
      <div className="cb-details-cell cb-details-size" role="gridcell">{meta.sizeLabel}</div>
      <div className="cb-details-cell cb-details-modified" role="gridcell">{meta.modifiedLabel}</div>
    </div>
  );
}

export function CBDetailsList({
  items,
  multiSelect,
  sort,
  onSelect,
  onDoubleClick,
  onContextMenu,
  onFocusItem,
  renamingKey,
  renameValidate,
  onRenameCommit,
  onRenameCancel,
  getDragPayload,
  onMoveDrop,
}: Props) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  useKeybindingScope(rootRef, 'editor.contentBrowser.grid');
  const { isSelected, handleClick, clearSelection } = multiSelect;

  const selectCb = onSelect ?? NOOP_ITEM;
  const activateCb = onDoubleClick ?? NOOP_ITEM;
  const contextCb = onContextMenu ?? NOOP_CTX;
  const focusCb = onFocusItem ?? NOOP_ITEM;
  const renameCommitCb = onRenameCommit ?? NOOP_RENAME;
  const renameCancelCb = onRenameCancel ?? NOOP_VOID;

  const handleBlankClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) clearSelection();
  };

  // Header AND rows read the SAME track template off a CSS var, so the columns
  // stay pixel-aligned.
  const gridStyle = { '--cb-details-cols': GRID_TEMPLATE } as CSSProperties;

  return (
    <div
      ref={rootRef}
      className="cb-details-view cb-details-column"
      role="grid"
      data-testid="cb-details-view"
      style={gridStyle}
      onClick={handleBlankClick}
    >
      <div className="cb-details-header" role="row">
        {COLUMNS.map(({ key, labelKey, cellClass }) => {
          const active = sort.sortState.key === key;
          return (
            <button
              key={key}
              type="button"
              role="columnheader"
              className={`cb-details-cell cb-details-th ${cellClass}${active ? ' active' : ''}`}
              aria-sort={active ? (sort.sortState.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
              onClick={() => sort.setSortKey(key)}
            >
              <span>{t(labelKey)}</span>
              {active && <span className="cb-details-sort-arrow" aria-hidden="true">{sort.sortState.dir === 'asc' ? '\u25b2' : '\u25bc'}</span>}
            </button>
          );
        })}
      </div>
      <div className="cb-details-body">
        {items.map((item, index) => {
          const itemKey = item.type === 'asset' ? item.guid : item.path;
          return (
            <CBDetailsRow
              key={itemKey}
              item={item}
              index={index}
              selected={isSelected(item)}
              meta={metaForItem(item, t)}
              onSelect={selectCb}
              onActivate={activateCb}
              onContextMenu={contextCb}
              onClickIndex={handleClick}
              onFocusItem={focusCb}
              getDragPayload={getDragPayload}
              onMoveDrop={onMoveDrop}
              renaming={renamingKey != null && renamingKey === itemKey}
              renameValidate={renameValidate}
              onRenameCommit={renameCommitCb}
              onRenameCancel={renameCancelCb}
            />
          );
        })}
      </div>
    </div>
  );
}
