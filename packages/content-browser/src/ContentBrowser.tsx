import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
// M3 (AC-03): asset-selection is a transient op dispatched through the one
// gateway door — gateway.dispatch({ kind: 'setAssetSelection', … }) — not the direct
// setAssetSelection setter.
import { gateway, getSceneId, panelBridge, resolveGamePath, showContextMenu, useDocVersion,
  ResizeHandle, useLocalSize, getSceneList } from '@forgeax/editor-core';
import { useMultiSelect } from './hooks/useMultiSelect';
import { useSort } from './hooks/useSort';
import { useFilter } from './hooks/useFilter';
import { useNavHistory } from './hooks/useNavHistory';
import { useFavorites } from './hooks/useFavorites';
import { useAssetGraph } from './hooks/useAssetGraph';
import { computeDeleteImpact } from './delete-guard';
import { DeleteGuardDialog } from './DeleteGuardDialog';
import { buildAssetContextMenu, buildBlankAreaContextMenu, buildFolderContextMenu, type CRUDCallbacks } from './CBContextMenu';
import { resolveFolderMenuItems } from './folder-menu';
import { CBFilterBar } from './CBFilterBar';
import { CBNavigationBar } from './CBNavigationBar';
import { CBGrid } from './CBGrid';
import { CBList } from './CBList';
import { CBColumn } from './CBColumn';
import { CBStatusBar } from './CBStatusBar';
import { CBToolbar } from './CBToolbar';
import { importFiles, type ImportProgress } from './import-pipeline';
import { isImportable, buildAcceptString, logImport } from './import-registry';
import { deriveContentView } from './folder-view';
import type { CBAsset, CBFolder, CBViewItem, CBViewMode } from './types';
import { useStartupScan } from './useStartupScan';
import { ScanOverlay } from './ScanOverlay';
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

function registryEntryToCBAsset(
  e: { guid: string; kind: string; name?: string; relativeUrl: string; refs?: readonly string[]; sourcePath?: string },
  index: number,
): CBAsset {
  // packPath is the CRUD target on disk — NOT the runtime load URL. For an
  // internal `.pack.json` asset the two coincide (relativeUrl IS the pack). For
  // an external import (FBX/GLB/HDR/audio/font) relativeUrl points at a DDC
  // artefact (`*.{guid}.bin` or `/__forgeax-ddc/{guid}.pack.json`) that has no
  // stable mapping back to the source; the CRUD target is the `.meta.json`
  // sidecar beside the source file. The engine surfaces that source location as
  // `sourcePath` (engine sourcePath-through-listCatalog, #711); derive the
  // sidecar path from it. Fallback to relativeUrl for inline/dev entries that
  // never went through pack-index (no sidecar, no CRUD).
  const packPath = e.relativeUrl.endsWith('.pack.json')
    ? e.relativeUrl
    : e.sourcePath
      ? `${e.sourcePath.startsWith('/') ? '' : '/'}${e.sourcePath}.meta.json`
      : e.relativeUrl;
  return {
    type: 'asset',
    guid: e.guid,
    kind: e.kind,
    name: e.name ?? e.guid.slice(0, 8),
    payload: {},
    packPath,
    packIndex: index,
    refs: e.refs ? [...e.refs] : [],
    estimatedSize: 0,
  };
}

// Convert a catalog packPath — which is workspace-rooted (relative to the vite
// process cwd, e.g. "forgeax-games/hellforge/assets/characters/x.pack.json";
// see vite-plugin-pack build-catalog.ts `relative(process.cwd(), …)`) — to a
// GAME-relative path ("assets/characters/x.pack.json") by locating the game's
// `<slug>` path segment (the game dir basename === slug in the standalone
// backend). Entries that don't sit under the loaded game (shared template roots,
// ddk, other games) carry no `<slug>` segment → null, so they're excluded from
// the Asset panel scope.
function toGameRelative(packPath: string, slug: string): string | null {
  if (!slug) return null;
  const parts = packPath.replace(/^\/+/, '').split('/');
  const i = parts.indexOf(slug);
  if (i < 0) return null;
  const rel = parts.slice(i + 1).join('/');
  return rel || null;
}

