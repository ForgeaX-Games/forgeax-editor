// CBPreviewPanel — the right-hand panel below the action toolbar that previews
// the currently-selected Content Browser item (folder / file / asset).
//
// Owns the small async fetch for on-disk file metadata (/api/files?path=…)
// used to show text-file content inline. Everything else is derived from
// props: keep this component free of Content-Browser–level state so it can
// re-render only when the previewed item changes.

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { ResizeHandle } from '@forgeax/editor-core';
import { AssetThumbnail } from '@forgeax/editor-ui';
import { FilePreview } from '@forgeax/editor-file-preview';
import { colorForAssetKind, ContentBrowserIcon, FileFamilyIcon, iconNameForAssetKind } from './content-browser-icons';
import { CBUiAssetPreview } from './CBUiAssetPreview';
import { dirOfPath, type PreviewFileInfo } from './content-browser-format';
import { realPayload } from './hooks';
import { fileSupportsDualPreview, type CBFilePreviewMode } from './preview-file-source';
import type { CBAsset, CBFile, CBFolder, CBViewItem } from './types';

export interface CBPreviewPanelProps {
  /** The item to preview, or `null` for the empty placeholder. When the detail
   *  pane is toggled on it stays mounted even with no selection, so the grid
   *  column width never changes (no reflow/jitter as selection comes and goes). */
  previewItem: CBViewItem | null;
  foldersInPath: CBFolder[];
  diskFiles: CBFile[];
  gameSlug: string;
  onClose: () => void;
  onDrag: (dx: number) => void;
  onDragEnd: () => void;
}

function previewItemKey(item: CBViewItem | null): string | null {
  if (!item) return null;
  return item.type === 'asset' ? item.guid : item.path;
}

function assetRowName(assets: readonly CBAsset[], asset: CBAsset): string {
  const nameCounts = new Map<string, number>();
  for (const entry of assets) nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  return (nameCounts.get(asset.name) ?? 0) > 1 ? `${asset.name} · ${asset.kind}` : asset.name;
}

function FileAssetList({ file }: { file: CBFile }): ReactNode {
  return (
    <div className="cb-preview-asset-list">
      {file.assets.map(asset => (
        <div className="cb-preview-asset-row" key={asset.guid}>
          <AssetThumbnail kind={asset.kind} payload={realPayload(asset.guid, asset.payload)} packPath={asset.packPath} size={30} />
          <div>
            <div>{assetRowName(file.assets, asset)}</div>
            <div className="kind" style={{ color: colorForAssetKind(asset.kind) }}>{asset.kind}</div>
          </div>
          <span className="guid">{asset.guid.slice(0, 10)}...</span>
        </div>
      ))}
    </div>
  );
}

function FileSourcePreview({ file, previewInfo }: { file: CBFile; previewInfo: PreviewFileInfo | null }): ReactNode {
  const rawUrl = `/api/files/raw?path=${encodeURIComponent(file.diskPath)}`;
  const dotIndex = file.name.lastIndexOf('.');
  const ext = dotIndex >= 0 ? file.name.slice(dotIndex + 1).toLowerCase() : '';
  return (
    <FilePreview
      input={{
        path: file.diskPath,
        name: file.name,
        family: file.family,
        ext,
        mime: previewInfo?.mime ?? '',
        size: previewInfo?.size ?? 0,
        content: previewInfo?.content,
        rawUrl,
      }}
    />
  );
}

