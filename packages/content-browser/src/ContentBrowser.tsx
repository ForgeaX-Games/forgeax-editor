import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useHost } from '@forgeax/interface/core/app-shell';
import type { ContentBrowserRevealTarget } from '@forgeax/interface/core/app-shell/types';
import { isPageDirty } from '@forgeax/interface/core/page-platform';
import { publish } from '@forgeax/interface/lib/bus';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { Download, FolderPlus, Plus, Save } from 'lucide-react';
// Asset-selection is a transient op dispatched through the one gateway door
// (gateway.dispatch({ kind: 'setAssetSelection', … })), never the direct setter.
import { cancelViewportRuntimeOperationRun, describeSceneActivation, dispatchActiveEditorOperation, generateAssetGuid, gateway, getSelection, getViewportRuntimeClientSnapshot, requestAddAssetsToChat, resolveGamePath, showContextMenu, subscribeViewportRuntimeClient, waitViewportRuntimeOperationRun,
  ResizeHandle, useLocalSize, useSceneReadModel, validateAssetBasename } from '@forgeax/editor-core';
import type { OperationRun } from '@forgeax/editor-core';
// Editor-ui overlay services replace window.prompt/confirm — a themed modal
// (Dialog / AlertDialog) mounted once at the app root via EditorOverlayProvider
// (standalone main.tsx / studio editorRenderers.tsx). Both are async.
// NOTE: folder/file delete no longer uses the editor-ui `confirm` AlertDialog —
// in the standalone host that dialog (isolated overlay React root) never paints,
// hanging the delete. Folder/file deletes now route through the in-package
// cb-dialog path-confirm modal (same reliable styling as the asset DeleteGuard),
// so keyboard + context-menu delete are consistent across studio & standalone.
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@forgeax/editor-ui';
import { useMultiSelect } from './hooks/useMultiSelect';
import { useSort } from './hooks/useSort';
import { useFilter } from './hooks/useFilter';
import { useNavHistory } from './hooks/useNavHistory';
import { useFavorites, type CBFavoriteRef } from './hooks/useFavorites';
import { useCBData } from './hooks/useCBData';
import { useCBDerivedView } from './hooks/useCBDerivedView';
import { useContentBrowserCommands } from './hooks/useContentBrowserCommands';
import { computeDeleteImpact, computeDeleteOpenResources, computeSceneDeleteGuards } from './delete-guard';
import { publishDeleteGuardWorkspace } from './delete-guard-bus';
import { authorizeSubjectAction, preflightSubjectAction, type SubjectActionRequest } from './workspace/subject-actions';
import { DeleteGuardDialog } from './DeleteGuardDialog';
import { SaveAssetsDialog } from './SaveAssetsDialog';
import { subscribeSaveAllRequest, resolveSaveAll } from './save-all-bus';
import { buildAssetContextMenu, buildBlankAreaContextMenu, buildFolderContextMenu, dispatchReimportAsset, type CRUDCallbacks } from './CBContextMenu';
import { resolveFolderMenuItems } from './folder-menu';
import { CBNavigationBar } from './CBNavigationBar';
import { CBFilterBar } from './CBFilterBar';
import { CBGrid } from './CBGrid';
import { CBPreviewPanel } from './CBPreviewPanel';
import { CBSourceTree } from './CBSourceTree';
import { CONTENT_BROWSER_INTERACTION_SCOPE, contentBrowserInteractionAttrs, contentBrowserPrompt } from './interaction-surface';
import { ContentBrowserIcon, iconNameForAssetKind, iconNameForFileFamily, labelForAssetKind } from './content-browser-icons';
import { importFiles, isRetryableImportRun, retryImportRun, type ImportProgress, type ImportRunRecord } from './import-pipeline';
import { isImportable, buildAcceptString, logImport } from './import-registry';
import { CREATABLE_ASSET_KINDS, type CreatableAssetSpec } from './creatable-asset-kinds';
import { createMaterialInstanceAndOpen } from './create-material-instance';
import { createInputMapAndOpen } from './create-input-map';
import { catalogPathToRoot, type CatalogAssetRoot } from './catalog-root';
import { resolveFileActivateAction } from './folder-view';
import { pickNativeImportFiles } from './native-file-picker';
import { SourceMutationDialog } from './source-authoring/SourceMutationDialog';
import {
  createSourceMutationViewModel,
  findRetryableSourceMutationRun,
  findSourceMutationPreflightRun,
  findSourceMutationRun,
  resolveSourceMutationExpectedRevision,
  resolveSourceMutationLifecycle,
  sourceMutationOperationFromRun,
  sourceMutationPreflightFromRun,
  type SourceMutationAction,
} from './source-authoring/source-mutation-view-model';
import { sceneActivationToOp, scenePromoteToOp } from './scene-activation-route';
import type { CBAsset, CBFile, CBFolder, CBSelection, CBViewItem } from './types';
import {
  viewItemKey,
  copyText,
  resolveCopyPath,
  orderContextMenuEntries,
  menuIconForId,
  fileSpecificMenuItems,
  dirOfPath,
  importDirectoryForViewItem,
  sourcePathForViewItem,
  type CBContextMenuEntry,
} from './content-browser-format';
import './content-browser.css';

// M3: single-realm — registry.listCatalog() replaces loadGameAssets/loadMetaAssets
// (plan-strategy S2 D1, S3.1 component map, requirements AC-03).
// The engine AssetRegistry is the SSOT for asset enumeration; the ContentBrowser
// reads directly from it via gateway.doc.registry.listCatalog().
// registry entries carry {guid, kind, name?, packageUrl, refs?} — no
// payload/packPath, so import-mode filtering and payload-derived fields are
// removed. `refs` (forward dependency GUID edges) is surfaced by the engine
// AssetRegistry.listCatalog() (engine refs-through-listCatalog); it powers the
// Content Browser's "Add with Dependencies" and dependency-graph features.

// Vite injects package-declared roots from the same resolution call it passes to
// pluginPack, so the browser receives a projection instead of re-resolving disk
// layout conventions itself.
declare const __FORGEAX_CATALOG_ASSET_ROOTS__: readonly CatalogAssetRoot[];
declare const __FORGEAX_GAME_SLUG__: string | null;
declare const __FORGEAX_GAME_DIR_ABS__: string | null;

const compileCatalogAssetRoots: readonly CatalogAssetRoot[] =
  typeof __FORGEAX_CATALOG_ASSET_ROOTS__ === 'undefined'
    ? []
    : __FORGEAX_CATALOG_ASSET_ROOTS__;

/**
 * Studio has no fixed game at bundle time. The active Play binding therefore
 * supplies the declared-root -> catalog-prefix projection at runtime; the
 * compile-time value remains the standalone host fallback.
 */
function useCatalogAssetRoots(): readonly CatalogAssetRoot[] {
  const runtimeCatalogRoots = useSyncExternalStore(
    subscribeViewportRuntimeClient,
    () => getViewportRuntimeClientSnapshot().catalogRoots,
    () => null,
  );
  return runtimeCatalogRoots ?? compileCatalogAssetRoots;
}

