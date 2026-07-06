import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, bus, getSceneId, resolveGamePath, setAssetSelection, showContextMenu, useDocVersion,
  renameAssetInPack, duplicateAssetInPack, deleteAsset, broadcastAssetsChanged, createDirectory } from '@forgeax/editor-core';
import { useMultiSelect } from './hooks/useMultiSelect';
import { useSort } from './hooks/useSort';
import { useFilter } from './hooks/useFilter';
import { useNavHistory } from './hooks/useNavHistory';
import { useFavorites } from './hooks/useFavorites';
import { buildAssetContextMenu, type CRUDCallbacks } from './CBContextMenu';
import { CBFilterBar } from './CBFilterBar';
import { CBNavigationBar } from './CBNavigationBar';
import { CBGrid } from './CBGrid';
import { CBList } from './CBList';
import { CBColumn } from './CBColumn';
import { CBStatusBar } from './CBStatusBar';
import { CBToolbar } from './CBToolbar';
import { importFiles, type ImportProgress } from './import-pipeline';
import { isImportable, buildAcceptString, logImport } from './import-registry';
import type { CBAsset, CBViewMode } from './types';
import './content-browser.css';

// M3: single-realm — registry.listCatalog() replaces loadGameAssets/loadMetaAssets
// (plan-strategy S2 D1, S3.1 component map, requirements AC-03).
// The engine AssetRegistry is the SSOT for asset enumeration; the ContentBrowser
// reads directly from it via bus.doc.registry.listCatalog().
// registry entries carry {guid, kind, name?, relativeUrl} — no payload/packPath,
// so import-mode filtering and payload-derived fields are removed.

