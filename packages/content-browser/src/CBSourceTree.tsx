// CBSourceTree — the left-hand source-panel tree (folders + non-registry-backed
// disk files). Recursive row rendering extracted from ContentBrowser.tsx so
// the component file focuses on state + wiring.

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation, type TFunction } from '@forgeax/editor-core/i18n';
import { dispatchActiveEditorOperation, gateway } from '@forgeax/editor-core';
import { ContentBrowserIcon, FileFamilyIcon } from './content-browser-icons';
import {
  dirOfPath,
  fileKindLabel,
  isPathInSelectionChain,
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

// Selection is a session op — tree clicks dispatch it through the one gateway
// door (north-star parity: the folder-selection store's contract states clicks
// dispatch `setFolderSelection`, keeping AI parity). Mirrors the grid's
// useMultiSelect.dispatchSet dual-dispatch: empty the asset domain FIRST so the
// selected tree path becomes the active path-domain subject, then set the path
// selection LAST so lastSelectionDomain derives to 'folder'. The visual path
// chain is derived separately from the selected subject and does not dispatch
// ancestors as additional destructive-selection targets.
function selectTreePath(path: string, kind: 'dir' | 'file'): void {
  void dispatchActiveEditorOperation({ kind: 'setAssetSelection', assets: [], primary: null });
  void dispatchActiveEditorOperation({ kind: 'setFolderSelection', items: [{ path, kind }] });
}

function clearTreeSelection(): void {
  gateway.dispatch({ kind: 'setAssetSelection', assets: [], primary: null });
  gateway.dispatch({ kind: 'setFolderSelection', items: [] });
}

export interface CBSourceTreeProps {
  projectName: string;
  favoritesOnly: boolean;
  setFavoritesOnly: (value: boolean) => void;
  sourceTree: SourceTreeNode[];
  collapsedSourceFolders: Record<string, boolean>;
  setCollapsedSourceFolders: (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => void;
  selectedPath: string | null;
  setSelectedItem: (item: CBViewItem | null) => void;
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
    setFavoritesOnly: CBSourceTreeProps['setFavoritesOnly'];
    selectedPath: string | null;
    setSelectedItem: (item: CBViewItem | null) => void;
    setPreviewItem: (item: CBViewItem | null) => void;
    nav: Nav;
    openFolderContextMenu: CBSourceTreeProps['openFolderContextMenu'];
    openFileContextMenu: CBSourceTreeProps['openFileContextMenu'];
  },
): ReactNode {
  const { t, collapsedSourceFolders, setCollapsedSourceFolders, setFavoritesOnly, selectedPath, setSelectedItem, setPreviewItem, nav, openFolderContextMenu, openFileContextMenu } = ctx;
  return nodes.map((node) => {
    // Disclosure is opt-in: folders stay closed until a double-click explicitly opens them.
    // Leaf folders have no tree children, so they are selectable/navigation
    // targets only and must not look or behave like expandable folders.
    const expandable = node.type === 'folder' && node.children.length > 0;
    const open = expandable && collapsedSourceFolders[node.path] === false;
    const inSelectionPath = isPathInSelectionChain(selectedPath, node.path);
    const selected = selectedPath === node.path;
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
      setFavoritesOnly(false);
      if (file) {
        nav.navigate(dirOfPath(file.path));
        setSelectedItem(file);
        setPreviewItem(file);
        selectTreePath(file.path, 'file');
        return;
      }
      nav.navigate(node.path);
      setSelectedItem(folder);
      setPreviewItem(folder);
      selectTreePath(folder.path, 'dir');
    };
    const handleDoubleClick = () => {
      if (!expandable) return;
      setCollapsedSourceFolders(prev => ({ ...prev, [node.path]: prev[node.path] === false }));
    };
    const handleRowContextMenu = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (file) {
        setSelectedItem(file);
        setPreviewItem(file);
        selectTreePath(file.path, 'file');
        openFileContextMenu({ clientX: e.clientX, clientY: e.clientY, preventDefault: () => {} }, file);
      } else {
        setSelectedItem(folder);
        setPreviewItem(folder);
        selectTreePath(folder.path, 'dir');
        openFolderContextMenu({ clientX: e.clientX, clientY: e.clientY, preventDefault: () => {} }, folder);
      }
    };

    return (
      <div key={node.path} className="cb-source-node">
        <button
          type="button"
          className={`no-motion-lift cb-source-row${inSelectionPath ? ' is-path' : ''}${selected ? ' is-sel' : ''}${expandable && !open ? ' collapsed' : ''}`}
          style={{ paddingLeft: `${depth * 14}px` }}
          title={node.path}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onContextMenu={handleRowContextMenu}
        >
          <span className={`cb-source-chev${expandable ? '' : ' hidden'}`}><ContentBrowserIcon name="chevron-down" /></span>
          <span className={`cb-source-icon${node.type === 'file' ? ` is-${node.family ?? 'other'}` : ''}`}>
            {node.type === 'folder' ? <ContentBrowserIcon name={expandable && open ? 'folder-open' : 'folder'} /> : <FileFamilyIcon family={node.family ?? 'other'} />}
          </span>
          <span className="cb-source-name">{node.name}</span>
        </button>
        {expandable && open && renderRows(node.children, depth + 1, ctx)}
      </div>
    );
  });
}