function ContentBrowserActionBar({
  executeCommand,
  nav,
  gameSlug,
  allDirs,
}: {
  executeCommand: (command: string) => void;
  nav: ReturnType<typeof useNavHistory>;
  gameSlug: string;
  allDirs: string[];
}): ReactNode {
  const { t } = useTranslation();
  const [createMenuOpen, setCreateMenuOpen] = useState(false);

  return (
    <div className="cb-toolbar" data-testid="cb-content-actions" role="toolbar">
      <div className="cb-toolbar-group">
        <DropdownMenu modal={false} open={createMenuOpen} onOpenChange={setCreateMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="subtle"><Plus />{t('editor.contentBrowser.actions.create')}</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" interactionScope={CONTENT_BROWSER_INTERACTION_SCOPE}>
            <DropdownMenuItem size="sm" onClick={() => executeCommand('contentBrowser.createFolder')}>
              <FolderPlus />
              {t('editor.contentBrowser.actions.createFolder')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {CREATABLE_ASSET_KINDS.map(spec => (
              <DropdownMenuItem
                key={spec.kind}
                size="sm"
                onClick={() => executeCommand(`contentBrowser.createAsset.${spec.kind}`)}
              >
                <ContentBrowserIcon name={spec.icon} />
                {labelForAssetKind(spec.kind, t)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" variant="subtle" onClick={() => executeCommand('contentBrowser.import')}>
          <Download />
          {t('editor.contentBrowser.actions.import')}
        </Button>
        <Button size="sm" variant="subtle" onClick={() => executeCommand('contentBrowser.saveAll')}>
          <Save />
          {t('editor.contentBrowser.actions.saveAll')}
        </Button>
      </div>
      <CBNavigationBar nav={nav} gameSlug={gameSlug} allDirs={allDirs} inline />
    </div>
  );
}

/** Assets are identified by guid (a pack file holds N of them); folders and
 *  files are identified by their game-relative path. */
const favoriteRef = (item: CBViewItem): CBFavoriteRef => (
  item.type === 'asset' ? { kind: 'asset', guid: item.guid } : { kind: 'path', path: item.path }
);

function useProjectName(gameSlug: string): string {
  const [projectName, setProjectName] = useState(gameSlug);

  useEffect(() => {
    let cancelled = false;
    setProjectName(gameSlug);
    if (!gameSlug || gameSlug === 'default') return () => { cancelled = true; };

    let manifestPath: string;
    try {
      manifestPath = resolveGamePath('forge.json');
    } catch {
      return () => { cancelled = true; };
    }

    void fetch(`/api/files/raw?path=${encodeURIComponent(manifestPath)}`, { cache: 'no-store' })
      .then(response => response.ok ? response.json() : null)
      .then((manifest: unknown) => {
        if (cancelled || manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return;
        const name = (manifest as { name?: unknown }).name;
        if (typeof name === 'string' && name.trim()) setProjectName(name.trim());
      })
      .catch(() => { /* slug fallback is the stable project label */ });

    return () => { cancelled = true; };
  }, [gameSlug]);

  return projectName;
}

// Asset invalidation is owned by useAssetBrowserSnapshot via assetsChanged; this
// component only consumes the resulting read model through useCBData.

export interface ContentBrowserOperationRuns {
  readonly getSnapshot: () => { readonly revision: number; readonly runs: readonly OperationRun[] };
  readonly subscribe?: (listener: () => void) => () => void;
  readonly retry?: (runId: string, requestId?: string) => void;
}

export interface ContentBrowserProps {
  readonly operationRuns?: ContentBrowserOperationRuns;
}

const localOperationRuns: ContentBrowserOperationRuns = {
  getSnapshot: () => gateway.operationRunSnapshot(),
  subscribe: (listener) => gateway.subscribeOperationRuns(() => listener()),
  retry: (runId, requestId) => { gateway.retryOperationRun(requestId ?? runId, crypto.randomUUID(), 'human'); },
};

export function ContentBrowser({ operationRuns }: ContentBrowserProps = {}) {
  const host = useHost();
  const { t } = useTranslation();
  const executeContentBrowserCommand = useCallback((command: string) => {
    void host.commands.execute(command).catch((err: unknown) => {
      console.error(`[content-browser] command "${command}" failed`, err);
    });
  }, [host]);
  // Host boot configures the game session asynchronously after the shell mounts.
  // Subscribe to the existing scene-list signal so the read model is rebuilt
  // from the real slug instead of remaining on the initial `default` guard.
  const sceneModel = useSceneReadModel();
  const operationRunSource = operationRuns ?? localOperationRuns;
  const operationRunSnapshot = useSyncExternalStore(
    (listener) => operationRunSource.subscribe?.(listener) ?? (() => {}),
    () => operationRunSource.getSnapshot(),
    () => operationRunSource.getSnapshot(),
  );
  // The standalone host already has the authoritative slug at compile time;
  // use it during the async host-session gap, then let the scene-list signal
  // take over for scene switches and embedded hosts.
  const gameSlug = sceneModel.gameId === null && typeof __FORGEAX_GAME_SLUG__ === 'string'
    ? __FORGEAX_GAME_SLUG__
    : (sceneModel.gameId ?? 'default');
  const catalogAssetRoots = useCatalogAssetRoots();
  const projectName = useProjectName(gameSlug);
  const projectPickerPath = useMemo(() => {
    if (typeof __FORGEAX_GAME_DIR_ABS__ === 'string' && __FORGEAX_GAME_DIR_ABS__) {
      return __FORGEAX_GAME_DIR_ABS__;
    }
    try {
      return resolveGamePath('');
    } catch {
      return '';
    }
  }, [gameSlug]);
  const { allAssets: catalogAssets, loading, reload, catalogStale, diskTree, fetchDiskDirs, workspaceSnapshot } = useCBData(gameSlug, catalogAssetRoots);
  useEffect(() => publishDeleteGuardWorkspace(workspaceSnapshot), [workspaceSnapshot]);
  const allAssets = useMemo(() => catalogAssets.map((asset) => {
    const activation = describeSceneActivation({
      guid: asset.guid,
      kind: asset.kind,
      packageUrl: asset.packPath,
      sourcePath: asset.sourcePath,
      sourceKey: asset.sourceKey,
      metaPath: asset.metaPath,
      revision: asset.revision,
      authoring: asset.authoring,
    }, sceneModel.scenes, workspaceSnapshot.revision);
    return activation === null ? asset : { ...asset, activation };
  }), [catalogAssets, sceneModel.scenes, workspaceSnapshot.revision]);
  const [thumbnailSize, setThumbnailSize] = useState(80);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const currentImportRun = importProgress?.currentRun;
  const currentImportIsActive = currentImportRun?.status === 'accepted' || currentImportRun?.status === 'running';
  const currentImportCanCancel = currentImportIsActive === true
    && currentImportRun.cancellable
    && currentImportRun.progress.stage === 'cooking'
    && currentImportRun.progress.fraction < 1;
  const retryableImportRuns = importProgress?.runs.filter((record) => isRetryableImportRun(record.run)) ?? [];
  const [dragOver, setDragOver] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [collapsedSourceFolders, setCollapsedSourceFolders] = useState<Record<string, boolean>>({});
  const [selectedItem, setSelectedItem] = useState<CBViewItem | null>(null);
  const [previewItem, setPreviewItem] = useState<CBViewItem | null>(null);
  // Focus targets are event-time facts, not render state. Keep them in refs so
  // F2/Delete pressed immediately after focus cannot race a React effect and
  // execute against the previously focused card/tree row.
  const focusedSourceTreeItemRef = useRef<CBViewItem | null>(null);
  const focusedGridItemRef = useRef<CBViewItem | null>(null);
  const focusSourceTreeItem = useCallback((item: CBViewItem | null) => {
    focusedSourceTreeItemRef.current = item;
  }, []);
  const focusGridItem = useCallback((item: CBViewItem) => {
    focusedGridItemRef.current = item;
  }, []);
  const getFocusedSourceTreeItem = useCallback(() => focusedSourceTreeItemRef.current, []);
  const getFocusedGridItem = useCallback(() => focusedGridItemRef.current, []);
  const [sourceMutationAsset, setSourceMutationAsset] = useState<CBAsset | null>(null);
  useEffect(() => {
    if (sourceMutationAsset?.sourceKey === undefined) return;
    void dispatchActiveEditorOperation({
      kind: 'asset.preflight',
      guid: sourceMutationAsset.guid,
      scope: { sourceKey: sourceMutationAsset.sourceKey },
      requestId: crypto.randomUUID(),
    }, 'human').then((result) => {
      if (!result.ok) console.warn('[content-browser] source preflight rejected', result.error);
    });
  }, [sourceMutationAsset]);
  // Selection/preview for files & folders is anchored on the disk PATH
  // (viewItemKey), which is exactly what a rename mutates — so after the catalog
  // rebuilds, the old key matches nothing and the highlight drops. A rename queues
  // its {oldPath → newPath} here; the reconcile effect re-binds the preview to the
  // new path so a selected file/folder stays selected across the rename (assets are
  // guid-keyed and survive on their own).
  const pendingReselectRef = useRef<{ oldPath: string; newPath: string; newName: string } | null>(null);
  const [expandedPacks, setExpandedPacks] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const acceptString = useMemo(() => buildAcceptString(), []);
  const nav = useNavHistory();
  // Fresh read of the current folder for the (memoised) rename handlers: renaming
  // the folder you're inside (or an ancestor) must carry the nav path onto the new
  // path, else the breadcrumb keeps pointing at the dead old path and the grid
  // filters to nothing.
  const navPathRef = useRef(nav.currentPath);
  useEffect(() => { navPathRef.current = nav.currentPath; }, [nav.currentPath]);
  // Filter menu offers a FIXED set of spec-defined file families (`FE_FILTERABLE`)
  // — a static type filter, independent of the current folder's contents.
  const filter = useFilter();
  const sort = useSort();
  const favorites = useFavorites(gameSlug);
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
    allDirs,
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

  // Selection has two deliberate projections:
  //   1. selectedItem is the exact directory/file/asset subject;
  //   2. selectedSourcePath is the source-tree path chain used to paint every
  //      ancestor from the project root to that subject.
  // Keep previewItem separate so closing the preview does not erase selection.
  const selectedSourcePath = useMemo(() => {
    if (!selectedItem) return null;
    return sourcePathForViewItem(
      selectedItem,
      selectedItem.type === 'asset' ? relByAssetGuid.get(selectedItem.guid) : null,
    );
  }, [relByAssetGuid, selectedItem]);
  const selectedImportPath = useMemo(
    () => selectedItem
      ? importDirectoryForViewItem(selectedItem, selectedSourcePath, nav.currentPath || 'assets')
      : nav.currentPath,
    [nav.currentPath, selectedItem, selectedSourcePath],
  );

  const togglePackExpansion = useCallback((filePath: string) => {
    setExpandedPacks(prev => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath); else next.add(filePath);
      return next;
    });
  }, []);

  const multiSelect = useMultiSelect(viewItems);
  const selectItem = useCallback((item: CBViewItem) => {
    setSelectedItem(item);
    setPreviewItem(item);
  }, []);
  const selectItemForContextMenu = useCallback((item: CBViewItem, e: React.MouseEvent) => {
    selectItem(item);
    if (multiSelect.isSelected(item)) return;
    const index = viewItems.findIndex(viewItem => viewItemKey(viewItem) === viewItemKey(item));
    if (index >= 0) multiSelect.handleClick(index, e);
  }, [multiSelect, selectItem, viewItems]);

  // ── Locate-in-Content-Browser (`content-browser:reveal` bus event) ──────────
  // Any caller (an editor page tab, chat, another app) emits the neutral
  // interface bus event with a target identity; NOBODY imports this package. The
  // handler here OWNS the locate logic but writes ONLY through the gateway door
  // (setCBPath + setFolderSelection / setAssetSelectionOne) — same SSOT path a
  // human click uses, so the data flow is never bypassed. The pending scroll is a
  // pure view side-effect (reads the DOM after the grid rebuilds for the new path).
  const revealScrollRef = useRef<string | null>(null);
  const handleReveal = useCallback((target: ContentBrowserRevealTarget) => {
    reload(); // refresh the catalog so a freshly-authored target is present
    let dir = '';
    let selector: string | null = null;
    if (target.path) {
      const kind = target.pathKind ?? 'file';
      dir = dirOfPath(target.path);
      void dispatchActiveEditorOperation({ kind: 'setFolderSelection', items: [{ path: target.path, kind }] });
      selector = kind === 'dir'
        ? `[data-folder-path="${CSS.escape(target.path)}"]`
        : `[data-file-path="${CSS.escape(target.path)}"]`;
    } else if (target.guid) {
      const rel = relByAssetGuid.get(target.guid)
        ?? (target.packPath ? catalogPathToRoot(target.packPath, gameSlug, catalogAssetRoots) : null);
      if (rel) dir = dirOfPath(rel);
      void dispatchActiveEditorOperation({ kind: 'setAssetSelectionOne', asset: {
        guid: target.guid,
        kind: target.assetKind ?? 'unknown',
        name: target.name ?? target.guid,
        payload: {},
        packPath: target.packPath ?? '',
      } });
      selector = `[data-asset-guid="${CSS.escape(target.guid)}"]`;
    } else {
      return;
    }
    gateway.dispatch({ kind: 'setCBPath', path: dir });
    revealScrollRef.current = selector;
  }, [reload, relByAssetGuid, gameSlug, catalogAssetRoots]);

  useEffect(() => host.bus.on('content-browser:reveal', ({ target }) => handleReveal(target)), [host, handleReveal]);

  // After the grid rebuilds for the revealed path, scroll the target card into
  // view and flash it. A few rAF retries cover the async folder/disk fetch beat.
  useEffect(() => {
    const selector = revealScrollRef.current;
    if (!selector) return;
    let tries = 0;
    let raf = 0;
    const attempt = () => {
      const el = document.querySelector(selector);
      if (el) {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        el.classList.add('cb-reveal-flash');
        window.setTimeout(() => el.classList.remove('cb-reveal-flash'), 1200);
        revealScrollRef.current = null;
        return;
      }
      if (tries++ > 8) { revealScrollRef.current = null; return; }
      raf = requestAnimationFrame(attempt);
    };
    raf = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(raf);
  }, [viewItems]);

  // Keep the preview/selection bound to its item across catalog refreshes. If the
  // item is still present under the same key (assets are guid-keyed → survive a
  // rename), just refresh the reference so the shown name tracks any edit. If it
  // vanished because a rename changed its path, re-bind to the queued new path so
  // renaming a selected file/folder keeps it selected instead of clearing it.
  useEffect(() => {
    if (!previewItem) return;
    const key = viewItemKey(previewItem);
    const sameKey = viewItems.find(it => viewItemKey(it) === key);
    if (sameKey) {
      // Value-compare (not reference): viewItems is rebuilt with fresh object
      // refs every render, so `sameKey !== previewItem` is ALWAYS true and would
      // setState on every pass → infinite loop. Only refresh when the shown name
      // actually changed (e.g. an asset rename — guid-keyed so it stays here).
      if (sameKey.name !== previewItem.name) setPreviewItem(sameKey);
      return;
    }
    // The previewed item's key vanished. If a rename of THIS item is pending,
    // re-bind to the new path so the selection follows. Prefer the freshly-built
    // grid item; fall back to rewriting the old snapshot (covers source-tree files
    // that live outside the scoped grid view). Assets are guid-keyed → never here.
    const pending = pendingReselectRef.current;
    if (!pending || pending.oldPath !== key || previewItem.type === 'asset') return;
    pendingReselectRef.current = null;
    const moved = viewItems.find(it => it.type !== 'asset' && it.path === pending.newPath);
    if (moved) {
      setPreviewItem(moved);
    } else if (previewItem.type === 'file') {
      const slash = previewItem.diskPath.lastIndexOf('/');
      const newDiskPath = slash >= 0 ? previewItem.diskPath.slice(0, slash + 1) + pending.newName : pending.newName;
      setPreviewItem({ ...previewItem, path: pending.newPath, name: pending.newName, diskPath: newDiskPath });
    } else {
      setPreviewItem({ ...previewItem, path: pending.newPath, name: pending.newName });
    }
    // Re-bind the grid highlight too: folder/file selection lives in the
    // path-keyed folder-selection store, so the renamed item's OLD path no longer
    // matches and the card would drop its highlight. Mirror the preview re-bind
    // for BOTH kinds (previously only folders were re-bound, so renaming a
    // selected FILE silently lost its selection). Assets are guid-keyed and
    // already returned above.
    void dispatchActiveEditorOperation({
      kind: 'setFolderSelection',
      items: [{ path: pending.newPath, kind: previewItem.type === 'folder' ? 'dir' : 'file' }],
    });
  }, [viewItems, previewItem]);

  const nameByGuid = useCallback(
    (guid: string) => allAssets.find(a => a.guid === guid)?.name ?? `${guid.slice(0, 8)}…`,
    [allAssets],
  );

  const [deleteTargets, setDeleteTargets] = useState<CBAsset[] | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const sceneDeleteGuards = useMemo(
    () => computeSceneDeleteGuards(deleteTargets ?? [], sceneModel, workspaceSnapshot),
    [deleteTargets, sceneModel, workspaceSnapshot],
  );
  const deleteOpenResources = useMemo(
    () => computeDeleteOpenResources(
      (deleteTargets ?? []).map((target) => target.guid),
      host.pages.getSnapshot().instances,
      isPageDirty,
    ),
    [deleteTargets, host.pages],
  );
  const [pendingSceneSwitch, setPendingSceneSwitch] = useState<string | null>(null);
  // UE-style "Save Content" dialog: opened by save-all-bus requests (CBToolbar
  // Save button / contentBrowser.saveAll command); resolved by the dialog.
  const [saveAllOpen, setSaveAllOpen] = useState(false);
  useEffect(() => {
    return subscribeSaveAllRequest((req) => {
      if (req === null) setSaveAllOpen(false);
      else setSaveAllOpen(true);
    });
  }, []);
  const requestDelete = useCallback((targets: CBAsset[]) => {
    if (targets.length === 0) return;
    setDeleteError(null);
    setDeleteTargets(targets);
  }, []);
  const performDelete = useCallback(() => {
    const current = deleteTargets;
    if (!current) return;
    void (async () => {
      const gates = current.map((asset) => preflightSubjectAction({
        operation: 'delete',
        asset,
        snapshot: workspaceSnapshot,
      }));
      const rejected = gates.find((gate) => !gate.preflight.ok);
      if (rejected) {
        setDeleteError(rejected.preflight.error?.hint ?? 'Delete preflight was rejected; refresh the asset browser and try again.');
        return;
      }
      if (gates.some((gate) => !authorizeSubjectAction(gate).ok)) {
        setDeleteError('Delete confirmation is no longer valid; refresh the asset browser and try again.');
        return;
      }

      for (const asset of current) {
        if (asset.kind !== 'scene') {
          const result = await dispatchActiveEditorOperation({ kind: 'destroyAsset', guid: asset.guid }, 'human');
          if (!result.ok) {
            setDeleteError(result.error.hint);
            return;
          }
          continue;
        }

        const requestId = crypto.randomUUID();
        const accepted = await dispatchActiveEditorOperation({ kind: 'deleteScene', sceneGuid: asset.guid, requestId }, 'human');
        if (!accepted.ok) {
          setDeleteError(accepted.error.hint);
          return;
        }
        const terminalResponse = await waitViewportRuntimeOperationRun(requestId);
        if (terminalResponse.error !== undefined) {
          setDeleteError(terminalResponse.error.hint);
          return;
        }
        const terminal = terminalResponse.result as OperationRun;
        if (terminal.status !== 'succeeded') {
          setDeleteError(terminal.error?.hint ?? 'Scene deletion was refused; inspect the reported impact and retry.');
          return;
        }
      }
      setDeleteError(null);
      setDeleteTargets(null);
    })();
  }, [deleteTargets, workspaceSnapshot]);

  // Path-domain delete confirm (folders / source files) — mirrors the asset
  // DeleteGuardDialog but for filesystem paths, using the same reliable cb-dialog
  // styling instead of the editor-ui AlertDialog (which never paints in the
  // standalone host). Context-menu folder/file delete routes through this.
  const [pathDeleteTarget, setPathDeleteTarget] = useState<{ path: string; name: string; kind: 'dir' | 'file' } | null>(null);
  const performPathDelete = useCallback(() => {
    const current = pathDeleteTarget;
    setPathDeleteTarget(null);
    if (current === null) return;
    void dispatchActiveEditorOperation(current.kind === 'dir'
      ? { kind: 'deleteDirectory', path: current.path }
      : { kind: 'deleteSourceFile', path: current.path, requestId: crypto.randomUUID() }, 'human');
  }, [pathDeleteTarget]);

  // M3 (AC-03): asset-selection is a transient op — it goes through the one
  // gateway door (gateway.dispatch), never the direct setAssetSelection setter
  // (gateway-only door, M3), which is no longer exported from the barrel.
  const requestSceneSwitch = useCallback(async (id: string) => {
    const result = await dispatchActiveEditorOperation({ kind: 'switchSceneFile', id, requestId: crypto.randomUUID() }, 'human');
    if (!result.ok && result.error.code === 'scene-switch-dirty') {
      setPendingSceneSwitch(id);
    }
  }, []);

  const resolveSceneSwitch = useCallback((dirtyPolicy: 'save' | 'discard' | 'cancel') => {
    const id = pendingSceneSwitch;
    setPendingSceneSwitch(null);
    if (id !== null && dirtyPolicy !== 'cancel') {
      void dispatchActiveEditorOperation({ kind: 'switchSceneFile', id, dirtyPolicy, requestId: crypto.randomUUID() }, 'human');
    }
  }, [pendingSceneSwitch]);

  // M3 (AC-03): asset-selection is a transient op dispatched through the one
  // gateway door, and scene switches use the same Gateway policy path as AI.
  const openAsset = useCallback(async (asset: CBAsset) => {
    // M1 (AC-B2): single-asset select uses the `setAssetSelectionOne` sugar op
    // (forwards to the multi-base setAssetSelection applier). The bare
    // `{kind:'setAssetSelection', asset}` mix is no longer valid — argsSchema
    // requires the base `{assets, primary}` shape; sugar keeps the old single
    // call site working without re-emitting the full set.
    const selectedAsset = {
      guid: asset.guid,
      kind: asset.kind,
      name: asset.name,
      payload: asset.payload,
      packPath: asset.packPath,
    };
    const selection = await dispatchActiveEditorOperation({ kind: 'setAssetSelectionOne', asset: selectedAsset });
    if (!selection.ok) return;
    if (asset.activation) {
      if (asset.activation.mode === 'open-authored') {
        await requestSceneSwitch(asset.activation.authoredSceneId ?? '');
      } else {
        await dispatchActiveEditorOperation(sceneActivationToOp(asset.activation, asset.sourcePath), 'human');
      }
    } else if (asset.kind !== 'scene') {
      // A double-click opens a semantic editor document. The document tab owns
      // its panel domain; focusing Asset Inspector inside the Level layout was
      // the old layout-as-document conflation.
      await dispatchActiveEditorOperation({ kind: 'openAssetEditor', asset: selectedAsset }, 'human');
    }
  }, [requestSceneSwitch]);

  // Double-click: drill into a folder, or open an asset. The file-branch
  // routing (scene switch beats pack expansion) lives in the pure
  // resolveFileActivateAction so it is unit-tested without rendering.
  const handleActivate = useCallback((item: CBViewItem) => {
    selectItem(item);
    if (item.type === 'folder') { nav.navigate(item.path); return; }
    if (item.type === 'file') {
      const action = resolveFileActivateAction(item, viewMode);
      if (action.type === 'toggle-expand') { togglePackExpansion(item.path); return; }
      if (action.type === 'open-asset') {
        void openAsset(action.asset);
      } else if (action.type === 'open-file') {
        // ADR 0030: the CB never picks a viewer. It requests "open this file" on
        // the shared workbench file-open bus; workbench.openFile fetches content
        // and routes through the ResourceEditorResolver (same door the Files
        // sidebar / Agents workspace use), so a third-party resource editor can
        // claim the extension without any CB change.
        publish('workbench:open-file', { path: item.diskPath });
      }
      return;
    }
    openAsset(item);
  }, [nav, openAsset, selectItem, togglePackExpansion, viewMode]);

  const crudCallbacks: CRUDCallbacks = useMemo(() => ({
    onReload: reload,
    onSourceMutation: setSourceMutationAsset,
    onDelete: requestDelete,
    onDeleteFolder: (folder: { path: string; name: string }) =>
      setPathDeleteTarget({ path: folder.path, name: folder.name, kind: 'dir' }),
    onRename: (asset: CBAsset) => {
      void (async () => {
        const newName = await contentBrowserPrompt({
          title: t('editor.contentBrowser.contextMenu.rename'),
          label: t('editor.contentBrowser.dialogs.renameAssetPrompt'),
          defaultValue: asset.name,
          confirmText: t('editor.contentBrowser.dialogs.ok'),
          cancelText: t('editor.contentBrowser.dialogs.cancel'),
        });
        if (newName && newName !== asset.name) {
          const gate = preflightSubjectAction({
            operation: 'rename',
            asset,
            snapshot: workspaceSnapshot,
            payload: { newName },
          });
          if (!gate.preflight.ok || !authorizeSubjectAction(gate).ok) return;
          // D6: rename routes through the ONE gateway door (document op, undoable).
          // The applier reaches pack IO via ctx.assetIO and fires the in-process
          // assetsChanged notification; the Content Browser listener reloads.
          void dispatchActiveEditorOperation({ kind: 'renameAsset', packPath: asset.packPath, guid: asset.guid, newName, oldName: asset.name }, 'human');
        }
      })();
    },
    onSubjectAction: (request: Omit<SubjectActionRequest, 'snapshot'>) => {
      if (request.operation === 'rename') return;
      const gate = preflightSubjectAction({ ...request, snapshot: workspaceSnapshot });
      if (!gate.preflight.ok || !authorizeSubjectAction(gate).ok) return;
      void host.commands.execute(`asset.${request.operation}`, {
        subjectId: gate.request.subjectId,
        expectedRevision: gate.preflight.currentRevision,
        confirmationToken: gate.preflight.confirmation.token,
      });
    },
    onNewFolder: (parentPath: string) => {
      void (async () => {
        const name = await contentBrowserPrompt({
          title: t('editor.contentBrowser.actions.createFolder'),
          label: t('editor.contentBrowser.dialogs.newFolderPrompt'),
          confirmText: t('editor.contentBrowser.dialogs.createConfirm'),
          cancelText: t('editor.contentBrowser.dialogs.cancel'),
          validate: (v) => { const r = validateAssetBasename(v); return r.ok ? null : r.hint; },
        });
        if (!name) return;
        void dispatchActiveEditorOperation({ kind: 'createDirectory', parentPath, name }, 'human');
      })();
    },
  }), [host, reload, requestDelete, setSourceMutationAsset, t, workspaceSnapshot]);

  const sourceMutationViewModel = useMemo(() => {
    if (!sourceMutationAsset?.sourceKey) return null;
    const runs = operationRunSnapshot.runs;
    const preflightRun = findSourceMutationPreflightRun(runs, sourceMutationAsset.guid, sourceMutationAsset.sourceKey);
    const preflight = preflightRun === undefined ? undefined : sourceMutationPreflightFromRun(preflightRun);
    if (preflight === undefined) return null;
    const run = findSourceMutationRun(runs, sourceMutationAsset.guid, sourceMutationAsset.sourceKey);
    const expectedRevision = resolveSourceMutationExpectedRevision(
      sourceMutationAsset.metaRevision,
      { expectedRevision: preflight.source.expectedRevision },
    );
    if (expectedRevision === undefined) return null;
    const lifecycle = resolveSourceMutationLifecycle({
      catalogLifecycle: sourceMutationAsset.lifecycle,
      operationStatus: run?.status,
      hasLastKnownGood: sourceMutationAsset.lastKnownGood !== undefined,
    });
    const operation = run === undefined ? undefined : sourceMutationOperationFromRun(run);
    return createSourceMutationViewModel({
      guid: sourceMutationAsset.guid,
      sourceKey: sourceMutationAsset.sourceKey,
      lifecycle,
      ...(sourceMutationAsset.lastKnownGood?.packageUrl === undefined ? {} : { lastKnownGood: sourceMutationAsset.lastKnownGood.packageUrl }),
      impact: { ...preflight.impact, expectedRevision },
      ...(operation === undefined ? {} : { operation }),
      ...(preflight.confirmation === undefined ? {} : { confirmation: preflight.confirmation }),
      now: Date.now(),
    });
  }, [operationRunSnapshot, sourceMutationAsset]);

  const dispatchCatalogReconcile = useCallback(() => {
    void dispatchActiveEditorOperation({
      kind: 'catalog.reconcile',
      requestId: crypto.randomUUID(),
    }, 'human').then((result) => {
      if (!result.ok) console.warn('[content-browser] catalog reconcile rejected', result.error);
    });
  }, []);

  const handleSourceMutationAction = useCallback((action: SourceMutationAction) => {
    const asset = sourceMutationAsset;
    const viewModel = sourceMutationViewModel;
    const sourceKey = asset?.sourceKey;
    if (!asset || !sourceKey || !viewModel) return;
    if (action === 'reimport') {
      dispatchReimportAsset({ ...asset, revision: viewModel.impact.expectedRevision });
    } else if (action === 'discard' && viewModel.confirmationToken) {
      void dispatchActiveEditorOperation({
        kind: 'discardSourceOverridesAndReimport',
        guid: asset.guid,
        scope: { sourceKey: asset.sourceKey! },
        expectedRevision: viewModel.impact.expectedRevision,
        confirmationToken: viewModel.confirmationToken,
        requestId: crypto.randomUUID(),
      }, 'human').then((result) => {
        if (!result.ok) console.warn('[content-browser] discard source overrides rejected', result.error);
      });
    } else if (action === 'retry') {
      const run = findRetryableSourceMutationRun(
        operationRunSnapshot.runs,
        asset.guid,
        sourceKey,
      );
      if (run) operationRunSource.retry?.(run.runId, run.requestId);
    } else if (action === 'reconcile') {
      dispatchCatalogReconcile();
    }
  }, [dispatchCatalogReconcile, operationRunSnapshot, operationRunSource, sourceMutationAsset, sourceMutationViewModel]);

  const createFolderInCurrentPath = useCallback(() => {
    void (async () => {
      const name = await contentBrowserPrompt({
        title: t('editor.contentBrowser.actions.createFolder'),
        label: t('editor.contentBrowser.dialogs.newFolderPrompt'),
        confirmText: t('editor.contentBrowser.dialogs.createConfirm'),
        cancelText: t('editor.contentBrowser.dialogs.cancel'),
        validate: (v) => { const r = validateAssetBasename(v); return r.ok ? null : r.hint; },
      });
      if (!name) return;
      void dispatchActiveEditorOperation({ kind: 'createDirectory', parentPath: nav.currentPath, name }, 'human');
    })();
  }, [nav.currentPath, t]);

  const createAssetInCurrentPath = useCallback((spec: CreatableAssetSpec) => {
    void (async () => {
      const name = (await contentBrowserPrompt({
        title: t('editor.contentBrowser.actions.createAsset', { label: labelForAssetKind(spec.kind, t) }),
        label: t('editor.contentBrowser.dialogs.newAssetNameLabel'),
        defaultValue: spec.defaultNamePrefix,
        confirmText: t('editor.contentBrowser.dialogs.createConfirm'),
        cancelText: t('editor.contentBrowser.dialogs.cancel'),
      }))?.trim();
      if (!name) return;
      if (spec.kind === 'scene') {
        const requestId = crypto.randomUUID();
        const result = await dispatchActiveEditorOperation({ kind: 'createSceneFile', id: name, duplicateCurrent: false, requestId }, 'human');
        if (!result.ok) console.warn('[content-browser] create scene dispatch rejected', result.error);
        return;
      }
      // packPath must stay GAME-RELATIVE — appliers call resolveGamePath themselves.
      // Pre-resolving here double-prefixes the host game root onto itself.
      const packDir = (nav.currentPath || 'assets').replace(/^\/+|\/+$/g, '') || 'assets';
      if (spec.kind === 'material') {
        void dispatchActiveEditorOperation({
          kind: 'createMaterial',
          guid: generateAssetGuid(),
          name,
          baseColor: [1, 1, 1, 1],
          metallic: 0,
          roughness: 0.5,
          packPath: `${packDir}/Materials.pack.json`,
        }, 'human');
      } else if (spec.kind === 'material-instance') {
        await createMaterialInstanceAndOpen(name, packDir);
      } else if (spec.kind === 'input-map') {
        await createInputMapAndOpen(name, packDir);
      } else {
        void dispatchActiveEditorOperation({
          kind: 'createAsset',
          packPath: `${packDir}/${name}.pack.json`,
          guid: generateAssetGuid(),
          assetKind: spec.kind,
          name,
        }, 'human');
      }
    })();
  }, [nav.currentPath, t]);

  // Per-card favorite state + toggle, threaded through CBGrid so every card's
  // ⭐ toggles favorites directly (same identity as the context menu: folders and
  // files key on their game-relative path, assets on their guid — a pack file
  // holds N assets, so a path cannot tell them apart).
  // The header "favorites only" filter then narrows the content view to these.
  const isItemFavorite = useCallback((item: CBViewItem): boolean => (
    item.type === 'asset' ? favorites.isFavorite({ kind: 'asset', guid: item.guid }) : item.isFavorite
  ), [favorites.isFavorite]);
  const toggleItemFavorite = useCallback((item: CBViewItem): void => {
    favorites.toggleFavorite(favoriteRef(item));
  }, [favorites.toggleFavorite]);

  const renameItem = useCallback((item: CBViewItem) => {
    if (item.type === 'asset') {
      crudCallbacks.onRename?.(item);
      return;
    }
    void (async () => {
      const newName = await contentBrowserPrompt({
        title: t('editor.contentBrowser.contextMenu.rename'),
        label: t('editor.contentBrowser.dialogs.renameAssetPrompt'),
        defaultValue: item.name,
        confirmText: t('editor.contentBrowser.dialogs.ok'),
        cancelText: t('editor.contentBrowser.dialogs.cancel'),
      });
      if (!newName || newName === item.name) return;
      const slash = item.path.lastIndexOf('/');
      const newPath = slash >= 0 ? item.path.slice(0, slash + 1) + newName : newName;
      pendingReselectRef.current = { oldPath: item.path, newPath, newName };
      if (item.type === 'folder') {
        const cur = navPathRef.current;
        if (cur === item.path || cur.startsWith(`${item.path}/`)) {
          nav.navigate(`${newPath}${cur.slice(item.path.length)}`);
        }
        void dispatchActiveEditorOperation({ kind: 'renameDirectory', path: item.path, newName }, 'human');
      } else {
        void dispatchActiveEditorOperation({ kind: 'renameSourceFile', path: item.path, newName }, 'human');
      }
    })();
  }, [crudCallbacks, nav, t]);

  const deleteItem = useCallback((item: CBViewItem) => {
    if (item.type === 'folder') {
      setPathDeleteTarget({ path: item.path, name: item.name, kind: 'dir' });
      return;
    }
    if (item.type === 'file') {
      const sceneAsset = item.family === 'scene' ? item.assets.find(asset => asset.kind === 'scene') : undefined;
      if (sceneAsset) requestDelete([sceneAsset]);
      else setPathDeleteTarget({ path: item.path, name: item.name, kind: 'file' });
      return;
    }
    const selected = multiSelect.selection.items.filter((candidate): candidate is CBAsset => candidate.type === 'asset');
    const targets = selected.length > 1 && selected.some(candidate => candidate.guid === item.guid)
      ? selected
      : [item];
    requestDelete(targets);
  }, [multiSelect.selection.items, requestDelete]);

  const commonItemMenu = useCallback((item: CBViewItem) => {
    if (item.type === 'folder') {
      const fullPath = resolveGamePath(item.path);
      return [
        { label: item.isFavorite ? t('editor.contentBrowser.contextMenu.unfavorite') : t('editor.contentBrowser.contextMenu.favorite'), icon: 'star', onClick: () => favorites.toggleFavorite(favoriteRef(item)) },
        { label: t('editor.contentBrowser.contextMenu.rename'), icon: 'pencil', shortcut: 'F2', onClick: () => renameItem(item) },
        { label: t('editor.contentBrowser.contextMenu.copyPath'), icon: 'copy', onClick: () => copyText(fullPath) },
        { label: t('editor.contentBrowser.contextMenu.copyRelativePath'), icon: 'copy', onClick: () => copyText(item.path) },
        { label: t('editor.contentBrowser.contextMenu.showInFileManager'), icon: 'folder-search', onClick: () => {
          void dispatchActiveEditorOperation({ kind: 'revealInFileManager', path: resolveGamePath(item.path) }, 'human');
        } },
        { label: t('editor.contentBrowser.contextMenu.delete'), icon: 'trash-2', shortcut: 'Del', danger: true, onClick: () => deleteItem(item) },
      ];
    }
    if (item.type === 'file') {
      return [
        { label: t('editor.contentBrowser.contextMenu.rename'), icon: 'pencil', shortcut: 'F2', onClick: () => renameItem(item) },
        { label: t('editor.contentBrowser.contextMenu.copyPath'), icon: 'copy', onClick: () => copyText(item.diskPath) },
        { label: t('editor.contentBrowser.contextMenu.copyRelativePath'), icon: 'copy', onClick: () => copyText(item.path) },
        { label: t('editor.contentBrowser.contextMenu.showInFileManager'), icon: 'folder-search', onClick: () => {
          void dispatchActiveEditorOperation({ kind: 'revealInFileManager', path: resolveGamePath(item.path) }, 'human');
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
        { label: t('editor.contentBrowser.contextMenu.delete'), icon: 'trash-2', shortcut: 'Del', danger: true, onClick: () => deleteItem(item) },
      ];
    }
    const relPath = relByAssetGuid.get(item.guid) ?? catalogPathToRoot(item.packPath, gameSlug, catalogAssetRoots) ?? item.packPath;
    const fullPath = resolveCopyPath(relPath);
    const importedActions = item.activation?.provenance === 'imported-output'
      ? [{
          label: 'Promote to Editable Scene',
          icon: 'copy-plus',
          disabled: !item.activation.canPromote,
          onClick: item.activation.canPromote
            ? () => {
                void (async () => {
                  const targetName = await contentBrowserPrompt({
                    title: 'Promote Imported Scene',
                    label: 'Authored scene name',
                    defaultValue: item.name,
                    confirmText: 'Promote',
                    cancelText: t('editor.contentBrowser.dialogs.cancel'),
                    validate: (value) => {
                      const result = validateAssetBasename(value);
                      return result.ok ? null : result.hint;
                    },
                  });
                  if (!targetName) return;
                  const slug = targetName.trim().toLowerCase()
                    .replace(/[^a-z0-9-]+/g, '-')
                    .replace(/^-+|-+$/g, '');
                  if (!slug) return;
                  void dispatchActiveEditorOperation(scenePromoteToOp(item.activation!, {
                    targetPackPath: `assets/scenes/${slug}.pack.json`,
                    targetName,
                    contentPolicy: 'effective-base',
                  }), 'human');
                })();
              }
            : undefined,
        }]
      : [];
    return [
      ...importedActions,
      { label: t('editor.contentBrowser.contextMenu.rename'), icon: 'pencil', shortcut: 'F2', onClick: () => renameItem(item) },
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
      { label: t('editor.contentBrowser.contextMenu.delete'), icon: 'trash-2', shortcut: 'Del', danger: true, onClick: () => deleteItem(item) },
    ];
  }, [deleteItem, favorites, fetchDiskDirs, gameSlug, host.commands, relByAssetGuid, reload, renameItem, t]);

  const importSelectedFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      logImport('ContentBrowser.import.cancel', { reason: 'no files selected' });
      return;
    }

    logImport('ContentBrowser.import.selected', {
      count: files.length,
      names: files.map(file => file.name),
      currentPath: selectedImportPath,
    });

    setImportProgress({ total: files.length, completed: 0, current: '', results: [], runs: [] });
    const results = await importFiles(
      files,
      selectedImportPath,
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

    if (errors.length === 0) setTimeout(() => setImportProgress(null), 3000);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [reload, selectedImportPath]);

  const handleImport = useCallback(() => {
    const input = fileInputRef.current;
    logImport('ContentBrowser.import.click', {
      currentPath: selectedImportPath,
      projectPickerPath,
      accept: acceptString,
      hasFbx: acceptString.includes('.fbx'),
      acceptDom: input?.getAttribute('accept') ?? input?.accept ?? null,
    });
    void (async () => {
      if (!projectPickerPath) {
        input?.click();
        return;
      }
      const nativePick = await pickNativeImportFiles(projectPickerPath);
      if (nativePick.kind === 'selected') {
        await importSelectedFiles(nativePick.files);
        return;
      }
      if (nativePick.kind === 'cancelled') return;
      // Browser-only hosts and older servers keep the normal file input path.
      logImport('ContentBrowser.import.fallback', { reason: 'native picker unavailable' });
      input?.click();
    })();
  }, [acceptString, importSelectedFiles, projectPickerPath, selectedImportPath]);

  const openFolderContextMenu = useCallback((pos: { clientX: number; clientY: number; preventDefault: () => void }, folder: CBFolder) => {
    const assetsInFolder = scopedAssets
      .filter(s => s.rel === folder.path || s.rel.startsWith(`${folder.path}/`))
      .map(s => s.asset);
    const menuItems = buildFolderContextMenu(folder, assetsInFolder, crudCallbacks);
    const resolved = resolveFolderMenuItems(menuItems, {
      onOpen: () => nav.navigate(folder.path),
      onToggleFavorite: () => favorites.toggleFavorite(favoriteRef(folder)),
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
    const sceneAsset = file.assets.find(asset => asset.kind === 'scene');
    const items: CBContextMenuEntry[] = [
      { title: file.name, icon: iconNameForFileFamily(file.family) },
      ...fileSpecificMenuItems(t, file, firstAsset, {
        sceneGuid: sceneAsset?.guid,
        defaultSceneGuid: sceneModel.defaultScene?.guid ?? null,
      }).map(item => ({
        ...item,
        onClick: item.id === 'expand-sub-assets'
          ? () => togglePackExpansion(file.path)
          : item.id === 'render-preview' || item.id === 'audition'
          ? () => selectItem(file)
          : item.id === 'reimport' && firstAsset
            ? () => setSourceMutationAsset(firstAsset)
          : item.id === 'set-default-scene' && sceneAsset
            ? () => {
              void dispatchActiveEditorOperation({
                kind: 'setDefaultScene',
                sceneGuid: sceneAsset.guid,
                requestId: crypto.randomUUID(),
              }, 'human').then((result) => {
                if (!result.ok) console.warn('[content-browser] set default scene dispatch rejected', result.error);
              });
            }
          : item.id === 'copy-guid' && firstAsset
            ? () => { void navigator.clipboard.writeText(file.assets.map(asset => asset.guid).join('\n')); }
            : undefined,
        disabled: item.disabled || (item.id === 'copy-guid' && !firstAsset),
      })),
      { sep: true },
      ...commonItemMenu(file),
      { sep: true },
    ];
    // Gate on the actual scene asset (kind === 'scene'), matching openAsset's
    // switch condition — not on family alone or assets[0], which may be a
    // non-scene entry in a multi-asset pack.
    if (sceneAsset) {
      const activationLabel = sceneAsset.activation?.mode === 'preview-imported'
        ? 'Imported Preview · Read-only'
        : t('editor.contentBrowser.contextMenu.setCurrentScene');
      items.splice(1, 0, { label: activationLabel, icon: 'flag', onClick: () => openAsset(sceneAsset) });
    }
    setTimeout(() => showContextMenu(pos, orderContextMenuEntries(items)), 0);
  }, [commonItemMenu, openAsset, sceneModel.defaultScene?.guid, selectItem, togglePackExpansion, t]);

  const handleFileSelected = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) {
      logImport('ContentBrowser.import.cancel', { reason: 'no files selected' });
      return;
    }
    void importSelectedFiles(Array.from(files));
  }, [importSelectedFiles]);

  const handleCancelImport = useCallback(() => {
    const requestId = importProgress?.currentRequestId;
    if (requestId === undefined) return;
    void cancelViewportRuntimeOperationRun(requestId).then((response) => {
      if (response.error === undefined) return;
      setImportProgress(previous => previous === null ? previous : { ...previous, actionError: response.error!.hint });
    });
  }, [importProgress?.currentRequestId]);

  const handleRetryImport = useCallback(async (record: ImportRunRecord) => {
    const originalRunId = record.run.runId;
    const retried = await retryImportRun(record, (requestId, run) => {
      setImportProgress(previous => {
        if (previous === null) return previous;
        const runs = previous.runs.map(entry => entry.run.runId === originalRunId
          ? { ...entry, requestId, run }
          : entry);
        return {
          ...previous,
          currentRequestId: requestId,
          currentRun: run,
          runs,
          actionError: undefined,
        };
      });
    });
    if (!retried.ok) {
      setImportProgress(previous => previous === null ? previous : { ...previous, actionError: retried.error.hint });
      return;
    }
    setImportProgress(previous => {
      if (previous === null) return previous;
      const results = previous.results.map(result => result.filename === record.filename ? retried.result : result);
      return { ...previous, results, currentRequestId: retried.requestId, currentRun: retried.terminal, actionError: undefined };
    });
    reload();
  }, [reload]);

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
    getFocusedSourceTreeItem,
    getFocusedGridItem,
    renameItem,
    deleteItem,
    selectAllGridItems: multiSelect.selectAll,
  });

  const handleContextMenu = useCallback((e: React.MouseEvent, item: CBViewItem) => {
    e.preventDefault();
    e.stopPropagation();
    const selectedEntity = getSelection();
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
    const menuItems = buildAssetContextMenu(asset, contextSelection, allAssets, crudCallbacks, selectedEntity);
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
    const menuItems = buildBlankAreaContextMenu(
      nav.currentPath,
      (parentPath) => {
        void (async () => {
          const name = await contentBrowserPrompt({
            title: t('editor.contentBrowser.actions.createFolder'),
            label: t('editor.contentBrowser.dialogs.newFolderPrompt'),
            confirmText: t('editor.contentBrowser.dialogs.createConfirm'),
            cancelText: t('editor.contentBrowser.dialogs.cancel'),
            validate: (v) => { const r = validateAssetBasename(v); return r.ok ? null : r.hint; },
          });
          if (!name) return;
          void dispatchActiveEditorOperation({ kind: 'createDirectory', parentPath, name }, 'human');
        })();
      },
      CREATABLE_ASSET_KINDS.map((spec) => ({
        id: `new-${spec.kind}`,
        label: labelForAssetKind(spec.kind, t),
        action: () => createAssetInCurrentPath(spec),
      })),
    );
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
  }, [nav.currentPath, t, createAssetInCurrentPath]);

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
    const files = all;
    logImport('ContentBrowser.drop', {
      allNames: all.map(f => f.name),
      importableNames: files.map(f => f.name),
      currentPath: selectedImportPath,
    });
    if (files.length === 0 || !gameSlug || gameSlug === 'default') return;
    void importFiles(
      files,
      selectedImportPath,
      (p) => setImportProgress(p),
      reload,
    ).then((results) => {
      if (results.every(result => result.status === 'done')) setTimeout(() => setImportProgress(null), 3000);
    });
  }, [gameSlug, reload, selectedImportPath]);

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
      data-testid="cb-root"
      data-facts="product"
      data-projection-source="editor-product"
      data-revision={workspaceSnapshot.revision}
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
            projectName={projectName}
            favoritesOnly={favoritesOnly}
            setFavoritesOnly={setFavoritesOnly}
            sourceTree={sourceTree}
            collapsedSourceFolders={collapsedSourceFolders}
            setCollapsedSourceFolders={setCollapsedSourceFolders}
            selectedPath={selectedSourcePath}
            setSelectedItem={setSelectedItem}
            setPreviewItem={setPreviewItem}
            onFocusItem={focusSourceTreeItem}
            nav={nav}
            openFolderContextMenu={openFolderContextMenu}
            openFileContextMenu={openFileContextMenu}
          />

          {/* Draggable divider (UE-parity): widen the tree to read long paths. */}
          <ResizeHandle orientation="col" onDrag={onSplitDrag} onDragEnd={onSplitDragEnd}
            title={t('editor.contentBrowser.actions.resizeFolderTree')} />

          {/* Right: Asset view */}
          <div className="cb-asset-view" onClick={handleContainerClick} onContextMenu={handleBlankContextMenu}>
            <ContentBrowserActionBar executeCommand={executeContentBrowserCommand} nav={nav} gameSlug={gameSlug} allDirs={allDirs} />
            <div className="cb-content-body">
              <div className="cb-grid-column">
                <CBFilterBar filter={filter} sort={sort} thumbnailSize={thumbnailSize} onThumbnailSizeChange={setThumbnailSize} />
                {catalogStale && (
                  <div className="cb-catalog-stale" data-testid="cb-catalog-stale" role="status">
                    <span>Catalog is stale. Browser context is preserved until reconciliation.</span>
                    <Button size="sm" variant="subtle" onClick={dispatchCatalogReconcile}>Reconcile Catalog</Button>
                  </div>
                )}
                {loading && viewItems.length === 0 ? (
                  <div style={{ padding: 16, opacity: 0.5 }}>{t('editor.contentBrowser.empty.loading')}</div>
                ) : viewItems.length === 0 ? (
                  <div style={{ padding: 16, opacity: 0.5 }}>
                    {filter.activeFilterCount > 0 || filter.searchQuery
                      ? t('editor.contentBrowser.empty.noMatching')
                      : favoritesOnly
                        ? t('editor.contentBrowser.empty.noAssets')
                        : t('editor.contentBrowser.empty.emptyFolder')}
                  </div>
                ) : (
                  <CBGrid
                    items={viewItems}
                    thumbnailSize={thumbnailSize}
                    multiSelect={multiSelect}
                    viewMode={viewMode}
                    expandedPacks={expandedPacks}
                    onTogglePackExpansion={togglePackExpansion}
                    onSelect={selectItem}
                    onDoubleClick={handleActivate}
                    onContextMenu={handleContextMenu}
                    onFocusItem={focusGridItem}
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
          </div>
        </div>
      )}

      {importProgress && (
        <div className="cb-import-progress">
          <span className="cb-import-progress-text">
            {currentImportRun?.status === 'failed'
              ? t('editor.contentBrowser.importProgress.failed', { name: importProgress.current })
              : currentImportRun?.status === 'cancelled'
              ? t('editor.contentBrowser.importProgress.cancelled', { name: importProgress.current })
              : currentImportRun?.status === 'accepted' || currentImportRun?.status === 'running'
              ? t('editor.contentBrowser.importProgress.phase', {
                  current: importProgress.completed + 1,
                  total: importProgress.total,
                  name: importProgress.current,
                  stage: currentImportRun.progress.stage,
                  percent: Math.round(currentImportRun.progress.fraction * 100),
                })
              : importProgress.completed < importProgress.total
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
              style={{ width: `${Math.round((currentImportRun?.progress.fraction ?? (importProgress.completed / importProgress.total)) * 100)}%` }}
            />
          </div>
          {importProgress.actionError && (
            <span className="cb-import-progress-error">{importProgress.actionError}</span>
          )}
          {currentImportIsActive && (
            <Button
              size="sm"
              variant="subtle"
              className="cb-import-progress-action"
              disabled={!currentImportCanCancel}
              onClick={handleCancelImport}
            >
              {t('editor.contentBrowser.importProgress.cancel')}
            </Button>
          )}
          {retryableImportRuns.map(record => (
            <Button
              key={record.run.runId}
              size="sm"
              variant="subtle"
              className="cb-import-progress-action"
              onClick={() => { void handleRetryImport(record); }}
            >
              {t('editor.contentBrowser.importProgress.retry', { name: record.filename })}
            </Button>
          ))}
          {importProgress.completed >= importProgress.total && (
            <Button
              size="sm"
              variant="subtle"
              className="cb-import-progress-action"
              onClick={() => setImportProgress(null)}
            >
              {t('editor.contentBrowser.importProgress.dismiss')}
            </Button>
          )}
        </div>
      )}

      {dragOver && (
        <div className="cb-drag-overlay">
          <div className="cb-drag-overlay-label">{t('editor.contentBrowser.empty.dropFiles')}</div>
        </div>
      )}

      {sourceMutationViewModel && createPortal(
        <div className="cb-dialog-overlay" data-testid="cb-source-mutation-overlay" {...contentBrowserInteractionAttrs} onClick={() => setSourceMutationAsset(null)}>
          <div className="cb-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <SourceMutationDialog viewModel={sourceMutationViewModel} onAction={handleSourceMutationAction} />
            <Button size="sm" variant="subtle" onClick={() => setSourceMutationAsset(null)}>Close</Button>
          </div>
        </div>,
        document.body,
      )}

      {deleteTargets && createPortal(
        <DeleteGuardDialog
          targets={deleteTargets}
          impact={computeDeleteImpact(deleteTargets.map(t => t.guid), workspaceSnapshot)}
          openResources={deleteOpenResources}
          sceneGuards={sceneDeleteGuards}
          preflight={preflightSubjectAction({
            operation: 'delete',
            asset: deleteTargets[0]!,
            snapshot: workspaceSnapshot,
          }).preflight}
          nameByGuid={nameByGuid}
          error={deleteError}
          interactionScope={CONTENT_BROWSER_INTERACTION_SCOPE}
          onConfirm={performDelete}
          onCancel={() => setDeleteTargets(null)}
        />,
        document.body,
      )}

      {saveAllOpen && createPortal(
        <SaveAssetsDialog
          interactionScope={CONTENT_BROWSER_INTERACTION_SCOPE}
          onClose={(confirmed) => { resolveSaveAll(confirmed); setSaveAllOpen(false); }}
        />,
        document.body,
      )}

      {pathDeleteTarget && createPortal(
        <div
          className="cb-dialog-overlay"
          data-testid="cb-path-delete-overlay"
          {...contentBrowserInteractionAttrs}
          onClick={() => setPathDeleteTarget(null)}
        >
          <div
            className="cb-dialog"
            role="alertdialog"
            aria-modal="true"
            data-testid="cb-path-delete-modal"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); setPathDeleteTarget(null); }
              else if (e.key === 'Enter') { e.preventDefault(); performPathDelete(); }
            }}
            tabIndex={-1}
          >
            <div className="cb-dialog-title">{t('editor.contentBrowser.contextMenu.delete')}</div>
            <div className="cb-dialog-body">
              <ul className="cb-dialog-list">
                <li className="cb-dialog-item">
                  <span className="cb-dialog-item-name">{pathDeleteTarget.name}</span>
                </li>
              </ul>
              <p className="cb-dialog-note">
                {pathDeleteTarget.kind === 'dir'
                  ? t('editor.contentBrowser.dialogs.deleteFolderConfirm', { name: pathDeleteTarget.name })
                  : t('editor.contentBrowser.dialogs.deleteFileConfirm', { name: pathDeleteTarget.name })}
              </p>
            </div>
            <div className="cb-dialog-actions">
              <Button
                className="cb-dialog-btn"
                data-testid="cb-path-delete-cancel"
                size="sm"
                variant="subtle"
                onClick={() => setPathDeleteTarget(null)}
              >
                {t('editor.contentBrowser.deleteGuard.cancel')}
              </Button>
              <Button
                className="cb-dialog-btn"
                data-testid="cb-path-delete-confirm"
                size="sm"
                variant="destructive"
                onClick={performPathDelete}
              >
                {t('editor.contentBrowser.deleteGuard.confirm')}
              </Button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {pendingSceneSwitch !== null && createPortal(
        <div
          className="cb-dialog-overlay"
          data-testid="scene-switch-policy-dialog"
          {...contentBrowserInteractionAttrs}
          onClick={() => resolveSceneSwitch('cancel')}
        >
          <div
            className="cb-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="scene-switch-policy-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); resolveSceneSwitch('cancel'); }
            }}
            tabIndex={-1}
          >
            <div className="cb-dialog-title" id="scene-switch-policy-title">
              {t('editor.contentBrowser.dialogs.sceneSwitch.title')}
            </div>
            <div className="cb-dialog-body">
              {t('editor.contentBrowser.dialogs.sceneSwitch.body', { name: pendingSceneSwitch })}
            </div>
            <div className="cb-dialog-actions">
              <Button
                className="cb-dialog-btn"
                data-testid="scene-switch-policy-cancel"
                size="sm"
                variant="subtle"
                onClick={() => resolveSceneSwitch('cancel')}
              >
                {t('editor.contentBrowser.dialogs.sceneSwitch.cancel')}
              </Button>
              <Button
                className="cb-dialog-btn"
                data-testid="scene-switch-policy-discard"
                size="sm"
                variant="subtle"
                onClick={() => resolveSceneSwitch('discard')}
              >
                {t('editor.contentBrowser.dialogs.sceneSwitch.discard')}
              </Button>
              <Button
                className="cb-dialog-btn"
                data-testid="scene-switch-policy-save"
                size="sm"
                variant="default"
                onClick={() => resolveSceneSwitch('save')}
              >
                {t('editor.contentBrowser.dialogs.sceneSwitch.save')}
              </Button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
