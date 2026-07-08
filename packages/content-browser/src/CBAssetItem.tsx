import { useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { editorBus } from '@forgeax/editor-core';
import type { CBAsset } from './types';
import { getThumbnailData } from './hooks/useThumbnail';

interface Props {
  asset: CBAsset;
  selected: boolean;
  thumbnailSize?: number;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

const TIP_W = 260;
const TIP_GAP = 8;

export function CBAssetItem({ asset, selected, thumbnailSize = 80, onClick, onDoubleClick, onContextMenu }: Props) {
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
    e.dataTransfer.effectAllowed = 'copy';
    editorBus.emit('dragAssetStart', ref);
  }, [asset]);

  const handleDragEnd = useCallback(() => {
    editorBus.emit('dragAssetEnd');
  }, []);

  return (
    <div
      className={`cb-grid-item${selected ? ' sel' : ''}`}
      style={{ width: thumbnailSize + 8, height: thumbnailSize + 28 }}
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
      <div
        className="cb-grid-thumb"
        style={{
          width: thumbnailSize,
          height: thumbnailSize,
          background: thumb.type === 'gradient' ? thumb.gradient : (thumb.color ?? undefined),
        }}
      >
        {thumb.type === 'gradient' ? (
          <div className="cb-thumb-sphere" style={{ background: thumb.gradient }} />
        ) : thumb.type === 'image' && thumb.imageUrl ? (
          <img
            src={thumb.imageUrl}
            alt={asset.name}
            className="cb-thumb-img"
            style={{ width: thumbnailSize, height: thumbnailSize, objectFit: 'contain' }}
            loading="lazy"
          />
        ) : (
          <span className="cb-grid-icon">{thumb.icon}</span>
        )}
        {thumb.badge && <span className="cb-thumb-badge">{thumb.badge}</span>}
        {Boolean(asset.payload?.cookError) && <span className="cb-thumb-warn" title={String(asset.payload?.cookError)}>⚠</span>}
      </div>
      <div className="cb-grid-label" title={asset.name}>{asset.name}</div>

      {hovered && tipXY && createPortal(
        <div className="cb-rich-tooltip" style={{ position: 'fixed', left: tipXY.left, top: tipXY.top }}>
          <div className="cb-tooltip-header">
            <span className="cb-tooltip-icon">{thumb.icon ?? '📦'}</span>
            <span className="cb-tooltip-name">{asset.name}</span>
          </div>
          <div className="cb-tooltip-row">Kind: {asset.kind}</div>
          <div className="cb-tooltip-row">GUID: {asset.guid.slice(0, 18)}…</div>
          <div className="cb-tooltip-row">Pack: {asset.packPath.replace(/^.*\//, '')}</div>
          {asset.estimatedSize != null && (
            <div className="cb-tooltip-row">Size: {(asset.estimatedSize / 1024).toFixed(1)} KB</div>
          )}
          {thumb.badge && <div className="cb-tooltip-row">{thumb.badge}</div>}
        </div>,
        document.body,
      )}
    </div>
  );
}