export function CBPreviewPanel({
  previewItem,
  foldersInPath,
  diskFiles,
  gameSlug,
  onClose,
  onDrag,
  onDragEnd,
}: CBPreviewPanelProps): ReactNode {
  const { t } = useTranslation();
  const [previewInfo, setPreviewInfo] = useState<PreviewFileInfo | null>(null);
  const [filePreviewMode, setFilePreviewMode] = useState<CBFilePreviewMode>('assets');
  const previewKey = previewItemKey(previewItem);

  useEffect(() => {
    setFilePreviewMode('assets');
  }, [previewKey]);

  useEffect(() => {
    if (!previewItem || previewItem.type !== 'file') {
      setPreviewInfo(null);
      return;
    }
    const needsSource = previewItem.assets.length === 0
      || (fileSupportsDualPreview(previewItem) && filePreviewMode === 'source');
    if (!needsSource) {
      setPreviewInfo(null);
      return;
    }
    let cancelled = false;
    void fetch(`/api/files?path=${encodeURIComponent(previewItem.diskPath)}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then((info: PreviewFileInfo | null) => {
        if (!cancelled) setPreviewInfo(info);
      })
      .catch(() => {
        if (!cancelled) setPreviewInfo(null);
      });
    return () => { cancelled = true; };
  }, [previewItem, filePreviewMode]);

  // Empty placeholder — keeps the panel (and its resize handle) mounted so the
  // layout is identical whether or not something is selected.
  if (!previewItem) {
    return (
      <>
        <ResizeHandle orientation="col" onDrag={onDrag} onDragEnd={onDragEnd} title={t('editor.contentBrowser.actions.resizePreview')} />
        <aside className="cb-preview-panel cb-preview-empty" data-facts="product" data-projection-source="editor-product">
          <div className="cb-preview-body">
            <div className="cb-preview-note">{t('editor.contentBrowser.preview.nothingSelected')}</div>
          </div>
        </aside>
      </>
    );
  }

  const name = previewItem.name;
  const meta = previewItem.type === 'folder'
    ? t('editor.contentBrowser.preview.folderMeta', { path: previewItem.path || gameSlug })
    : previewItem.type === 'file'
      ? t('editor.contentBrowser.preview.fileMeta', { kind: previewItem.kindLabel, path: previewItem.path })
      : t('editor.contentBrowser.preview.assetMeta', { kind: previewItem.kind, path: previewItem.packPath });
  const icon = previewItem.type === 'folder'
    ? <ContentBrowserIcon name="folder-open" />
    : previewItem.type === 'file'
      ? <FileFamilyIcon family={previewItem.family} />
      : <ContentBrowserIcon name={iconNameForAssetKind(previewItem.kind)} />;
  const showDualPreview = previewItem.type === 'file' && fileSupportsDualPreview(previewItem);

  let body: ReactNode;
  if (previewItem.type === 'folder') {
    const kids = [
      ...foldersInPath.filter(folder => dirOfPath(folder.path) === previewItem.path),
      ...diskFiles.filter(file => dirOfPath(file.path) === previewItem.path),
    ].slice(0, 40);
    body = kids.length === 0 ? (
      <div className="cb-preview-note">{t('editor.contentBrowser.preview.emptyFolder')}</div>
    ) : (
      <div className="cb-preview-list">
        {kids.map(child => (
          <div className="cb-preview-list-item" key={child.path}>
            <span className="cb-preview-list-ico">
              {child.type === 'folder' ? <ContentBrowserIcon name="folder" /> : <FileFamilyIcon family={child.family} />}
            </span>
            <span>{child.name}</span>
            <span className="sub">{child.type === 'folder' ? t('editor.contentBrowser.preview.items', { count: child.childCount }) : child.kindLabel}</span>
          </div>
        ))}
      </div>
    );
  } else if (previewItem.type === 'file') {
    if (previewItem.assets.length > 0) {
      body = filePreviewMode === 'source' && showDualPreview
        ? <FileSourcePreview file={previewItem} previewInfo={previewInfo} />
        : <FileAssetList file={previewItem} />;
    } else {
      body = <FileSourcePreview file={previewItem} previewInfo={previewInfo} />;
    }
  } else {
    body = previewItem.kind === 'ui' ? (
      <CBUiAssetPreview asset={previewItem} gameSlug={gameSlug} />
    ) : (
      <>
        <div className="cb-preview-media cb-preview-asset-hero">
          <AssetThumbnail kind={previewItem.kind} payload={realPayload(previewItem.guid, previewItem.payload)} packPath={previewItem.packPath} size={168} fit="contain" />
        </div>
        <div className="cb-preview-asset-list">
          <div className="cb-preview-asset-row">
            <AssetThumbnail kind={previewItem.kind} payload={realPayload(previewItem.guid, previewItem.payload)} packPath={previewItem.packPath} size={30} />
            <div>
              <div>{previewItem.name}</div>
              <div className="kind">{previewItem.packPath}</div>
            </div>
            <span className="guid">{previewItem.guid.slice(0, 10)}...</span>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <ResizeHandle orientation="col" onDrag={onDrag} onDragEnd={onDragEnd} title={t('editor.contentBrowser.actions.resizePreview')} />
      <aside
        className="cb-preview-panel"
        data-facts="product"
        data-projection-source="editor-product"
        data-subject-id={previewItem.type === 'asset' ? previewItem.guid : previewItem.path}
      >
        <div className="cb-preview-head">
          <span className="cb-preview-ico">{icon}</span>
          <div className="cb-preview-title">
            <div className="name">{name}</div>
            <div className="meta">{meta}</div>
          </div>
          <button className="cb-preview-close" type="button" onClick={onClose}>×</button>
        </div>
        {showDualPreview && (
          <div className="cb-preview-mode-bar" role="tablist" aria-label={t('editor.contentBrowser.preview.modeAssets')}>
            <button
              type="button"
              role="tab"
              className={`cb-preview-mode-btn${filePreviewMode === 'assets' ? ' is-active' : ''}`}
              aria-selected={filePreviewMode === 'assets'}
              onClick={() => setFilePreviewMode('assets')}
            >
              {t('editor.contentBrowser.preview.modeAssets')}
            </button>
            <button
              type="button"
              role="tab"
              className={`cb-preview-mode-btn${filePreviewMode === 'source' ? ' is-active' : ''}`}
              aria-selected={filePreviewMode === 'source'}
              onClick={() => setFilePreviewMode('source')}
            >
              {t('editor.contentBrowser.preview.modeSource')}
            </button>
          </div>
        )}
        <div className="cb-preview-body">{body}</div>
      </aside>
    </>
  );
}
