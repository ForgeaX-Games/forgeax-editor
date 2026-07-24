import { useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { panelBridge } from '@forgeax/editor-core';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { colorForAssetKind, ContentBrowserIcon, iconNameForAssetKind } from './content-browser-icons';
import type { CBAsset } from './types';
import { getThumbnailData } from './hooks/useThumbnail';

interface Props {
  asset: CBAsset;
  selected: boolean;
  thumbnailSize?: number;
  favorite?: boolean;
  onToggleFavorite?: () => void;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

const TIP_W = 260;
const TIP_GAP = 8;

export function CBAssetItem({ asset, selected, favorite = false, onToggleFavorite, onClick, onDoubleClick, onContextMenu }: Props) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [tipXY, setTipXY] = useState<{ left: number; top: number } | null>(null);
  const thumb = getThumbnailData(asset);

  const handleCtxMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    onContextMenu(e);
  }, [onContextMenu]);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    const ref = {
      type: 'asset' as const,
      guid: asset.guid,
      kind: asset.kind,
      name: asset.name,
      path: asset.packPath,
      payload: asset.payload,
    };
    e.dataTransfer.setData('text/plain', `@${asset.name} (${asset.kind})`);
    e.dataTransfer.setData('application/x-forgeax-asset', JSON.stringify({
      guid: asset.guid, kind: asset.kind, name: asset.name, packPath: asset.packPath,
    }));
    e.dataTransfer.effectAllowed = 'copy';
    panelBridge.emit('dragAssetStart', ref);
  }, [asset]);

  const handleDragEnd = useCallback(() => {
    panelBridge.emit('dragAssetEnd');
  }, []);

  return (
    <div
      className={`cb-grid-item cb-fe-card${selected ? ' sel' : ''}`}
      data-testid="cb-asset-item"
      data-asset-name={asset.name}
      data-asset-kind={asset.kind}
      data-asset-guid={asset.guid}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={handleCtxMenu}
      onMouseEnter={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let left = rect.right + TIP_GAP;
        if (left + TIP_W > vw) left = rect.left - TIP_W - TIP_GAP;
        if (left < 0) left = TIP_GAP;
        let top = rect.top;
        if (top + 140 > vh) top = vh - 140 - TIP_GAP;
        if (top < 0) top = TIP_GAP;
        setTipXY({ left, top });
        setHovered(true);
      }}
      onMouseLeave={() => setHovered(false)}
    >
      <span
        className={`cb-card-fav${favorite ? ' on' : ''}`}
        title={t(favorite ? 'editor.contentBrowser.contextMenu.unfavorite' : 'editor.contentBrowser.contextMenu.favorite')}
        onClick={e => { e.stopPropagation(); onToggleFavorite?.(); }}
      ><ContentBrowserIcon name="star" /></span>
      <div
        className="cb-grid-thumb cb-fe-thumb"
        style={{
          background: thumb.type === 'gradient' ? thumb.gradient : undefined,
        }}
      >
        {thumb.type === 'gradient' ? (
          <div className="cb-thumb-sphere" style={{ background: thumb.gradient }} />
        ) : thumb.type === 'image' && thumb.imageUrl ? (
          <img
            src={thumb.imageUrl}
            alt={asset.name}
            className="cb-thumb-img"
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            loading="lazy"
          />
        ) : (
          <span className="cb-grid-icon">
            <ContentBrowserIcon name={iconNameForAssetKind(asset.kind)} />
          </span>
        )}
        {thumb.badge && <span className="cb-thumb-badge">{thumb.badge}</span>}
        {Boolean(asset.payload?.cookError) && <span className="cb-thumb-warn" title={String(asset.payload?.cookError)}>⚠</span>}
      </div>
      <div className="cb-grid-label cb-fe-name" title={asset.name}>{asset.name}</div>
      <div className="cb-card-meta cb-card-kind" style={{ color: colorForAssetKind(asset.kind) }}>{asset.kind}</div>

      {hovered && tipXY && createPortal(
        <div className="cb-rich-tooltip" style={{ position: 'fixed', left: tipXY.left, top: tipXY.top }}>
          <div className="cb-tooltip-header">
            <span className="cb-tooltip-icon">
              <ContentBrowserIcon name={iconNameForAssetKind(asset.kind)} />
            </span>
            <span className="cb-tooltip-name">{asset.name}</span>
          </div>
          <div className="cb-tooltip-row">{t('editor.contentBrowser.tooltip.kind', { kind: asset.kind })}</div>
          <div className="cb-tooltip-row">{t('editor.contentBrowser.tooltip.guid', { guid: `${asset.guid.slice(0, 18)}...` })}</div>
          <div className="cb-tooltip-row">{t('editor.contentBrowser.tooltip.pack', { pack: asset.packPath.replace(/^.*\//, '') })}</div>
          {asset.estimatedSize != null && (
            <div className="cb-tooltip-row">{t('editor.contentBrowser.tooltip.size', { size: (asset.estimatedSize / 1024).toFixed(1) })}</div>
          )}
          {thumb.badge && <div className="cb-tooltip-row">{thumb.badge}</div>}
        </div>,
        document.body,
      )}
    </div>
  );
}
