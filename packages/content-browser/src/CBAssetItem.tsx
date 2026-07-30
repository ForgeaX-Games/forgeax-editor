import { memo, useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { panelBridge } from '@forgeax/editor-core';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { colorForAssetKind, ContentBrowserIcon, iconNameForAssetKind } from './content-browser-icons';
import type { CBAsset } from './types';
import { getThumbnailData } from './hooks/useThumbnail';

interface Props {
  asset: CBAsset;
  index: number;
  selected: boolean;
  thumbnailSize?: number;
  favorite?: boolean;
  onSelect: (item: CBAsset) => void;
  onActivate: (item: CBAsset) => void;
  onContextMenu: (e: React.MouseEvent, item: CBAsset) => void;
  onToggleFavorite: (item: CBAsset) => void;
  onClickIndex: (index: number, e: React.MouseEvent) => void;
}

const TIP_W = 260;
const TIP_GAP = 8;

// GUIDs already handed to the host for a visible-card prefetch this session.
// Standalone-pack materials are NOT catalogued after a hard refresh (the
// scene-load loadByGuid recursion only visits scene-referenced GUIDs), so their
// card renders a grey placeholder and an edit silently no-ops until the material
// is clicked. Requesting a prefetch the moment the card scrolls into view warms
// exactly the visible ones — no eager full-catalog load. Module-scoped so a
// catalog-refresh re-render (broadcastAssetsChanged) never re-emits for the same
// GUID. Only material is prefetched: textures load via <img>, and eagerly
// loadByGuid-ing meshes on scroll would pull heavy geometry the card never shows.
const prefetchRequested = new Set<string>();

function CBAssetItemImpl({
  asset,
  index,
  selected,
  favorite = false,
  onSelect,
  onActivate,
  onContextMenu,
  onToggleFavorite,
  onClickIndex,
}: Props) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [tipXY, setTipXY] = useState<{ left: number; top: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const thumb = getThumbnailData(asset);

  // Prefetch the material into the registry catalog once its card is on screen,
  // so the thumbnail resolves to the real colour and a following edit finds
  // _oldEntry — matching the click-to-load behaviour, but click-free. The host
  // (edit-runtime) owns loadByGuid; we only signal intent over panelBridge.
  useEffect(() => {
    if (asset.kind !== 'material') return;
    const key = asset.guid.toLowerCase();
    if (prefetchRequested.has(key)) return;
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      if (prefetchRequested.has(key)) return;
      prefetchRequested.add(key);
      panelBridge.emit('requestAssetPrefetch', { guid: asset.guid, kind: asset.kind });
    }, { rootMargin: '100px', threshold: 0.01 });
    io.observe(el);
    return () => io.disconnect();
  }, [asset.guid, asset.kind]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    onSelect(asset);
    onClickIndex(index, e);
  }, [onSelect, onClickIndex, asset, index]);

  const handleCtxMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    onContextMenu(e, asset);
  }, [onContextMenu, asset]);

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
      ref={rootRef}
      className={`cb-grid-item cb-fe-card${selected ? ' sel' : ''}`}
      data-testid="cb-asset-item"
      data-asset-name={asset.name}
      data-asset-kind={asset.kind}
      data-asset-guid={asset.guid}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClick={handleClick}
      onDoubleClick={() => onActivate(asset)}
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
        onClick={e => { e.stopPropagation(); onToggleFavorite(asset); }}
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

export const CBAssetItem = memo(CBAssetItemImpl);
