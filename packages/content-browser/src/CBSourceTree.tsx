// CBSourceTree — the left-hand source-panel tree (folders + non-registry-backed
// disk files). Recursive row rendering extracted from ContentBrowser.tsx so
// the component file focuses on state + wiring.

import { useCallback, type ReactNode } from 'react';
import { useTranslation, type TFunction } from '@forgeax/editor-core/i18n';
import { ContentBrowserIcon, FileFamilyIcon } from './content-browser-icons';
import {
  dirOfPath,
  fileKindLabel,
  viewItemPath,
  type SourceTreeNode,
} from './content-browser-format';
import type { CBFile, CBFolder, CBViewItem } from './types';

interface Nav {
  currentPath: string;
  navigate: (path: string) => void;
}

interface ContextMenuPos {
  clientX: number;
  clientY: number;
  preventDefault: () => void;
}

export interface CBSourceTreeProps {
  sourceTree: SourceTreeNode[];
  gameSlug: string;
  scopedAssetsCount: number;
  collapsedSourceFolders: Record<string, boolean>;
  setCollapsedSourceFolders: (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => void;
  previewItem: CBViewItem | null;
  setPreviewItem: (item: CBViewItem | null) => void;
  nav: Nav;
  openFolderContextMenu: (pos: ContextMenuPos, folder: CBFolder) => void;
  openFileContextMenu: (pos: ContextMenuPos, file: CBFile) => void;
}

function renderRows(
  nodes: SourceTreeNode[],
  depth: number,
  ctx: {
    t: TFunction;
    collapsedSourceFolders: Record<string, boolean>;
    setCollapsedSourceFolders: CBSourceTreeProps['setCollapsedSourceFolders'];
    previewItem: CBViewItem | null;
    setPreviewItem: (item: CBViewItem | null) => void;
    nav: Nav;
    openFolderContextMenu: CBSourceTreeProps['openFolderContextMenu'];
    openFileContextMenu: CBSourceTreeProps['openFileContextMenu'];
  },
): ReactNode {
  const { t, collapsedSourceFolders, setCollapsedSourceFolders, previewItem, setPreviewItem, nav, openFolderContextMenu, openFileContextMenu } = ctx;
  return nodes.map((node) => {
    const open = !collapsedSourceFolders[node.path];
    const selectedPath = viewItemPath(previewItem);
    const selected = selectedPath != null
      ? selectedPath === node.path
      : node.type === 'folder' && nav.currentPath === node.path;
    const folder: CBFolder = {
      type: 'folder',
      path: node.path,
      name: node.name,
      childCount: node.childCount,
      isFavorite: node.isFavorite,
    };
    const file: CBFile | null = node.type === 'file' ? {
      type: 'file',
      path: node.path,
      diskPath: node.diskPath,
      name: node.name,
      family: node.family ?? 'other',
      assets: node.assets ?? [],
      kindLabel: fileKindLabel(t, node.family ?? 'other'),
      isFavorite: node.isFavorite,
    } : null;
    const handleClick = () => {
      if (file) {
        nav.navigate(dirOfPath(file.path));
        setPreviewItem(file);
        return;
      }
      setCollapsedSourceFolders(prev => ({ ...prev, [node.path]: open }));
      nav.navigate(node.path);
      setPreviewItem(folder);
    };
    const handleRowContextMenu = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (file) {
        setPreviewItem(file);
        openFileContextMenu({ clientX: e.clientX, clientY: e.clientY, preventDefault: () => {} }, file);
      } else {
        setPreviewItem(folder);
        openFolderContextMenu({ clientX: e.clientX, clientY: e.clientY, preventDefault: () => {} }, folder);
      }
    };

    return (
      <div key={node.path} className="cb-source-node">
        <button
          type="button"
          className={`no-motion-lift cb-source-row${selected ? ' is-sel' : ''}${open ? '' : ' collapsed'}`}
          style={{ paddingLeft: `${12 + depth * 14}px` }}
          title={node.path}
          onClick={handleClick}
          onContextMenu={handleRowContextMenu}
        >
          <span className={`cb-source-chev${node.type === 'file' ? ' hidden' : ''}`}><ContentBrowserIcon name="chevron-down" /></span>
          <span className={`cb-source-icon${node.type === 'file' ? ` is-${node.family ?? 'other'}` : ''}`}>
            {node.type === 'folder' ? <ContentBrowserIcon name={open ? 'folder-open' : 'folder'} /> : <FileFamilyIcon family={node.family ?? 'other'} />}
          </span>
          <span className="cb-source-name">{node.name}</span>
          {node.childCount > 0 && <span className="cb-source-count">{t('editor.contentBrowser.preview.assetCount', { count: node.childCount })}</span>}
        </button>
        {node.type === 'folder' && open && node.children.length > 0 && renderRows(node.children, depth + 1, ctx)}
      </div>
    );
  });
}

export function CBSourceTree({
  sourceTree,
  gameSlug,
  scopedAssetsCount,
  collapsedSourceFolders,
  setCollapsedSourceFolders,
  previewItem,
  setPreviewItem,
  nav,
  openFolderContextMenu,
  openFileContextMenu,
}: CBSourceTreeProps): ReactNode {
  const { t } = useTranslation();
  const rows = useCallback(() => renderRows(sourceTree, 0, {
    t,
    collapsedSourceFolders,
    setCollapsedSourceFolders,
    previewItem,
    setPreviewItem,
    nav,
    openFolderContextMenu,
    openFileContextMenu,
  }), [sourceTree, t, collapsedSourceFolders, setCollapsedSourceFolders, previewItem, setPreviewItem, nav, openFolderContextMenu, openFileContextMenu]);

  return (
    <div className="cb-source-panel">
      <div className="cb-source-tree">
        <button
          type="button"
          className="no-motion-lift cb-source-zone-head"
          onClick={() => nav.navigate('')}
          title={gameSlug}
        >
          <span className="cb-source-chev"><ContentBrowserIcon name="chevron-down" /></span>
          <span className="cb-source-zone-icon"><ContentBrowserIcon name="package" /></span>
          <span className="cb-source-zone-name">{t('editor.contentBrowser.sourceTree.gameAssets')}</span>
          <span className="cb-source-zone-count">{t('editor.contentBrowser.sourceTree.assetCount', { count: scopedAssetsCount })}</span>
        </button>
        <div className="cb-source-rows">
          {rows()}
        </div>
      </div>
    </div>
  );
}
