// CBSourceTree — the left-hand source-panel tree (folders + non-registry-backed
// disk files). Recursive row rendering extracted from ContentBrowser.tsx so
// the component file focuses on state + wiring.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useKeybindingScope } from '@forgeax/interface/core/app-shell';
import { useTranslation, type TFunction } from '@forgeax/editor-core/i18n';
import { dispatchActiveEditorOperation } from '@forgeax/editor-core';
import { ContentBrowserIcon } from './content-browser-icons';
import { CBInlineRename } from './CBInlineRename';
import {
  isPathInSelectionChain,
  viewItemKey,
  type SourceTreeNode,
} from './content-browser-format';
import type { CBFolder, CBViewItem } from './types';

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

interface FavoriteDir {
  path: string;
  name: string;
}

/** Only directories are favoritable, so the Favorites group is a flat list of
 * every favorited folder found anywhere in the source tree (order = tree order). */
function collectFavoriteDirs(nodes: SourceTreeNode[], acc: FavoriteDir[] = []): FavoriteDir[] {
  for (const node of nodes) {
    if (node.type === 'folder' && node.isFavorite) acc.push({ path: node.path, name: node.name });
    if (node.children.length > 0) collectFavoriteDirs(node.children, acc);
  }
  return acc;
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
  onFocusItem: (item: CBViewItem | null) => void;
  nav: Nav;
  openFolderContextMenu: (pos: ContextMenuPos, folder: CBFolder) => void;
  /** viewItemKey (= path) of the tree row being inline-renamed, or null. */
  renamingKey: string | null;
  renameValidate: (value: string) => string | null;
  onRenameCommit: (item: CBViewItem, value: string) => void;
  onRenameCancel: () => void;
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
    onFocusItem: (item: CBViewItem | null) => void;
    nav: Nav;
    openFolderContextMenu: CBSourceTreeProps['openFolderContextMenu'];
    renamingKey: string | null;
    renameValidate: CBSourceTreeProps['renameValidate'];
    onRenameCommit: CBSourceTreeProps['onRenameCommit'];
    onRenameCancel: CBSourceTreeProps['onRenameCancel'];
  },
): ReactNode {
  const { t, collapsedSourceFolders, setCollapsedSourceFolders, setFavoritesOnly, selectedPath, setSelectedItem, setPreviewItem, onFocusItem, nav, openFolderContextMenu, renamingKey, renameValidate, onRenameCommit, onRenameCancel } = ctx;
  // The source tree lists DIRECTORIES only — files live in the right-hand grid.
  // Folders are expanded by default; the store records only the ones a
  // double-click has explicitly COLLAPSED (`=== true`). A folder is expandable
  // only when it has SUB-folders, so a folder holding just files is a navigable
  // leaf (clicking it drills the grid into that folder).
  return nodes.filter(node => node.type === 'folder').map((node) => {
    const expandable = node.children.some(child => child.type === 'folder');
    const open = expandable && collapsedSourceFolders[node.path] !== true;
    const inSelectionPath = isPathInSelectionChain(selectedPath, node.path);
    const selected = selectedPath === node.path;
    const folder: CBFolder = {
      type: 'folder',
      path: node.path,
      name: node.name,
      childCount: node.childCount,
      isFavorite: node.isFavorite,
    };
    const handleClick = () => {
      setFavoritesOnly(false);
      nav.navigate(node.path);
      setSelectedItem(folder);
      setPreviewItem(folder);
      selectTreePath(folder.path, 'dir');
    };
    const handleDoubleClick = () => {
      if (!expandable) return;
      setCollapsedSourceFolders(prev => ({ ...prev, [node.path]: prev[node.path] !== true }));
    };
    const handleRowContextMenu = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setSelectedItem(folder);
      setPreviewItem(folder);
      selectTreePath(folder.path, 'dir');
      openFolderContextMenu({ clientX: e.clientX, clientY: e.clientY, preventDefault: () => {} }, folder);
    };

    const renaming = renamingKey != null && renamingKey === viewItemKey(folder);
    const chev = (
      <span
        className={`cb-source-chev${expandable ? '' : ' hidden'}`}
        onClick={expandable ? (e) => { e.stopPropagation(); handleDoubleClick(); } : undefined}
      ><ContentBrowserIcon name="chevron-down" /></span>
    );
    const icon = (
      <span className="cb-source-icon">
        <ContentBrowserIcon name={expandable && open ? 'folder-open' : 'folder'} />
      </span>
    );

    return (
      <div key={node.path} className="cb-source-node">
        {renaming ? (
          // Editing variant: a plain row (no <button>, so the <input> is not
          // nested in an interactive control) carrying the shared inline editor.
          <div
            className={`cb-source-row${inSelectionPath ? ' is-path' : ''}${selected ? ' is-sel' : ''}${expandable && !open ? ' collapsed' : ''}`}
            style={{ paddingLeft: `${16 + depth * 14}px` }}
            title={node.path}
          >
            {chev}
            {icon}
            <CBInlineRename
              initial={node.name}
              validate={renameValidate}
              onCommit={(value) => onRenameCommit(folder, value)}
              onCancel={onRenameCancel}
              ariaLabel={t('editor.contentBrowser.contextMenu.rename')}
            />
          </div>
        ) : (
          <button
            type="button"
            className={`no-motion-lift cb-source-row${inSelectionPath ? ' is-path' : ''}${selected ? ' is-sel' : ''}${expandable && !open ? ' collapsed' : ''}`}
            style={{ paddingLeft: `${16 + depth * 14}px` }}
            title={node.path}
            tabIndex={selected ? 0 : -1}
            onFocus={() => onFocusItem(folder)}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            onContextMenu={handleRowContextMenu}
          >
            {chev}
            {icon}
            <span className="cb-source-name">{node.name}</span>
          </button>
        )}
        {expandable && open && renderRows(node.children, depth + 1, ctx)}
      </div>
    );
  });
}

