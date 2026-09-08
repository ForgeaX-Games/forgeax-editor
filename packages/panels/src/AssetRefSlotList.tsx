import type { ReactElement } from 'react';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { ForgeaxIcon } from '@forgeax/editor-ui';
import { resolveAssetHandle } from './asset-ref-contract';
import { anchorFromElement, type AssetPickerAnchor } from './asset-picker-placement';
import { AssetRefControl, assetRefSlotLabel } from './AssetRefControl';

export interface AssetRefSlotListProps {
  assetType: string;
  testIdPrefix: string;
  items: readonly number[];
  readOnly?: boolean;
  /** When set, the list length is fixed to this count (mesh submesh lock). */
  lockedCount?: number | null;
  mismatch?: boolean;
  onBrowseSlot: (index: number, currentGuid: string | undefined, anchor: AssetPickerAnchor) => void;
  onBindSlot: (index: number, guid: string) => void;
  onClearSlot: (index: number) => void;
  onFixMismatch?: () => void;
  onPickNew?: (anchor: AssetPickerAnchor) => void;
  onAppendSlot?: () => void;
  onRemoveSlot?: (index: number) => void;
}

function renderSlotControl(
  props: AssetRefSlotListProps,
  index: number,
  handle: number,
  showSlotLabel: boolean,
  t: (key: string, vars?: Record<string, string | number>) => string,
  onBrowse: (anchor: AssetPickerAnchor) => void,
): ReactElement {
  const {
    assetType,
    testIdPrefix,
    readOnly = false,
    lockedCount = null,
    onBindSlot,
    onClearSlot,
    onRemoveSlot,
  } = props;
  const locked = lockedCount !== null && lockedCount !== undefined;
  const virtual = !locked && index >= props.items.length;
  const control = (
    <AssetRefControl
      assetType={assetType}
      handle={handle}
      testId={`${testIdPrefix}-slot-${index}`}
      readOnly={readOnly}
      onBrowse={onBrowse}
      onBind={(guid) => onBindSlot(index, guid)}
      onClear={() => onClearSlot(index)}
    />
  );
  if (!showSlotLabel) return control;
  return (
    <div className="asset-ref-slot-entry" data-testid={`${testIdPrefix}-slot-${index}`}>
      {control}
      <span className="asset-ref-slot-caption">{assetRefSlotLabel(t, index)}</span>
      {!locked && !virtual && onRemoveSlot && (
        <button
          type="button"
          className="asset-ref-slot-remove"
          title={t('editor.inspector.assetRef.removeSlot')}
          onClick={() => onRemoveSlot(index)}
        >
          <ForgeaxIcon name="x" size={12} />
        </button>
      )}
    </div>
  );
}

export function AssetRefSlotList(props: AssetRefSlotListProps): ReactElement {
  const {
    items,
    lockedCount = null,
    mismatch = false,
    onFixMismatch,
    onPickNew,
    onAppendSlot,
    onBrowseSlot,
    testIdPrefix,
  } = props;
  const { t } = useTranslation();
  const locked = lockedCount !== null && lockedCount !== undefined;
  const slotCount = locked ? lockedCount! : items.length;
  const rowCount = locked ? slotCount : Math.max(items.length, 1);
  const showSlotLabels = rowCount > 1;

  const makeBrowseHandler = (index: number, currentGuid: string | undefined) => (anchor: AssetPickerAnchor) => {
    onBrowseSlot(index, currentGuid, anchor);
  };

  if (rowCount === 1) {
    const handle = typeof items[0] === 'number' ? items[0] : 0;
    const currentGuid = resolveAssetHandle(handle).guid;
    return renderSlotControl(props, 0, handle, false, t, makeBrowseHandler(0, currentGuid));
  }

  return (
    <div className="asset-ref-slots">
      {mismatch && onFixMismatch && (
        <button
          type="button"
          className="asset-fix"
          data-testid={`${testIdPrefix}-fix`}
          onClick={onFixMismatch}
          title={t('editor.inspector.assetRef.mismatchHint', { current: items.length, expected: slotCount })}
        >
          <ForgeaxIcon name="flag" size={11} />{' '}
          {t('editor.inspector.assetRef.mismatchAction', { current: items.length, expected: slotCount })}
        </button>
      )}
      {Array.from({ length: rowCount }, (_unused, index) => {
        const handle = typeof items[index] === 'number' ? items[index]! : 0;
        const currentGuid = resolveAssetHandle(handle).guid;
        return (
          <div className="asset-ref-slot-row" key={index}>
            {renderSlotControl(props, index, handle, showSlotLabels, t, makeBrowseHandler(index, currentGuid))}
          </div>
        );
      })}
      {locked && slotCount > 1 ? (
        <div className="asset-slotnote">
          {t('editor.inspector.assetRef.lockedSlotHint', { count: slotCount })}
        </div>
      ) : (
        <div className="asset-actions">
          {onPickNew && (
            <button
              type="button"
              className="fbtn"
              data-testid={`${testIdPrefix}-pick`}
              onClick={(event) => {
                const rect = anchorFromElement((event.currentTarget as HTMLElement).closest('.f-val'));
                if (rect) onPickNew(rect);
              }}
            >
              <ForgeaxIcon name="folder" size={11} /> {t('editor.inspector.assetRef.pick')}
            </button>
          )}
          {onAppendSlot && (
            <button type="button" className="fbtn" onClick={onAppendSlot}>
              <ForgeaxIcon name="plus" size={11} /> {t('editor.inspector.assetRef.addSlot')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
