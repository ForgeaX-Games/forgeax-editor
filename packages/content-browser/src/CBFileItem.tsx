import type { MouseEvent } from 'react';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { colorForFileFamily, ContentBrowserIcon, FileFamilyIcon } from './content-browser-icons';
import type { CBFile } from './types';

interface Props {
  file: CBFile;
  selected: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  onClick: (e: MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: MouseEvent) => void;
}

export function CBFileItem({ file, selected, expanded, onToggleExpand, onClick, onDoubleClick, onContextMenu }: Props) {
  const { t } = useTranslation();
  const hasAssets = file.assets.length > 0;
  const expandable = Boolean(onToggleExpand);
  const metaLabel = hasAssets ? t('editor.contentBrowser.preview.assetCount', { count: file.assets.length }) : file.kindLabel;
  const metaColor = hasAssets ? 'var(--accent-mint, #63eacf)' : colorForFileFamily(file.family);

  return (
    <div
      className={`cb-grid-item cb-fe-card cb-file-card${selected ? ' sel' : ''}${expanded ? ' cb-pack-expanded' : ''}`}
      data-testid="cb-file-item"
      data-file-path={file.path}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={e => { e.preventDefault(); onContextMenu(e); }}
      title={file.path}
    >
      <span className={`cb-card-fav${file.isFavorite ? ' on' : ''}`}><ContentBrowserIcon name="star" /></span>
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
