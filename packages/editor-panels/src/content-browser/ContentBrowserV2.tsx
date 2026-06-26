import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadGameAssets, loadMetaAssets, type PackAsset } from '@forgeax/editor-core';
import { getSceneId, resolveGamePath, setAssetSelection, showContextMenu, useDocVersion,
  renameAssetInPack, duplicateAssetInPack, deleteAsset, broadcastAssetsChanged, createDirectory } from '@forgeax/editor-shared';
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
import { isImportable } from './import-registry';
import type { CBAsset, CBViewMode } from './types';
import './content-browser.css';

// D-7 (§4): present meta sub-assets according to their import mode. A pack
// imported as 'whole' shows ONLY its `scene` resource at top level (the
// mesh/material/texture children are internal deps — still loadable by GUID for
// drag/refs, just not flattened into the browser). 'split' (or legacy/missing)
// flattens every sub-asset. Grouped by packPath since one .meta.json == one pack.
function filterByImportMode(assets: PackAsset[]): PackAsset[] {
  const modeByPack = new Map<string, string>();
  for (const a of assets) {
    const mode = (a.payload?.importSettings as { importMode?: unknown } | undefined)?.importMode;
    if (typeof mode === 'string') modeByPack.set(a.packPath, mode);
  }
  return assets.filter((a) => {
    if (modeByPack.get(a.packPath) !== 'whole') return true;
    return a.kind === 'scene';
  });
}

function packAssetToCBAsset(pa: PackAsset, index: number): CBAsset {
  return {
    type: 'asset',
    guid: pa.guid,
    kind: pa.kind,
    name: pa.name,
    payload: { ...pa.payload, _packPath: pa.packPath },
    packPath: pa.packPath,
    packIndex: index,
    refs: [],
    estimatedSize: JSON.stringify(pa.payload).length,
  };
}

export function ContentBrowserV2() {
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

  const reload = useCallback(() => {
    const slug = getSceneId();
    if (!slug || slug === 'default') return;
    setLoading(true);
    void Promise.all([loadGameAssets(slug), loadMetaAssets(slug)]).then(([packAssets, metaAssets]) => {
      const pack = packAssets.map(packAssetToCBAsset);
      const meta = filterByImportMode(metaAssets).map(packAssetToCBAsset);
      const seen = new Set(pack.map((a: CBAsset) => a.guid));
      const merged = [...pack, ...meta.filter((a: CBAsset) => !seen.has(a.guid))];
      setAllAssets(merged);
      setLoading(false);
    });
  }, []);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'VAG_ASSETS_CHANGED') reload();
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [reload]);

  // Host-resolved game root (with trailing slash) — used to strip the absolute
  // packPath prefix back to a game-relative path for the folder tree.
  const gameRoot = resolveGamePath('');
  const gamePrefix = gameRoot.endsWith('/') ? gameRoot : `${gameRoot}/`;

  const packDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const a of allAssets) {
      const rel = a.packPath.startsWith(gamePrefix)
        ? a.packPath.slice(gamePrefix.length)
        : a.packPath;
      const dir = rel.replace(/\/[^/]+$/, '');
      if (!dir) continue;
      let cur = dir;
      while (cur) {
        dirs.add(cur);
        const slash = cur.lastIndexOf('/');
        cur = slash > 0 ? cur.slice(0, slash) : '';
      }
    }
    return [...dirs].sort();
  }, [allAssets, gamePrefix]);

  const assetsInPath = useMemo(() => {
    if (!nav.currentPath) return allAssets;
    const fullPrefix = gamePrefix + nav.currentPath;
    return allAssets.filter(a => a.packPath.startsWith(fullPrefix + '/') || a.packPath.startsWith(fullPrefix));
  }, [allAssets, nav.currentPath, gamePrefix]);

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
    const menuItems = buildAssetContextMenu(asset, multiSelect.selection, allAssets, crudCallbacks);
    showContextMenu(e, menuItems.filter(m => !m.separator).map(m => ({
      label: m.label,
      onClick: m.action,
      disabled: m.disabled,
    })));
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
    const files = Array.from(e.dataTransfer.files).filter(f => isImportable(f.name));
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
