import { useCallback, type MouseEvent } from 'react';
import { panelBridge } from '@forgeax/editor-core';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { colorForFileFamily, ContentBrowserIcon, FileFamilyIcon } from './content-browser-icons';
import type { CBFile } from './types';

interface Props {
  file: CBFile;
  selected: boolean;
  expanded?: boolean;
  favorite?: boolean;
  onToggleFavorite?: () => void;
  onToggleExpand?: () => void;
  onClick: (e: MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: MouseEvent) => void;
}

export function CBFileItem({ file, selected, expanded, favorite, onToggleFavorite, onToggleExpand, onClick, onDoubleClick, onContextMenu }: Props) {
  const { t } = useTranslation();
  const fav = favorite ?? file.isFavorite;
  const hasAssets = file.assets.length > 0;
  const expandable = Boolean(onToggleExpand);
  const metaLabel = hasAssets ? t('editor.contentBrowser.preview.assetCount', { count: file.assets.length }) : file.kindLabel;
  const metaColor = hasAssets ? 'var(--accent-mint, #63eacf)' : colorForFileFamily(file.family);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', `@${file.name}`);
    e.dataTransfer.setData('application/x-forgeax-file', JSON.stringify({
      path: file.path, diskPath: file.diskPath, name: file.name, family: file.family,
    }));
    if (hasAssets) {
      const asset = file.assets[0]!;
      e.dataTransfer.setData('application/x-forgeax-asset', JSON.stringify({
        guid: asset.guid, kind: asset.kind, name: asset.name, packPath: asset.packPath,
      }));
      panelBridge.emit('dragAssetStart', {
        type: 'asset' as const,
        guid: asset.guid,
        kind: asset.kind,
        name: asset.name,
        path: asset.packPath,
        payload: asset.payload,
      });
    }
    e.dataTransfer.effectAllowed = 'copy';
  }, [file, hasAssets]);

  const handleDragEnd = useCallback(() => {
    if (hasAssets) panelBridge.emit('dragAssetEnd');
  }, [hasAssets]);

  return (
    <div
      className={`cb-grid-item cb-fe-card cb-file-card${selected ? ' sel' : ''}${expanded ? ' cb-pack-expanded' : ''}`}
      data-testid="cb-file-item"
      data-file-path={file.path}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={e => { e.preventDefault(); onContextMenu(e); }}
      title={file.path}
    >
      <span
        className={`cb-card-fav${fav ? ' on' : ''}`}
        title={t(fav ? 'editor.contentBrowser.contextMenu.unfavorite' : 'editor.contentBrowser.contextMenu.favorite')}
        onClick={e => { e.stopPropagation(); onToggleFavorite?.(); }}
      ><ContentBrowserIcon name="star" /></span>
      {expandable && (
        <button
          type="button"
          className={`cb-pack-expand-btn${expanded ? ' open' : ''}`}
          onClick={e => { e.stopPropagation(); onToggleExpand?.(); }}
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