function registryEntryToCBAsset(
  e: { guid: string; kind: string; name?: string; relativeUrl: string },
  index: number,
): CBAsset {
  // Use relativeUrl as a proxy for packPath for folder-tree navigation.
  // CRUD operations on disk packs use this to locate the .pack.json.
  return {
    type: 'asset',
    guid: e.guid,
    kind: e.kind,
    name: e.name ?? e.guid.slice(0, 8),
    payload: {},
    packPath: e.relativeUrl,
    packIndex: index,
    refs: [],
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
  const gameSlug = getSceneId();
  const [allAssets, setAllAssets] = useState<CBAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<CBViewMode>('grid');
  const [thumbnailSize, setThumbnailSize] = useState(80);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const nav = useNavHistory();
  const filter = useFilter();
  const sort = useSort();
  const favorites = useFavorites();
  // The Asset panel's folder tree is scoped to the game's DECLARED asset roots
  // (game package.json `forgeax.assets.roots`, e.g. ["assets"]) — NOT the whole
  // engine catalog, which also folds in scenes/ + shared template roots (needed
  // by runtime loadByGuid, but not browsable game assets). Default to ["assets"]
  // until the game's package.json is read.
  const [assetRoots, setAssetRoots] = useState<string[]>(['assets']);

  const reload = useCallback(() => {
    const slug = getSceneId();
    if (!slug || slug === 'default') return;
    setLoading(true);
    // M3: registry.listCatalog() replaces parallel-disk-scan loadGameAssets/loadMetaAssets.
    // The engine AssetRegistry is the SSOT — asset panel truth = engine truth (AC-03).
    const registry = bus.doc.registry as { listCatalog?: () => readonly { guid: string; kind: string; name?: string; relativeUrl: string }[] } | undefined;
    const entries = registry?.listCatalog?.();
    if (!entries || entries.length === 0) {
      setAllAssets([]);
      setLoading(false);
    } else {
      const catalog = entries.map(registryEntryToCBAsset);
      setAllAssets(catalog);
      setLoading(false);
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
        const r = await apiFetch(
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

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'VAG_ASSETS_CHANGED') reload();
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [reload]);

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
    return [...dirs].sort();
  }, [scopedAssets]);

  const assetsInPath = useMemo(() => {
    if (!nav.currentPath) return scopedAssets.map((s) => s.asset);
    const p = nav.currentPath;
    return scopedAssets
      .filter((s) => s.rel === p || s.rel.startsWith(`${p}/`))
      .map((s) => s.asset);
  }, [scopedAssets, nav.currentPath]);

  const filteredAssets = useMemo(() => filter.applyFilters(assetsInPath), [filter, assetsInPath]);
  const sortedAssets = useMemo(() => sort.sortItems(filteredAssets), [sort, filteredAssets]);

  const multiSelect = useMultiSelect(sortedAssets);

  const handleDoubleClick = useCallback((asset: CBAsset) => {
    setAssetSelection({
      guid: asset.guid,
      kind: asset.kind,
      name: asset.name,
      payload: asset.payload,
      packPath: asset.packPath,
    });
    // Double-clicking a mesh asset surfaces its data: ask the studio shell to
    // bring the Mesh panel to front (focus-only — the shell never force-inserts a
    // closed tab). Harmless in standalone/pop-out where no shell listens.
    // Design: docs/design/editor-mesh-panel-ue58-parity.md §7.1.
    if (asset.kind === 'mesh') {
      try { window.parent?.postMessage({ type: 'FORGEAX_FOCUS_PANEL', panel: 'mesh' }, '*'); } catch { /* cross-origin — non-fatal */ }
    }
  }, []);

  const crudCallbacks: CRUDCallbacks = useMemo(() => ({
    onReload: reload,
    onRename: (asset: CBAsset) => {
      const newName = window.prompt('Rename asset:', asset.name);
      if (newName && newName !== asset.name) {
        void renameAssetInPack(asset.packPath, asset.guid, newName).then(ok => {
          if (ok) { broadcastAssetsChanged(); reload(); }
        });
      }
    },
    onNewFolder: (parentPath: string) => {
      const name = window.prompt('New folder name:');
      if (!name) return;
      const fullPath = resolveGamePath(`${parentPath ? parentPath + '/' : ''}${name}`);
      void createDirectory(fullPath).then(ok => {
        if (ok) reload();
      });
    },
  }), [reload]);

  const handleContextMenu = useCallback((e: React.MouseEvent, asset: CBAsset) => {
    e.preventDefault();
    e.stopPropagation();
    const menuItems = buildAssetContextMenu(asset, multiSelect.selection, allAssets, crudCallbacks);
    const items = menuItems.filter(m => !m.separator).map(m => ({
      label: m.label,
      onClick: m.action,
      disabled: m.disabled,
    }));
    if (items.length === 0) return;
    showContextMenu(e, items);
  }, [multiSelect.selection, allAssets, crudCallbacks]);

  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      multiSelect.clearSelection();
    }
  }, [multiSelect]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        multiSelect.selectAll();
        return;
      }
      const primary = multiSelect.selection.primary;
      if (!primary || primary.type !== 'asset') return;
      const asset = primary as CBAsset;

      if (e.key === 'F2') {
        e.preventDefault();
        crudCallbacks.onRename?.(asset);
      } else if (e.key === 'Delete') {
        e.preventDefault();
        const selectedAssets = multiSelect.selection.items.filter((i): i is CBAsset => i.type === 'asset');
        const targets = selectedAssets.length > 0 ? selectedAssets : [asset];
        const names = targets.map(a => a.name).join(', ');
        if (!window.confirm(`Delete ${targets.length} asset(s)?\n${names}`)) return;
        for (const a of targets) {
          void deleteAsset(a.packPath, a.guid).then(ok => {
            if (ok) { broadcastAssetsChanged(); reload(); }
          });
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        e.preventDefault();
        const selectedAssets = multiSelect.selection.items.filter((i): i is CBAsset => i.type === 'asset');
        const targets = selectedAssets.length > 0 ? selectedAssets : [asset];
        for (const a of targets) {
          void duplicateAssetInPack(a.packPath, a.guid).then(({ ok }) => {
            if (ok) { broadcastAssetsChanged(); reload(); }
          });
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [multiSelect, crudCallbacks, reload]);

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
        <div className="cb-split">
          {/* Left: Source panel */}
          <div className="cb-source-panel">
            {favorites.favorites.length > 0 && (
              <div className="cb-source-section">
                <div className="cb-source-title">★ Favorites</div>
                {favorites.favorites.map(path => (
                  <button key={path} className={`cb-source-item${nav.currentPath === path ? ' sel' : ''}`}
                    onClick={() => nav.navigate(path)}>
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
                  style={{ paddingLeft: `${8 + dir.split('/').length * 8}px` }}>
                  📁 {dir.split('/').pop()}
                </button>
              ))}
            </div>
          </div>

          {/* Right: Asset view */}
          <div className="cb-asset-view" onClick={handleContainerClick}>
            <CBNavigationBar nav={nav} gameSlug={gameSlug} />
            <CBFilterBar filter={filter} sort={sort} viewMode={viewMode} onViewModeChange={setViewMode}
              thumbnailSize={thumbnailSize} onThumbnailSizeChange={setThumbnailSize} />
            {loading ? (
              <div style={{ padding: 16, opacity: 0.5 }}>Loading assets…</div>
            ) : sortedAssets.length === 0 ? (
              <div style={{ padding: 16, opacity: 0.5 }}>
                {filter.activeFilterCount > 0 || filter.searchQuery ? 'No matching assets' : 'No assets found'}
              </div>
            ) : viewMode === 'grid' ? (
              <CBGrid
                items={sortedAssets}
                thumbnailSize={thumbnailSize}
                multiSelect={multiSelect}
                onDoubleClick={handleDoubleClick}
                onContextMenu={handleContextMenu}
              />
            ) : viewMode === 'list' ? (
              <CBList
                items={sortedAssets}
                multiSelect={multiSelect}
                onDoubleClick={handleDoubleClick}
                onContextMenu={handleContextMenu}
              />
            ) : (
              <CBColumn
                items={sortedAssets}
                multiSelect={multiSelect}
                sort={sort}
                onDoubleClick={handleDoubleClick}
                onContextMenu={handleContextMenu}
              />
            )}
            <CBStatusBar totalItems={sortedAssets.length} selection={multiSelect.selection} />
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
    </div>
  );
}
