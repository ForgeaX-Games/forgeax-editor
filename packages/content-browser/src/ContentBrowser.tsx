import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useHost } from '@forgeax/interface/core/app-shell';
import { useTranslation } from '@forgeax/editor-core/i18n';
// Asset-selection is a transient op dispatched through the one gateway door
// (gateway.dispatch({ kind: 'setAssetSelection', … })), never the direct setter.
import { generateAssetGuid, gateway, getSceneId, requestAddAssetsToChat, resolveGamePath, showContextMenu, useDocVersion,
  ResizeHandle, useLocalSize, getSceneList } from '@forgeax/editor-core';
// Editor-ui overlay services replace window.prompt/confirm — a themed modal
// (Dialog / AlertDialog) mounted once at the app root via EditorOverlayProvider
// (standalone main.tsx / studio editorRenderers.tsx). Both are async.
import { confirm as confirmDialog, prompt as promptDialog } from '@forgeax/editor-ui';
import { useMultiSelect } from './hooks/useMultiSelect';
import { useSort } from './hooks/useSort';
import { useFilter } from './hooks/useFilter';
import { useNavHistory } from './hooks/useNavHistory';
import { useFavorites } from './hooks/useFavorites';
import { useAssetGraph } from './hooks/useAssetGraph';
import { useCBData } from './hooks/useCBData';
import { useCBDerivedView } from './hooks/useCBDerivedView';
import { useContentBrowserCommands } from './hooks/useContentBrowserCommands';
import { computeDeleteImpact } from './delete-guard';
import { DeleteGuardDialog } from './DeleteGuardDialog';
import { buildAssetContextMenu, buildBlankAreaContextMenu, buildFolderContextMenu, type CRUDCallbacks } from './CBContextMenu';
import { resolveFolderMenuItems } from './folder-menu';
import { CBNavigationBar } from './CBNavigationBar';
import { CBGrid } from './CBGrid';
import { CBPreviewPanel } from './CBPreviewPanel';
import { CBSourceTree } from './CBSourceTree';
import { iconNameForAssetKind, iconNameForFileFamily } from './content-browser-icons';
import { importFiles, type ImportProgress } from './import-pipeline';
import { isImportable, buildAcceptString, logImport } from './import-registry';
import type { CreatableAssetSpec } from './creatable-asset-kinds';
import { catalogPathToRoot, type CatalogAssetRoot } from './catalog-root';
import { useContentBrowserPanelContributions } from './useContentBrowserPanelContributions';
import type { CBAsset, CBFile, CBFolder, CBSelection, CBViewItem } from './types';
import {
  viewItemKey,
  copyText,
  resolveCopyPath,
  orderContextMenuEntries,
  menuIconForId,
  fileSpecificMenuItems,
  type CBContextMenuEntry,
} from './content-browser-format';
import './content-browser.css';

// M3: single-realm — registry.listCatalog() replaces loadGameAssets/loadMetaAssets
// (plan-strategy S2 D1, S3.1 component map, requirements AC-03).
// The engine AssetRegistry is the SSOT for asset enumeration; the ContentBrowser
// reads directly from it via gateway.doc.registry.listCatalog().
// registry entries carry {guid, kind, name?, relativeUrl, refs?} — no
// payload/packPath, so import-mode filtering and payload-derived fields are
// removed. `refs` (forward dependency GUID edges) is surfaced by the engine
// AssetRegistry.listCatalog() (engine refs-through-listCatalog); it powers the
// Content Browser's "Add with Dependencies" and dependency-graph features.

// Vite injects package-declared roots from the same resolution call it passes to
// pluginPack, so the browser receives a projection instead of re-resolving disk
// layout conventions itself.
declare const __FORGEAX_CATALOG_ASSET_ROOTS__: readonly CatalogAssetRoot[];

const catalogAssetRoots: readonly CatalogAssetRoot[] =
  typeof __FORGEAX_CATALOG_ASSET_ROOTS__ === 'undefined'
    ? []
    : __FORGEAX_CATALOG_ASSET_ROOTS__;