export function ContentBrowser() {
  useDocVersion();
  // Startup asset scan: runs once on mount, locks gateway during scan
  const { scanning } = useStartupScan();
  const gameSlug = getSceneId();
  const [allAssets, setAllAssets] = useState<CBAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<CBViewMode>('grid');
  const [thumbnailSize, setThumbnailSize] = useState(80);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const observedAssetKinds = useMemo(
    () => [...new Set(allAssets.map(asset => asset.kind))],
    [allAssets],
  );
  const nav = useNavHistory();
  const filter = useFilter(observedAssetKinds);
  const sort = useSort();
  const favorites = useFavorites();
  // The Asset panel's folder tree is scoped to the game's DECLARED asset roots
  // (game package.json `forgeax.assets.roots`, e.g. ["assets"]) — NOT the whole
  // engine catalog, which also folds in scenes/ + shared template roots (needed
  // by runtime loadByGuid, but not browsable game assets). Default to ["assets"]
  // until the game's package.json is read.
  const [assetRoots, setAssetRoots] = useState<string[]>(['assets']);

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
  const splitRef = useRef<HTMLDivElement>(null);
  const srcWidthRef = useRef(srcWidth);
  useEffect(() => { srcWidthRef.current = srcWidth; }, [srcWidth]);
  const onSplitDrag = useCallback((dx: number) => {
    const next = Math.min(640, Math.max(140, srcWidthRef.current + dx));
    srcWidthRef.current = next;
    splitRef.current?.style.setProperty('--cb-src-w', `${next}px`);
  }, []);
  const onSplitDragEnd = useCallback(() => { setSrcWidth(srcWidthRef.current); }, [setSrcWidth]);

  const reload = useCallback(() => {
    const slug = getSceneId();
    if (!slug || slug === 'default') return;
    setLoading(true);
    // M3: registry.listCatalog() replaces parallel-disk-scan loadGameAssets/loadMetaAssets.
    // The engine AssetRegistry is the SSOT — asset panel truth = engine truth (AC-03).
    //
    // refreshCatalog first: listCatalog() is a sync cache read. On single-realm boot the
    // Assets tab is inactive, so ContentBrowser mounts AFTER host-session's one-shot
    // broadcastAssetsChanged (and installAssetCatalogRefresh is wired even later). Without
    // an explicit refresh here the first mount sees an empty packIndexCache forever.
    type RegistrySurface = {
      listCatalog?: () => readonly { guid: string; kind: string; name?: string; relativeUrl: string; refs?: readonly string[]; sourcePath?: string }[];
      refreshCatalog?: () => Promise<boolean>;
    };
    const registry = gateway.doc.registry as RegistrySurface | undefined;
    const apply = () => {
      const entries = registry?.listCatalog?.();
      if (!entries || entries.length === 0) {
        setAllAssets([]);
      } else {
        setAllAssets(entries.map(registryEntryToCBAsset));
      }
      setLoading(false);
    };
    if (registry?.refreshCatalog) {
      void registry.refreshCatalog().then(apply).catch(apply);
    } else {
      apply();
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // Read the game's declared asset roots from its package.json
  // (`forgeax.assets.roots`). Falls back to the ["assets"] default on any
  // miss so the tree still scopes sanely.
  useEffect(() => {
    const slug = getSceneId();
    if (!slug || slug === 'default') return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(
          `/api/files?path=${encodeURIComponent(resolveGamePath('package.json'))}`,
          { cache: 'no-store' },
        );
        if (!r.ok) return;
        const j = (await r.json()) as { content?: string };
        if (!j.content) return;
        const pkg = JSON.parse(j.content) as { forgeax?: { assets?: { roots?: unknown } } };
        const roots = pkg.forgeax?.assets?.roots;
        if (!cancelled && Array.isArray(roots) && roots.length > 0 && roots.every((x) => typeof x === 'string')) {
          setAssetRoots(roots as string[]);
        }
      } catch { /* keep default ['assets'] */ }
    })();
    return () => { cancelled = true; };
  }, [gameSlug]);

  useEffect(() => {
    const accept = buildAcceptString();
    logImport('ContentBrowser.mount', { gameSlug, accept, hasFbx: accept.includes('.fbx') });
  }, [gameSlug]);

  // Disk directories: fetch real directory tree from server so empty dirs
  // (created via New Folder) are visible even without pack files inside.
  const [diskDirs, setDiskDirs] = useState<string[]>([]);
  const fetchDiskDirs = useCallback(async () => {
    if (!gameSlug || gameSlug === 'default') return;
    try {
      const dirs: string[] = [];
      for (const root of assetRoots) {
        const treePath = resolveGamePath(root);
        const r = await fetch(`/api/files/tree?root=${encodeURIComponent(treePath)}&optional=1`, { cache: 'no-store' });
        if (!r.ok) continue;
        const j = (await r.json()) as { tree?: { children?: { name: string; path: string; type: string; children?: unknown[] }[] } | null };
        if (!j.tree?.children) continue;
        const walk = (nodes: { name: string; path: string; type: string; children?: unknown[] }[], prefix: string) => {
          for (const node of nodes) {
            if (node.type !== 'dir') continue;
            const rel = prefix ? `${prefix}/${node.name}` : node.name;
            dirs.push(rel);
            if (Array.isArray(node.children)) {
              walk(node.children as typeof nodes, rel);
            }
          }
        };
        walk(j.tree.children as { name: string; path: string; type: string; children?: unknown[] }[], root);
      }
      setDiskDirs(dirs);
    } catch { /* silent */ }
  }, [gameSlug, assetRoots]);

  useEffect(() => { void fetchDiskDirs(); }, [fetchDiskDirs]);

  useEffect(() => {
    // D5: 200ms debounce — merge consecutive in-process assetsChanged signals
    // into one reload + fetchDiskDirs. directory-only hint skips reload (no pack
    // change). This is PanelBridge, not a same-window VAG postMessage copy: the
    // editor is single realm and assetsChanged is a notification, not an op.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = panelBridge.on('assetsChanged', ({ hint }) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        // 'directory-only' means only folder CRUD — fetchDiskDirs is enough.
        if (hint !== 'directory-only') {
          reload();
        }
        void fetchDiskDirs();
      }, 200);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [reload, fetchDiskDirs]);

  // Scope the catalog to THIS game's declared asset roots. Each kept entry
  // carries its game-relative path (`assets/characters/x.pack.json`), which
  // drives both the folder tree and path navigation. Foreign entries (no
  // `<slug>` segment) and out-of-root entries (e.g. scenes/) are dropped, so the
  // Asset panel never exposes folders outside `forgeax-games/<slug>/<root>`.
  const scopedAssets = useMemo(() => {
    const out: { asset: CBAsset; rel: string }[] = [];
    for (const a of allAssets) {
      const rel = toGameRelative(a.packPath, gameSlug);
      if (!rel) continue;
      const top = rel.split('/')[0] ?? '';
      if (!assetRoots.includes(top)) continue;
      out.push({ asset: a, rel });
    }
    return out;
  }, [allAssets, gameSlug, assetRoots]);

  const packDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const { rel } of scopedAssets) {
      const dir = rel.replace(/\/[^/]+$/, '');
      if (!dir || dir === rel) continue;
      let cur = dir;
      while (cur) {
        dirs.add(cur);
        const slash = cur.lastIndexOf('/');
        cur = slash > 0 ? cur.slice(0, slash) : '';
      }
    }
    for (const d of diskDirs) dirs.add(d);
    return [...dirs].sort();
  }, [scopedAssets, diskDirs]);

  // UE-parity: a folder shows its IMMEDIATE subfolders + the assets sitting
  // directly in it (non-recursive). Folders are derived from the same rels the
  // source panel uses — no new persisted data format.
  const { folders: foldersInPath, assets: assetsInPath } = useMemo(
    () => deriveContentView({
      scopedAssets,
      packDirs,
      currentPath: nav.currentPath,
      favorites: favorites.favorites,
    }),
    [scopedAssets, packDirs, nav.currentPath, favorites.favorites],
  );

  // Filter + sort apply to assets only; folders always render first (UE-style),
  // sorted by name (deriveContentView already sorts them).
  const filteredAssets = useMemo(() => filter.applyFilters(assetsInPath), [filter, assetsInPath]);
  const sortedAssets = useMemo(() => sort.sortItems(filteredAssets), [sort, filteredAssets]);

  // Single ordered array shared by the view AND multi-select — handleClick
  // resolves items by flat index, so both must see the same order.
  const viewItems = useMemo<CBViewItem[]>(
    () => [...foldersInPath, ...sortedAssets],
    [foldersInPath, sortedAssets],
  );

  const multiSelect = useMultiSelect(viewItems);

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
      const rel = toGameRelative(asset.packPath, gameSlug);
      const entry = rel ? getSceneList().find(s => s.pack === rel) : undefined;
      if (entry) {
        gateway.dispatch({ kind: 'switchSceneFile', id: entry.id });
      }
    }
  }, [gameSlug]);

  // Double-click: drill into a folder, or open an asset.
  const handleActivate = useCallback((item: CBViewItem) => {
    if (item.type === 'folder') { nav.navigate(item.path); return; }
    openAsset(item);
  }, [nav, openAsset]);

  const crudCallbacks: CRUDCallbacks = useMemo(() => ({
    onReload: reload,
    onDelete: requestDelete,
    onRename: (asset: CBAsset) => {
      const newName = window.prompt('Rename asset:', asset.name);
      if (newName && newName !== asset.name) {
        // D6: rename routes through the ONE gateway door (document op, undoable).
        // The applier reaches pack IO via ctx.assetIO and fires the in-process
        // assetsChanged notification; the Content Browser listener reloads.
        gateway.dispatch({ kind: 'renameAsset', packPath: asset.packPath, guid: asset.guid, newName, oldName: asset.name }, 'human');
      }
    },
    onNewFolder: (parentPath: string) => {
      const name = window.prompt('New folder name:');
      if (!name) return;
      gateway.dispatch({ kind: 'createDirectory', parentPath, name }, 'human');
    },
  }), [reload, requestDelete]);

  const handleContextMenu = useCallback((e: React.MouseEvent, item: CBViewItem) => {
    e.preventDefault();
    e.stopPropagation();
    const pos = { clientX: e.clientX, clientY: e.clientY, preventDefault: () => {} };
    if (item.type === 'folder') {
      const folder = item;
      const assetsInFolder = scopedAssets
        .filter(s => s.rel === folder.path || s.rel.startsWith(`${folder.path}/`))
        .map(s => s.asset);
      const menuItems = buildFolderContextMenu(folder, assetsInFolder, crudCallbacks);
      const resolved = resolveFolderMenuItems(menuItems, {
        onOpen: () => nav.navigate(folder.path),
        onToggleFavorite: () => favorites.toggleFavorite(folder.path),
        unsupportedIds: ['rename'],
      });
      if (resolved.length === 0) return;
      setTimeout(() => showContextMenu(pos, resolved), 0);
      return;
    }
    const asset = item;
    const menuItems = buildAssetContextMenu(asset, multiSelect.selection, allAssets, crudCallbacks);
    const resolved = menuItems.filter(m => !m.separator).map(m => ({
      label: m.label,
      onClick: m.action,
      disabled: m.disabled,
    }));
    if (resolved.length === 0) return;
    setTimeout(() => showContextMenu(pos, resolved), 0);
  }, [multiSelect.selection, allAssets, crudCallbacks, scopedAssets, nav, favorites]);

  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      multiSelect.clearSelection();
    }
  }, [multiSelect]);

  const handleBlankContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const pos = { clientX: e.clientX, clientY: e.clientY, preventDefault: () => {} };
    const menuItems = buildBlankAreaContextMenu(nav.currentPath, (parentPath) => {
      const name = window.prompt('New folder name:');
      if (!name) return;
      gateway.dispatch({ kind: 'createDirectory', parentPath, name }, 'human');
    });
    const resolved = menuItems.map(m => ({
      label: m.label,
      onClick: m.action,
      disabled: m.disabled,
    }));
    setTimeout(() => showContextMenu(pos, resolved), 0);
  }, [nav.currentPath]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey) || viewMode !== 'grid') return;
    e.preventDefault();
    setThumbnailSize(prev => Math.max(48, Math.min(200, prev - Math.sign(e.deltaY) * 8)));
  }, [viewMode]);

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
      <CBToolbar currentPath={nav.currentPath} onReload={reload} onImportProgress={setImportProgress} />
      {noGame ? (
        <div style={{ padding: 16, opacity: 0.6, textAlign: 'center', marginTop: 32 }}>
          Open a game to browse assets
        </div>
      ) : (
        <div className="cb-split" ref={splitRef} style={{ ['--cb-src-w' as string]: `${srcWidth}px` }}>
          {/* Left: Source panel — width reads the --cb-src-w CSS variable on the
              parent (set by React on commit, by the drag handle imperatively). */}
          <div className="cb-source-panel">
            {favorites.favorites.length > 0 && (
              <div className="cb-source-section">
                <div className="cb-source-title">★ Favorites</div>
                {favorites.favorites.map(path => (
                  <button key={path} className={`cb-source-item${nav.currentPath === path ? ' sel' : ''}`}
                    onClick={() => nav.navigate(path)} title={path}>
                    {path.split('/').pop() || path}
                  </button>
                ))}
              </div>
            )}
            <div className="cb-source-section">
              <div className="cb-source-title">{gameSlug}</div>
              <button className={`cb-source-item${!nav.currentPath ? ' sel' : ''}`}
                onClick={() => nav.navigate('')}>
                All
              </button>
              {packDirs.map(dir => (
                <button key={dir} className={`cb-source-item${nav.currentPath === dir ? ' sel' : ''}`}
                  onClick={() => nav.navigate(dir)}
                  title={dir}
                  style={{ paddingLeft: `${8 + dir.split('/').length * 8}px` }}>
                  📁 {dir.split('/').pop()}
                </button>
              ))}
            </div>
          </div>

          {/* Draggable divider (UE-parity): widen the tree to read long paths. */}
          <ResizeHandle orientation="col" onDrag={onSplitDrag} onDragEnd={onSplitDragEnd}
            title="Drag to resize folder tree width" />

          {/* Right: Asset view */}
          <div className="cb-asset-view" onClick={handleContainerClick} onContextMenu={handleBlankContextMenu}>
            <CBNavigationBar nav={nav} gameSlug={gameSlug} />
            <CBFilterBar filter={filter} sort={sort} viewMode={viewMode} onViewModeChange={setViewMode}
              thumbnailSize={thumbnailSize} onThumbnailSizeChange={setThumbnailSize} />
            {loading ? (
              <div style={{ padding: 16, opacity: 0.5 }}>Loading assets…</div>
            ) : viewItems.length === 0 ? (
              <div style={{ padding: 16, opacity: 0.5 }}>
                {filter.activeFilterCount > 0 || filter.searchQuery ? 'No matching assets' : 'No assets found'}
              </div>
            ) : viewMode === 'grid' ? (
              <CBGrid
                items={viewItems}
                thumbnailSize={thumbnailSize}
                multiSelect={multiSelect}
                onDoubleClick={handleActivate}
                onContextMenu={handleContextMenu}
              />
            ) : viewMode === 'list' ? (
              <CBList
                items={viewItems}
                multiSelect={multiSelect}
                onDoubleClick={handleActivate}
                onContextMenu={handleContextMenu}
              />
            ) : (
              <CBColumn
                items={viewItems}
                multiSelect={multiSelect}
                sort={sort}
                onDoubleClick={handleActivate}
                onContextMenu={handleContextMenu}
              />
            )}
            <CBStatusBar totalItems={viewItems.length} selection={multiSelect.selection} />
          </div>
        </div>
      )}

      {importProgress && (
        <div className="cb-import-progress">
          <span className="cb-import-progress-text">
            {importProgress.completed < importProgress.total
              ? `Importing ${importProgress.completed + 1}/${importProgress.total}: ${importProgress.current}`
              : `Import complete: ${importProgress.results.filter(r => r.status === 'done').length}/${importProgress.total} succeeded`}
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
          <div className="cb-drag-overlay-label">Drop files to import</div>
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
