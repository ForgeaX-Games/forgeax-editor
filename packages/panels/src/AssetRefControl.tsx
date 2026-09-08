import { useCallback, useMemo, type MouseEvent, type ReactElement } from 'react';
import { getAssetSelection, useAssetSelection } from '@forgeax/editor-core';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { useHost } from '@forgeax/interface/core/app-shell';
import {
  AssetThumbnail,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ForgeaxIcon,
} from '@forgeax/editor-ui';
import { isGuidCompatibleWithAssetType, resolveAssetGuid, resolveAssetHandle } from './asset-ref-contract';
import { revealInContentBrowser } from './reveal-in-content-browser';
import { anchorFromElement, type AssetPickerAnchor } from './asset-picker-placement';
import { useAssetRefDrop } from './use-asset-ref-drop';

export interface AssetRefControlProps {
  assetType: string;
  /** Runtime shared-asset handle; 0 = unbound. Omit when `guid` is the binding source. */
  handle?: number;
  /** Catalog GUID binding (material staging, texture slots). Omit when `handle` is used. */
  guid?: string | null;
  testId: string;
  readOnly?: boolean;
  onBrowse: (anchor: AssetPickerAnchor) => void;
  onBind: (guid: string) => void;
  onClear: () => void;
}

export function AssetRefControl({
  assetType,
  handle = 0,
  guid,
  testId,
  readOnly = false,
  onBrowse,
  onBind,
  onClear,
}: AssetRefControlProps): ReactElement {
  const { t } = useTranslation();
  const host = useHost();
  const binding = useMemo(
    () => (guid !== undefined ? resolveAssetGuid(guid) : resolveAssetHandle(handle)),
    [guid, handle],
  );
  const displayName = binding.missing
    ? t('editor.inspector.assetRef.missing')
    : binding.bound
      ? binding.name
      : t('editor.inspector.assetRef.none');

  const {
    dropClassName,
    onDragEnter,
    onDragLeave,
    onDragOver,
    onDrop,
  } = useAssetRefDrop({ assetType, readOnly, onBind });

  const useSelection = useCallback(() => {
    if (readOnly) return;
    const selected = getAssetSelection();
    if (!selected?.guid) return;
    if (!isGuidCompatibleWithAssetType(selected.guid, assetType)) return;
    onBind(selected.guid);
  }, [assetType, onBind, readOnly]);

  const revealBound = useCallback(() => {
    if (!binding.guid) return;
    void revealInContentBrowser(host, {
      guid: binding.guid,
      ...(binding.packPath ? { packPath: binding.packPath } : {}),
      ...(binding.sourcePath ? { sourcePath: binding.sourcePath } : {}),
      ...(binding.kind ? { assetKind: binding.kind } : {}),
      ...(binding.name ? { name: binding.name } : {}),
    });
  }, [binding.guid, binding.kind, binding.name, binding.packPath, binding.sourcePath, host]);

  const openBrowse = useCallback((event: MouseEvent<HTMLElement>) => {
    if (readOnly) return;
    const element = event.currentTarget.closest('.asset-ref') ?? event.currentTarget;
    const rect = anchorFromElement(element);
    if (rect) onBrowse(rect);
  }, [onBrowse, readOnly]);

  const copyGuid = useCallback(() => {
    if (!binding.guid) return;
    void navigator.clipboard?.writeText(binding.guid).catch(() => {});
  }, [binding.guid]);

  const selected = useAssetSelection();
  const canUseSelection = selected?.guid !== undefined
    && isGuidCompatibleWithAssetType(selected.guid, assetType);

  return (
    <div
      className={`asset-ref${dropClassName ? ` ${dropClassName}` : ''}`}
      data-testid={testId}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="asset-ref-thumb" aria-hidden>
        {binding.bound && !binding.missing && binding.kind ? (
          <AssetThumbnail
            kind={binding.kind}
            payload={binding.meta}
            packPath={binding.packPath ?? ''}
            size={28}
          />
        ) : (
          <span className="asset-ref-thumb-empty" />
        )}
      </div>
      <div className="asset-ref-body">
        <button
          type="button"
          className="asset-ref-combo"
          data-testid={`${testId}-combo`}
          disabled={readOnly}
          title={binding.guid ?? assetType}
          onClick={openBrowse}
        >
          <span className={`asset-ref-combo-label${binding.bound && !binding.missing ? '' : ' empty'}`}>
            {displayName}
          </span>
          <ForgeaxIcon name="chevronDown" size={12} />
        </button>
        <div className="asset-ref-actions">
          <button
            type="button"
            className="asset-ref-act"
            data-testid={`${testId}-use-selection`}
            disabled={readOnly || !canUseSelection}
            title={t('editor.inspector.assetRef.useSelection')}
            onClick={useSelection}
          >
            <ForgeaxIcon name="target" size={13} />
          </button>
          <button
            type="button"
            className="asset-ref-act"
            data-testid={`${testId}-browse`}
            disabled={readOnly}
            title={t('editor.inspector.assetRef.browse')}
            onClick={openBrowse}
          >
            <ForgeaxIcon name="folder" size={13} />
          </button>
          <button
            type="button"
            className="asset-ref-act"
            data-testid={`${testId}-reveal`}
            disabled={!binding.guid}
            title={t('editor.inspector.assetRef.revealInBrowser')}
            onClick={revealBound}
          >
            <ForgeaxIcon name="focus" size={13} />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="asset-ref-act"
                data-testid={`${testId}-menu`}
                title={t('editor.inspector.assetRef.more')}
              >
                <ForgeaxIcon name="chevronDown" size={12} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="fx-insp-menu" align="end">
              <DropdownMenuItem
                data-testid={`${testId}-clear`}
                disabled={readOnly || !binding.bound}
                onSelect={() => onClear()}
              >
                {t('editor.inspector.assetRef.clear')}
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid={`${testId}-copy-guid`}
                disabled={!binding.guid}
                onSelect={copyGuid}
              >
                {t('editor.inspector.assetRef.copyGuid')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!binding.guid}
                onSelect={revealBound}
              >
                {t('editor.inspector.assetRef.revealInBrowser')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

/** Slot index label for array asset fields — i18n SSOT, never hardcoded locale text. */
export function assetRefSlotLabel(t: (key: string, vars?: Record<string, string | number>) => string, index: number): string {
  return t('editor.inspector.assetRef.slot', { index });
}