export function CBSourceTree({
  sourceTree,
  projectName,
  setFavoritesOnly,
  collapsedSourceFolders,
  setCollapsedSourceFolders,
  selectedPath,
  setSelectedItem,
  setPreviewItem,
  onFocusItem,
  nav,
  openFolderContextMenu,
  renamingKey,
  renameValidate,
  onRenameCommit,
  onRenameCancel,
}: CBSourceTreeProps): ReactNode {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  useKeybindingScope(rootRef, 'editor.contentBrowser.sourceTree');
  // Two independent accordion groups — both may be open at once.
  const [favoritesGroupOpen, setFavoritesGroupOpen] = useState(true);
  const [projectOpen, setProjectOpen] = useState(true);
  const favoriteDirs = useMemo(() => collectFavoriteDirs(sourceTree), [sourceTree]);

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

  // Clicking a favorited directory jumps the content view to it AND lights its
  // row in the project tree (the reveal effect above expands the ancestor chain
  // from the resulting selectedPath).
  const revealFavoriteDir = (dir: FavoriteDir) => {
    setFavoritesOnly(false);
    const folder: CBFolder = { type: 'folder', path: dir.path, name: dir.name, childCount: 0, isFavorite: true };
    nav.navigate(dir.path);
    setSelectedItem(folder);
    setPreviewItem(folder);
    selectTreePath(dir.path, 'dir');
    setProjectOpen(true);
  };

  return (
    <div ref={rootRef} className="cb-source-panel">
      <div className="cb-source-tree">
        {/* ── Favorites accordion ── */}
        <div className="cb-source-group">
          <button
            type="button"
            className={`no-motion-lift cb-source-group-head${favoritesGroupOpen ? '' : ' collapsed'}`}
            title={t('editor.contentBrowser.sourceTree.favorites')}
            onClick={() => setFavoritesGroupOpen(open => !open)}
          >
            <span className="cb-source-chev"><ContentBrowserIcon name="chevron-down" /></span>
            <span className="cb-source-group-name">{t('editor.contentBrowser.sourceTree.favorites')}</span>
          </button>
          {favoritesGroupOpen && (
            <div className="cb-source-group-body">
              {favoriteDirs.length === 0 ? (
                <div className="cb-source-empty">{t('editor.contentBrowser.sourceTree.favoritesEmpty')}</div>
              ) : (
                favoriteDirs.map(dir => {
                  const folder: CBFolder = { type: 'folder', path: dir.path, name: dir.name, childCount: 0, isFavorite: true };
                  const selected = selectedPath === dir.path;
                  return (
                    <button
                      key={dir.path}
                      type="button"
                      className={`no-motion-lift cb-source-row${selected ? ' is-sel' : ''}`}
                      style={{ paddingLeft: '16px' }}
                      title={dir.path}
                      tabIndex={selected ? 0 : -1}
                      onFocus={() => onFocusItem(folder)}
                      onClick={() => revealFavoriteDir(dir)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        revealFavoriteDir(dir);
                        openFolderContextMenu({ clientX: e.clientX, clientY: e.clientY, preventDefault: () => {} }, folder);
                      }}
                    >
                      <span className="cb-source-chev hidden"><ContentBrowserIcon name="chevron-down" /></span>
                      <span className="cb-source-icon"><ContentBrowserIcon name="folder" /></span>
                      <span className="cb-source-name">{dir.name}</span>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* ── Project accordion ── */}
        <div className="cb-source-group">
          <button
            type="button"
            className={`no-motion-lift cb-source-group-head${projectOpen ? '' : ' collapsed'}`}
            title={projectName}
            onClick={() => setProjectOpen(open => !open)}
          >
            <span className="cb-source-chev"><ContentBrowserIcon name="chevron-down" /></span>
            <span className="cb-source-group-name">{projectName}</span>
          </button>
          {projectOpen && (
            <div className="cb-source-group-body">
              {renderRows(sourceTree, 0, {
                t,
                collapsedSourceFolders,
                setCollapsedSourceFolders,
                setFavoritesOnly,
                selectedPath,
                setSelectedItem,
                setPreviewItem,
                onFocusItem,
                nav,
                openFolderContextMenu,
                renamingKey,
                renameValidate,
                onRenameCommit,
                onRenameCancel,
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
