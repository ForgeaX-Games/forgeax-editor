// CBPreviewPanel — the right-hand aside that previews the currently-selected
// Content Browser item (folder / file / asset).
//
// Owns the small async fetch for on-disk file metadata (/api/files?path=…)
// used to show text-file content inline. Everything else is derived from
// props: keep this component free of Content-Browser–level state so it can
// re-render only when the previewed item changes.

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { ResizeHandle } from '@forgeax/editor-core';
import { colorForAssetKind, ContentBrowserIcon, FileFamilyIcon, iconNameForAssetKind } from './content-browser-icons';
import { dirOfPath, type PreviewFileInfo } from './content-browser-format';
import type { CBFile, CBFolder, CBViewItem } from './types';

export interface CBPreviewPanelProps {
  previewItem: CBViewItem;
  foldersInPath: CBFolder[];
  diskFiles: CBFile[];
  gameSlug: string;
  onClose: () => void;
  onDrag: (dx: number) => void;
  onDragEnd: () => void;
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

  useEffect(() => {
    if (previewItem.type !== 'file') {
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
  }, [previewItem]);

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
    const rawUrl = `/api/files/raw?path=${encodeURIComponent(previewItem.diskPath)}`;
    if (previewItem.assets.length > 0) {
      body = (
        <div className="cb-preview-asset-list">
          {previewItem.assets.map(asset => (
            <div className="cb-preview-asset-row" key={asset.guid}>
              <span className="cb-preview-list-ico" style={{ color: colorForAssetKind(asset.kind) }}>
                <ContentBrowserIcon name={iconNameForAssetKind(asset.kind)} />
              </span>
              <div>
                <div>{asset.name}</div>
                <div className="kind" style={{ color: colorForAssetKind(asset.kind) }}>{asset.kind}</div>
              </div>
              <span className="guid">{asset.guid.slice(0, 10)}...</span>
            </div>
          ))}
        </div>
      );
    } else if (previewItem.family === 'image') {
      body = <div className="cb-preview-media"><img src={rawUrl} alt={previewItem.name} /></div>;
    } else if (previewItem.family === 'audio') {
      body = <div className="cb-preview-media"><audio controls src={rawUrl} /></div>;
    } else if (previewInfo?.content != null) {
      body = <pre className="cb-preview-code">{previewInfo.content}</pre>;
    } else {
      body = <div className="cb-preview-note">{t('editor.contentBrowser.preview.noTextPreview')}</div>;
    }
  } else {
    body = (
      <div className="cb-preview-asset-list">
        <div className="cb-preview-asset-row">
          <span className="cb-preview-list-ico" style={{ color: colorForAssetKind(previewItem.kind) }}>
            <ContentBrowserIcon name={iconNameForAssetKind(previewItem.kind)} />
          </span>
          <div>
            <div>{previewItem.name}</div>
            <div className="kind">{previewItem.packPath}</div>
          </div>
          <span className="guid">{previewItem.guid.slice(0, 10)}...</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <ResizeHandle orientation="col" onDrag={onDrag} onDragEnd={onDragEnd} title={t('editor.contentBrowser.actions.resizePreview')} />
      <aside className="cb-preview-panel">
        <div className="cb-preview-head">
          <span className="cb-preview-ico">{icon}</span>
          <div className="cb-preview-title">
            <div className="name">{name}</div>
            <div className="meta">{meta}</div>
          </div>
          <button className="cb-preview-close" type="button" onClick={onClose}>×</button>
        </div>
        <div className="cb-preview-body">{body}</div>
      </aside>
    </>
  );
}