export function CBSourceTree({
  sourceTree,
  projectName,
  favoritesOnly,
  setFavoritesOnly,
  collapsedSourceFolders,
  setCollapsedSourceFolders,
  selectedPath,
  setSelectedItem,
  setPreviewItem,
  nav,
  openFolderContextMenu,
  openFileContextMenu,
}: CBSourceTreeProps): ReactNode {
  const { t } = useTranslation();
  const [projectOpen, setProjectOpen] = useState(false);
  const projectExpandable = sourceTree.length > 0;

  // A grid selection can originate below a collapsed root. Reveal the
  // selected subject's path chain so the two selection layers remain visible;
  // a later manual double-click can still collapse it again.
  useEffect(() => {
    if (selectedPath === null) return;
    setProjectOpen(previous => previous ? previous : true);
    const expandablePaths = new Set<string>();
    const collectExpandable = (nodes: SourceTreeNode[]) => {
      for (const node of nodes) {
        if (node.type === 'folder' && node.children.length > 0) expandablePaths.add(node.path);
        collectExpandable(node.children);
      }
    };
    collectExpandable(sourceTree);
    const segments = selectedPath.split('/');
    const ancestors: string[] = [];
    for (let index = 0; index < segments.length - 1; index += 1) {
      const path = segments.slice(0, index + 1).join('/');
      if (expandablePaths.has(path)) ancestors.push(path);
    }
    if (ancestors.length === 0) return;
    setCollapsedSourceFolders(previous => {
      let next = previous;
      for (const path of ancestors) {
        if (next[path] === false) continue;
        if (next === previous) next = { ...previous };
        next[path] = false;
      }
      return next;
    });
  }, [selectedPath, setCollapsedSourceFolders, sourceTree]);

  const selectProjectRoot = () => {
    setFavoritesOnly(false);
    nav.navigate('');
    setSelectedItem(null);
    setPreviewItem(null);
    clearTreeSelection();
  };

  const selectFavorites = () => {
    setFavoritesOnly(true);
    nav.navigate('');
    setSelectedItem(null);
    setPreviewItem(null);
    clearTreeSelection();
  };

  const handleProjectDoubleClick = () => {
    if (!projectExpandable) return;
    setProjectOpen(previous => !previous);
  };

  const projectSelected = !favoritesOnly && selectedPath === null && nav.currentPath === '';
  const projectInSelectionPath = isPathInSelectionChain(selectedPath, '');

  return (
    <div className="cb-source-panel">
      <div className="cb-source-tree">
        <div className="cb-source-rows">
          <button
            type="button"
            className={`no-motion-lift cb-source-zone-head${projectInSelectionPath ? ' is-path' : ''}${projectSelected ? ' is-sel' : ''}${projectExpandable && !projectOpen ? ' collapsed' : ''}`}
            title={projectName}
            onClick={selectProjectRoot}
            onDoubleClick={handleProjectDoubleClick}
          >
            <span className={`cb-source-chev${projectExpandable ? '' : ' hidden'}`}><ContentBrowserIcon name="chevron-down" /></span>
            <span className="cb-source-zone-icon"><ContentBrowserIcon name="package" /></span>
            <span className="cb-source-zone-name">{projectName}</span>
          </button>
          {projectOpen && <div className="cb-source-project-children">
            {renderRows(sourceTree, 0, {
              t,
              collapsedSourceFolders,
              setCollapsedSourceFolders,
              setFavoritesOnly,
              selectedPath,
              setSelectedItem,
              setPreviewItem,
              nav,
              openFolderContextMenu,
              openFileContextMenu,
            })}
          </div>}
          <button
            type="button"
            className={`no-motion-lift cb-source-row cb-source-favorites-row${favoritesOnly ? ' is-sel' : ''}`}
            title={t('editor.contentBrowser.sourceTree.favorites')}
            onClick={selectFavorites}
          >
            <span className="cb-source-chev hidden"><ContentBrowserIcon name="chevron-down" /></span>
            <span className="cb-source-icon"><ContentBrowserIcon name="star" /></span>
            <span className="cb-source-name">{t('editor.contentBrowser.sourceTree.favorites')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