export function ContentBrowser() {
  const host = useHost();
  const { t } = useTranslation();
  useContentBrowserPanelContributions();
  useDocVersion();
  const gameSlug = getSceneId();
  const { allAssets, loading, reload, diskTree, fetchDiskDirs } = useCBData(gameSlug, catalogAssetRoots);
  const [thumbnailSize, setThumbnailSize] = useState(80);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [collapsedSourceFolders, setCollapsedSourceFolders] = useState<Record<string, boolean>>({});
  const [previewItem, setPreviewItem] = useState<CBViewItem | null>(null);
  const [expandedPacks, setExpandedPacks] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const acceptString = useMemo(() => buildAcceptString(), []);
  const nav = useNavHistory();
  // Filter menu offers a FIXED set of spec-defined file families (`FE_FILTERABLE`)
  // — a static type filter, independent of the current folder's contents.
  const filter = useFilter();
  const sort = useSort();
  const favorites = useFavorites();
  // The Asset panel is scoped to the exact roots the host gave pluginPack.
  // `catalogAssetRoots` is derived from package.json#forgeax.assets.roots at the
  // host boundary, rather than re-reading package.json through a second browser
  // fetch and re-implementing the @shared alias here.

  // Source-panel width: draggable splitter (UE-parity — widen the tree to read
  // long folder paths). Persisted per-editor via localStorage.
  //
  // Isolation of the two write paths (fixes "drag doesn't resize"): the panel
  // width is driven by a CSS variable `--cb-src-w` set on the .cb-split PARENT,
  // NOT by a React-controlled `style={{width}}` on the panel itself. React only
  // writes the variable on commit (drag end); during a drag we imperatively
  // update the SAME parent variable via splitRef, so React never controls the
  // panel's width and can't revert the imperative value when ContentBrowser
  // re-renders (e.g. from the pack-watcher reload churn). Zero re-render during
  // drag; CBGrid reflows on its own ResizeObserver. onDragEnd persists once.
  const [srcWidth, setSrcWidth] = useLocalSize('cb.sourceWidth', 200, 140, 640);
  const [previewWidth, setPreviewWidth] = useLocalSize('cb.previewWidth', 280, 180, 560);
  const splitRef = useRef<HTMLDivElement>(null);
  const srcWidthRef = useRef(srcWidth);
  const previewWidthRef = useRef(previewWidth);
  useEffect(() => { srcWidthRef.current = srcWidth; }, [srcWidth]);
  useEffect(() => { previewWidthRef.current = previewWidth; }, [previewWidth]);
  const onSplitDrag = useCallback((dx: number) => {
    const next = Math.min(640, Math.max(140, srcWidthRef.current + dx));
    srcWidthRef.current = next;
    splitRef.current?.style.setProperty('--cb-src-w', `${next}px`);
  }, []);
  const onSplitDragEnd = useCallback(() => { setSrcWidth(srcWidthRef.current); }, [setSrcWidth]);
  const onPreviewDrag = useCallback((dx: number) => {
    const next = Math.min(560, Math.max(180, previewWidthRef.current - dx));
    previewWidthRef.current = next;
    splitRef.current?.style.setProperty('--cb-preview-w', `${next}px`);
  }, []);
  const onPreviewDragEnd = useCallback(() => { setPreviewWidth(previewWidthRef.current); }, [setPreviewWidth]);

  useEffect(() => {
    logImport('ContentBrowser.mount', { gameSlug, accept: acceptString, hasFbx: acceptString.includes('.fbx') });
  }, [acceptString, gameSlug]);

  const {
    scopedAssets,
    relByAssetGuid,
    diskFiles,
    viewMode,
    sourceTree,
    foldersInPath,
    filesInPath,
    sortedAssets,
    viewItems,
  } = useCBDerivedView({
    allAssets,
    gameSlug,
    diskTree,
    catalogAssetRoots,
    favorites,
    favoritesOnly,
    filter,
    sort,
    nav,
    expandedPacks,
  });

  const togglePackExpansion = useCallback((filePath: string) => {
    setExpandedPacks(prev => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath); else next.add(filePath);
      return next;
    });
  }, []);

  const multiSelect = useMultiSelect(viewItems);
  const selectItemForContextMenu = useCallback((item: CBViewItem, e: React.MouseEvent) => {
    setPreviewItem(item);
    if (multiSelect.isSelected(item)) return;
    const index = viewItems.findIndex(viewItem => viewItemKey(viewItem) === viewItemKey(item));
    if (index >= 0) multiSelect.handleClick(index, e);
  }, [multiSelect, viewItems]);

  // Dependency graph (C2) is built over the FULL catalog, not the scoped view:
  // an asset can be referenced from another root (scenes/, other packs), and the
  // delete guard (C3) must see those cross-root referencers to warn correctly.
  const assetGraph = useAssetGraph(allAssets);
  const nameByGuid = useCallback(
    (guid: string) => allAssets.find(a => a.guid === guid)?.name ?? `${guid.slice(0, 8)}…`,
    [allAssets],
  );

  const [deleteTargets, setDeleteTargets] = useState<CBAsset[] | null>(null);
  const requestDelete = useCallback((targets: CBAsset[]) => {
    if (targets.length === 0) return;
    setDeleteTargets(targets);
  }, []);
  const performDelete = useCallback(() => {
    setDeleteTargets(current => {
      if (current) {
        for (const a of current) {
          gateway.dispatch({ kind: 'destroyAsset', packPath: a.packPath, guid: a.guid }, 'human');
        }
      }
      return null;
    });
  }, []);

  // M3 (AC-03): asset-selection is a transient op — it goes through the one
  // gateway door (gateway.dispatch), never the direct setAssetSelection setter
  // (gateway-only door, M3), which is no longer exported from the barrel.
  const openAsset = useCallback((asset: CBAsset) => {
    // M1 (AC-B2): single-asset select uses the `setAssetSelectionOne` sugar op
    // (forwards to the multi-base setAssetSelection applier). The bare
    // `{kind:'setAssetSelection', asset}` mix is no longer valid — argsSchema
    // requires the base `{assets, primary}` shape; sugar keeps the old single
    // call site working without re-emitting the full set.
    gateway.dispatch({ kind: 'setAssetSelectionOne', asset: {
      guid: asset.guid,
      kind: asset.kind,
      name: asset.name,
      payload: asset.payload,
      packPath: asset.packPath,
    } });
    if (asset.kind === 'scene') {
      const rel = catalogPathToRoot(asset.packPath, gameSlug, catalogAssetRoots);
      const entry = rel ? getSceneList().find(s => s.pack === rel) : undefined;
      if (entry) {
        gateway.dispatch({ kind: 'switchSceneFile', id: entry.id });
      }
    }
  }, [gameSlug, catalogAssetRoots]);

  // Double-click: drill into a folder, or open an asset.
  // In file mode, double-clicking a pack/meta file toggles its sub-asset expansion.
  const handleActivate = useCallback((item: CBViewItem) => {
    if (item.type === 'folder') { nav.navigate(item.path); return; }
    if (item.type === 'file') {
      if (viewMode === 'file' && (item.family === 'pack' || item.family === 'meta') && item.assets.length > 0) {
        togglePackExpansion(item.path);
        return;
      }
      setPreviewItem(item);
      if (item.assets[0]) openAsset(item.assets[0]);
      return;
    }
    openAsset(item);
  }, [nav, openAsset, togglePackExpansion, viewMode]);

  const crudCallbacks: CRUDCallbacks = useMemo(() => ({
    onReload: reload,
    onDelete: requestDelete,
    onRename: (asset: CBAsset) => {
      void (async () => {
        const newName = await promptDialog({
          title: t('editor.contentBrowser.contextMenu.rename'),
          label: t('editor.contentBrowser.dialogs.renameAssetPrompt'),
          defaultValue: asset.name,
          confirmText: t('editor.contentBrowser.dialogs.ok'),
          cancelText: t('editor.contentBrowser.dialogs.cancel'),
        });
        if (newName && newName !== asset.name) {
          // D6: rename routes through the ONE gateway door (document op, undoable).
          // The applier reaches pack IO via ctx.assetIO and fires the in-process
          // assetsChanged notification; the Content Browser listener reloads.
          gateway.dispatch({ kind: 'renameAsset', packPath: asset.packPath, guid: asset.guid, newName, oldName: asset.name }, 'human');
        }
      })();
    },
    onNewFolder: (parentPath: string) => {
      void (async () => {
        const name = await promptDialog({
          title: t('editor.contentBrowser.actions.createFolder'),
          label: t('editor.contentBrowser.dialogs.newFolderPrompt'),
          confirmText: t('editor.contentBrowser.dialogs.createConfirm'),
          cancelText: t('editor.contentBrowser.dialogs.cancel'),
        });
        if (!name) return;
        gateway.dispatch({ kind: 'createDirectory', parentPath, name }, 'human');
      })();
    },
  }), [reload, requestDelete, t]);

  const createFolderInCurrentPath = useCallback(() => {
    void (async () => {
      const name = await promptDialog({
        title: t('editor.contentBrowser.actions.createFolder'),
        label: t('editor.contentBrowser.dialogs.newFolderPrompt'),
        confirmText: t('editor.contentBrowser.dialogs.createConfirm'),
        cancelText: t('editor.contentBrowser.dialogs.cancel'),
      });
      if (!name) return;
      gateway.dispatch({ kind: 'createDirectory', parentPath: nav.currentPath, name }, 'human');
    })();
  }, [nav.currentPath, t]);

  const createAssetInCurrentPath = useCallback((spec: CreatableAssetSpec) => {
    void (async () => {
      const basePath = resolveGamePath(nav.currentPath || 'assets');
      const name = (await promptDialog({
        title: t('editor.contentBrowser.actions.createAsset', { label: spec.label }),
        label: t('editor.contentBrowser.dialogs.newAssetNameLabel'),
        defaultValue: spec.defaultNamePrefix,
        confirmText: t('editor.contentBrowser.dialogs.createConfirm'),
        cancelText: t('editor.contentBrowser.dialogs.cancel'),
      }))?.trim();
      if (!name) return;
      gateway.dispatch({
        kind: 'createAsset',
        packPath: `${basePath}/${name}.pack.json`,
        guid: generateAssetGuid(),
        assetKind: spec.kind,
        name,
      }, 'human');
    })();
  }, [nav.currentPath, t]);

  const assetFavoritePath = useCallback((asset: CBAsset) => (
    relByAssetGuid.get(asset.guid) ?? catalogPathToRoot(asset.packPath, gameSlug, catalogAssetRoots) ?? asset.packPath
  ), [gameSlug, relByAssetGuid]);

  // Per-card favorite state + toggle, threaded through CBGrid so every card's
  // ⭐ toggles favorites directly (same path semantics as the context menu:
  // folders/files key on their game-relative path, assets on assetFavoritePath).
  // The header "favorites only" filter then narrows the content view to these.
  const isItemFavorite = useCallback((item: CBViewItem): boolean => (
    item.type === 'asset' ? favorites.isFavorite(assetFavoritePath(item)) : item.isFavorite
  ), [assetFavoritePath, favorites]);
  const toggleItemFavorite = useCallback((item: CBViewItem): void => {
    favorites.toggleFavorite(item.type === 'asset' ? assetFavoritePath(item) : item.path);
  }, [assetFavoritePath, favorites]);

  const commonItemMenu = useCallback((item: CBViewItem) => {
    if (item.type === 'folder') {
      const fullPath = resolveGamePath(item.path);
      return [
        { label: item.isFavorite ? t('editor.contentBrowser.contextMenu.unfavorite') : t('editor.contentBrowser.contextMenu.favorite'), icon: 'star', onClick: () => favorites.toggleFavorite(item.path) },
        { label: t('editor.contentBrowser.contextMenu.rename'), icon: 'pencil', shortcut: 'F2', onClick: () => {
          void (async () => {
            const newName = await promptDialog({
              title: t('editor.contentBrowser.contextMenu.rename'),
              label: t('editor.contentBrowser.dialogs.renameAssetPrompt'),
              defaultValue: item.name,
              confirmText: t('editor.contentBrowser.dialogs.ok'),
              cancelText: t('editor.contentBrowser.dialogs.cancel'),
            });
            if (newName && newName !== item.name) {
              gateway.dispatch({ kind: 'renameDirectory', path: item.path, newName }, 'human');
            }
          })();
        } },
        { label: t('editor.contentBrowser.contextMenu.copyPath'), icon: 'copy', onClick: () => copyText(fullPath) },
        { label: t('editor.contentBrowser.contextMenu.copyRelativePath'), icon: 'copy', onClick: () => copyText(item.path) },
        { label: t('editor.contentBrowser.contextMenu.showInFileManager'), icon: 'folder-search', onClick: () => {
          gateway.dispatch({ kind: 'revealInFileManager', path: resolveGamePath(item.path) }, 'human');
        } },
        { label: t('editor.contentBrowser.contextMenu.delete'), icon: 'trash-2', shortcut: 'Del', danger: true, onClick: () => {
          void (async () => {
            const ok = await confirmDialog({
              title: t('editor.contentBrowser.contextMenu.delete'),
              description: t('editor.contentBrowser.dialogs.deleteFolderConfirm', { name: item.name }),
              confirmText: t('editor.contentBrowser.deleteGuard.confirm'),
              cancelText: t('editor.contentBrowser.deleteGuard.cancel'),
              destructive: true,
            });
            if (!ok) return;
            gateway.dispatch({ kind: 'deleteDirectory', path: item.path }, 'human');
          })();
        } },
      ];
    }
    if (item.type === 'file') {
      return [
        { label: item.isFavorite ? t('editor.contentBrowser.contextMenu.unfavorite') : t('editor.contentBrowser.contextMenu.favorite'), icon: 'star', onClick: () => favorites.toggleFavorite(item.path) },
        { label: t('editor.contentBrowser.contextMenu.rename'), icon: 'pencil', shortcut: 'F2', onClick: () => {
          void (async () => {
            const newName = await promptDialog({
              title: t('editor.contentBrowser.contextMenu.rename'),
              label: t('editor.contentBrowser.dialogs.renameAssetPrompt'),
              defaultValue: item.name,
              confirmText: t('editor.contentBrowser.dialogs.ok'),
              cancelText: t('editor.contentBrowser.dialogs.cancel'),
            });
            if (newName && newName !== item.name) {
              gateway.dispatch({ kind: 'renameSourceFile', path: item.path, newName }, 'human');
            }
          })();
        } },
        { label: t('editor.contentBrowser.contextMenu.copyPath'), icon: 'copy', onClick: () => copyText(item.diskPath) },
        { label: t('editor.contentBrowser.contextMenu.copyRelativePath'), icon: 'copy', onClick: () => copyText(item.path) },
        { label: t('editor.contentBrowser.contextMenu.showInFileManager'), icon: 'folder-search', onClick: () => {
          gateway.dispatch({ kind: 'revealInFileManager', path: resolveGamePath(item.path) }, 'human');
        } },
        { label: t('editor.contentBrowser.contextMenu.addToChat'), icon: 'spark', forge: true, onClick: () => {
          void host.commands.execute('app.chat.insertPill', {
            pill: {
              kind: 'file',
              display: item.name,
              detail: `[File reference: \`${item.path}\`]`,
              tooltip: { title: `File · ${item.name}`, lines: [`path: ${item.path}`, `disk: ${item.diskPath}`] },
            },
          }).catch(() => {});
        } },
        { label: t('editor.contentBrowser.contextMenu.delete'), icon: 'trash-2', shortcut: 'Del', danger: true, onClick: () => {
          void (async () => {
            const ok = await confirmDialog({
              title: t('editor.contentBrowser.contextMenu.delete'),
              description: t('editor.contentBrowser.dialogs.deleteFileConfirm', { name: item.name }),
              confirmText: t('editor.contentBrowser.deleteGuard.confirm'),
              cancelText: t('editor.contentBrowser.deleteGuard.cancel'),
              destructive: true,
            });
            if (!ok) return;
            gateway.dispatch({
              kind: 'deleteSourceFile',
              path: item.path,
              requestId: crypto.randomUUID(),
            }, 'human');
          })();
        } },
      ];
    }
    const favPath = assetFavoritePath(item);
    const relPath = relByAssetGuid.get(item.guid) ?? catalogPathToRoot(item.packPath, gameSlug, catalogAssetRoots) ?? item.packPath;
    const fullPath = resolveCopyPath(relPath);
    return [
      { label: favorites.isFavorite(favPath) ? t('editor.contentBrowser.contextMenu.unfavorite') : t('editor.contentBrowser.contextMenu.favorite'), icon: 'star', onClick: () => favorites.toggleFavorite(favPath) },
      { label: t('editor.contentBrowser.contextMenu.rename'), icon: 'pencil', shortcut: 'F2', onClick: () => crudCallbacks.onRename?.(item) },
      { label: t('editor.contentBrowser.contextMenu.copyPath'), icon: 'copy', onClick: () => copyText(fullPath) },
      { label: t('editor.contentBrowser.contextMenu.copyRelativePath'), icon: 'copy', onClick: () => copyText(relPath) },
      { label: t('editor.contentBrowser.contextMenu.addToChat'), icon: 'spark', forge: true, onClick: () => requestAddAssetsToChat([{
        type: 'asset',
        guid: item.guid,
        kind: item.kind,
        name: item.name,
        path: item.packPath,
        payload: item.payload,
      }]) },
      { label: t('editor.contentBrowser.contextMenu.delete'), icon: 'trash-2', shortcut: 'Del', danger: true, onClick: () => requestDelete([item]) },
    ];
  }, [assetFavoritePath, crudCallbacks, favorites, fetchDiskDirs, gameSlug, host.commands, relByAssetGuid, reload, requestDelete, t]);

  const handleImport = useCallback(() => {
    const input = fileInputRef.current;
    logImport('ContentBrowser.import.click', {
      currentPath: nav.currentPath,
      accept: acceptString,
      hasFbx: acceptString.includes('.fbx'),
      acceptDom: input?.getAttribute('accept') ?? input?.accept ?? null,
    });
    input?.click();
  }, [acceptString, nav.currentPath]);

  const openFolderContextMenu = useCallback((pos: { clientX: number; clientY: number; preventDefault: () => void }, folder: CBFolder) => {
    const assetsInFolder = scopedAssets
      .filter(s => s.rel === folder.path || s.rel.startsWith(`${folder.path}/`))
      .map(s => s.asset);
    const menuItems = buildFolderContextMenu(folder, assetsInFolder, crudCallbacks);
    const resolved = resolveFolderMenuItems(menuItems, {
      onOpen: () => nav.navigate(folder.path),
      onToggleFavorite: () => favorites.toggleFavorite(folder.path),
      unsupportedIds: ['rename'],
    }).filter(item => !['toggle-fav', 'rename', 'copy-path', 'delete'].includes(item.id));
    if (resolved.length === 0) return;
    const items: CBContextMenuEntry[] = [
      { title: folder.name, icon: 'folder' },
      ...resolved.map(item => ({
        ...item,
        icon: item.icon ?? menuIconForId(item.id),
        forge: item.forge,
      })),
      { sep: true },
      ...commonItemMenu(folder),
    ];
    setTimeout(() => showContextMenu(pos, orderContextMenuEntries(items)), 0);
  }, [commonItemMenu, crudCallbacks, favorites, nav, scopedAssets]);

  const openFileContextMenu = useCallback((pos: { clientX: number; clientY: number; preventDefault: () => void }, file: CBFile) => {
    const firstAsset = file.assets[0];
    const items: CBContextMenuEntry[] = [
      { title: file.name, icon: iconNameForFileFamily(file.family) },
      ...fileSpecificMenuItems(t, file).map(item => ({
        ...item,
        onClick: item.id === 'expand-sub-assets'
          ? () => togglePackExpansion(file.path)
          : item.id === 'render-preview' || item.id === 'audition'
          ? () => setPreviewItem(file)
          : item.id === 'copy-guid' && firstAsset
            ? () => { void navigator.clipboard.writeText(file.assets.map(asset => asset.guid).join('\n')); }
            : undefined,
        disabled: item.disabled || (item.id === 'copy-guid' && !firstAsset),
      })),
      { sep: true },
      ...commonItemMenu(file),
      { sep: true },
    ];
    if (firstAsset) {
      const assetItems = buildAssetContextMenu(firstAsset, multiSelect.selection, allAssets, crudCallbacks)
        .filter(item => !['rename', 'duplicate', 'delete', 'add-to-chat'].includes(item.id))
        .map((item): CBContextMenuEntry => item.separator
          ? { sep: true }
          : {
              label: item.label,
              icon: menuIconForId(item.id),
              shortcut: item.shortcut,
              forge: item.forge,
              danger: item.danger,
              onClick: item.action,
              disabled: item.disabled,
            });
      items.push(...assetItems);
      items.push({ sep: true });
    }
    // Gate on the actual scene asset (kind === 'scene'), matching openAsset's
    // switch condition — not on family alone or assets[0], which may be a
    // non-scene entry in a multi-asset pack.
    const sceneAsset = file.assets.find(asset => asset.kind === 'scene');
    if (sceneAsset) {
      items.splice(1, 0, { label: t('editor.contentBrowser.contextMenu.setCurrentScene'), icon: 'flag', onClick: () => openAsset(sceneAsset) });
    }
    setTimeout(() => showContextMenu(pos, orderContextMenuEntries(items)), 0);
  }, [allAssets, commonItemMenu, crudCallbacks, multiSelect.selection, openAsset, togglePackExpansion, t]);

  const handleFileSelected = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) {
      logImport('ContentBrowser.import.cancel', { reason: 'no files selected' });
      return;
    }

    logImport('ContentBrowser.import.selected', {
      count: files.length,
      names: Array.from(files).map(f => f.name),
      currentPath: nav.currentPath,
    });

    setImportProgress({ total: files.length, completed: 0, current: '', results: [] });
    const results = await importFiles(
      Array.from(files),
      nav.currentPath,
      (progress) => setImportProgress(progress),
      reload,
    );

    logImport('ContentBrowser.import.done', {
      results: results.map(r => ({ filename: r.filename, status: r.status, error: r.error })),
    });

    const errors = results.filter(r => r.status === 'error');
    if (errors.length > 0) {
      console.warn('[ContentBrowser] import errors:', errors.map(e => `${e.filename}: ${e.error}`));
    }

    setTimeout(() => setImportProgress(null), 3000);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [nav.currentPath, reload]);

  const clearKindFilters = useCallback(() => {
    filter.filters.filter(f => f.active).forEach(f => filter.toggleFilter(f.id));
  }, [filter]);

  useContentBrowserCommands({
    host,
    t,
    loading,
    viewMode,
    filter,
    sort,
    nav,
    favoritesOnly,
    thumbnailSize,
    reload,
    createFolderInCurrentPath,
    createAssetInCurrentPath,
    handleImport,
    clearKindFilters,
    setFavoritesOnly,
    setThumbnailSize,
  });

  const handleContextMenu = useCallback((e: React.MouseEvent, item: CBViewItem) => {
    e.preventDefault();
    e.stopPropagation();
    selectItemForContextMenu(item, e);
    const pos = { clientX: e.clientX, clientY: e.clientY, preventDefault: () => {} };
    if (item.type === 'folder') {
      openFolderContextMenu(pos, item);
      return;
    }
    if (item.type === 'file') {
      openFileContextMenu(pos, item);
      return;
    }
    const asset = item;
    const selectedItems = multiSelect.selection.items;
    const contextSelection: CBSelection = selectedItems.some(selected => viewItemKey(selected) === viewItemKey(asset))
      ? multiSelect.selection
      : { items: [asset], primary: asset };
    const menuItems = buildAssetContextMenu(asset, contextSelection, allAssets, crudCallbacks);
    const resolved = menuItems.filter(m => !m.separator && !['rename', 'copy-path', 'delete', 'add-to-chat'].includes(m.id)).map(m => ({
      label: m.label,
      icon: m.icon ?? menuIconForId(m.id),
      shortcut: m.shortcut,
      forge: m.forge,
      danger: m.danger,
      onClick: m.action,
      disabled: m.disabled,
    }));
    setTimeout(() => showContextMenu(pos, orderContextMenuEntries([
      { title: asset.name, icon: iconNameForAssetKind(asset.kind) },
      ...commonItemMenu(asset),
      { sep: true },
      ...resolved,
    ])), 0);
  }, [multiSelect.selection, allAssets, commonItemMenu, crudCallbacks, openFileContextMenu, openFolderContextMenu, selectItemForContextMenu]);

  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      multiSelect.clearSelection();
    }
  }, [multiSelect]);

  const handleBlankContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const pos = { clientX: e.clientX, clientY: e.clientY, preventDefault: () => {} };
    const menuItems = buildBlankAreaContextMenu(nav.currentPath, (parentPath) => {
      void (async () => {
        const name = await promptDialog({
          title: t('editor.contentBrowser.actions.createFolder'),
          label: t('editor.contentBrowser.dialogs.newFolderPrompt'),
          confirmText: t('editor.contentBrowser.dialogs.createConfirm'),
          cancelText: t('editor.contentBrowser.dialogs.cancel'),
        });
        if (!name) return;
        gateway.dispatch({ kind: 'createDirectory', parentPath, name }, 'human');
      })();
    });
    const resolved = menuItems.map(m => ({
      label: m.label,
      icon: m.icon ?? menuIconForId(m.id),
      shortcut: m.shortcut,
      forge: m.forge,
      danger: m.danger,
      onClick: m.action,
      disabled: m.disabled,
    }));
    setTimeout(() => showContextMenu(pos, resolved), 0);
  }, [nav.currentPath, t]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setThumbnailSize(prev => Math.max(48, Math.min(200, prev - Math.sign(e.deltaY) * 8)));
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const all = Array.from(e.dataTransfer.files);
    const files = all.filter(f => isImportable(f.name));
    logImport('ContentBrowser.drop', {
      allNames: all.map(f => f.name),
      importableNames: files.map(f => f.name),
      currentPath: nav.currentPath,
    });
    if (files.length === 0 || !gameSlug || gameSlug === 'default') return;
    void importFiles(
      files,
      nav.currentPath,
      (p) => setImportProgress(p),
      reload,
    ).then(() => {
      setTimeout(() => setImportProgress(null), 3000);
    });
  }, [gameSlug, nav.currentPath, reload]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragOver(false);
  }, []);

  const noGame = !gameSlug || gameSlug === 'default';

  return (
    <div
      className={`cb-root${dragOver ? ' cb-drag-over' : ''}`}
      onWheel={handleWheel}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      <input
        ref={fileInputRef}
        data-cb-file-input="1"
        type="file"
        multiple
        accept={acceptString}
        style={{ display: 'none' }}
        onChange={e => void handleFileSelected(e)}
      />
      {noGame ? (
        <div style={{ padding: 16, opacity: 0.6, textAlign: 'center', marginTop: 32 }}>
          {t('editor.contentBrowser.empty.noGame')}
        </div>
      ) : (
        <div className="cb-split" ref={splitRef} style={{ ['--cb-src-w' as string]: `${srcWidth}px`, ['--cb-preview-w' as string]: `${previewWidth}px` }}>
          {/* Left: Source panel — width reads the --cb-src-w CSS variable on the
              parent (set by React on commit, by the drag handle imperatively). */}
          <CBSourceTree
            sourceTree={sourceTree}
            gameSlug={gameSlug}
            scopedAssetsCount={scopedAssets.length}
            collapsedSourceFolders={collapsedSourceFolders}
            setCollapsedSourceFolders={setCollapsedSourceFolders}
            previewItem={previewItem}
            setPreviewItem={setPreviewItem}
            nav={nav}
            openFolderContextMenu={openFolderContextMenu}
            openFileContextMenu={openFileContextMenu}
          />

          {/* Draggable divider (UE-parity): widen the tree to read long paths. */}
          <ResizeHandle orientation="col" onDrag={onSplitDrag} onDragEnd={onSplitDragEnd}
            title={t('editor.contentBrowser.actions.resizeFolderTree')} />

          {/* Right: Asset view */}
          <div className="cb-asset-view" onClick={handleContainerClick} onContextMenu={handleBlankContextMenu}>
            <CBNavigationBar nav={nav} gameSlug={gameSlug} />
            {loading ? (
              <div style={{ padding: 16, opacity: 0.5 }}>{t('editor.contentBrowser.empty.loading')}</div>
            ) : viewItems.length === 0 ? (
              <div style={{ padding: 16, opacity: 0.5 }}>
                {filter.activeFilterCount > 0 || filter.searchQuery ? t('editor.contentBrowser.empty.noMatching') : t('editor.contentBrowser.empty.noAssets')}
              </div>
            ) : (
              <CBGrid
                items={viewItems}
                thumbnailSize={thumbnailSize}
                multiSelect={multiSelect}
                selectedPath={previewItem ? viewItemKey(previewItem) : null}
                viewMode={viewMode}
                expandedPacks={expandedPacks}
                onTogglePackExpansion={togglePackExpansion}
                onSelect={setPreviewItem}
                onDoubleClick={handleActivate}
                onContextMenu={handleContextMenu}
                isItemFavorite={isItemFavorite}
                onToggleFavorite={toggleItemFavorite}
              />
            )}
          </div>
          {previewItem && (
            <CBPreviewPanel
              previewItem={previewItem}
              foldersInPath={foldersInPath}
              diskFiles={diskFiles}
              gameSlug={gameSlug}
              onClose={() => setPreviewItem(null)}
              onDrag={onPreviewDrag}
              onDragEnd={onPreviewDragEnd}
            />
          )}
        </div>
      )}

      {importProgress && (
        <div className="cb-import-progress">
          <span className="cb-import-progress-text">
            {importProgress.completed < importProgress.total
              ? t('editor.contentBrowser.importProgress.running', {
                  current: importProgress.completed + 1,
                  total: importProgress.total,
                  name: importProgress.current,
                })
              : t('editor.contentBrowser.importProgress.complete', {
                  done: importProgress.results.filter(r => r.status === 'done').length,
                  total: importProgress.total,
                })}
          </span>
          <div className="cb-import-progress-bar">
            <div
              className="cb-import-progress-fill"
              style={{ width: `${(importProgress.completed / importProgress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {dragOver && (
        <div className="cb-drag-overlay">
          <div className="cb-drag-overlay-label">{t('editor.contentBrowser.empty.dropFiles')}</div>
        </div>
      )}

      {deleteTargets && createPortal(
        <DeleteGuardDialog
          targets={deleteTargets}
          impact={computeDeleteImpact(deleteTargets.map(t => t.guid), assetGraph)}
          nameByGuid={nameByGuid}
          onConfirm={performDelete}
          onCancel={() => setDeleteTargets(null)}
        />,
        document.body,
      )}
    </div>
  );
}
