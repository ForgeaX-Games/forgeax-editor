import { useState, useRef, useCallback } from 'react';
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

export function CBAssetItem({ asset, selected, thumbnailSize = 80, onClick, onDoubleClick, onContextMenu }: Props) {
  const [hovered, setHovered] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);
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
    try {
      window.parent?.postMessage({ type: 'FORGEAX_DRAG_ASSET_START', ref }, '*');
    } catch { /* cross-origin */ }
  }, [asset]);

  const handleDragEnd = useCallback(() => {
    try {
      window.parent?.postMessage({ type: 'FORGEAX_DRAG_ASSET_END' }, '*');
    } catch { /* cross-origin */ }
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
      onMouseEnter={() => setHovered(true)}
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

      {hovered && (
        <div ref={tooltipRef} className="cb-rich-tooltip">
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
        </div>
      )}
    </div>
  );
}
