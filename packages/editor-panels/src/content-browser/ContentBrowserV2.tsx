import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadGameAssets, type PackAsset } from '@forgeax/editor-core';
import { getSceneId, setAssetSelection, showContextMenu, useDocVersion,
  renameAssetInPack, duplicateAssetInPack, deleteAsset, broadcastAssetsChanged, createDirectory } from '@forgeax/editor-shared';
import { useMultiSelect } from './hooks/useMultiSelect';
import { useSort } from './hooks/useSort';
import { useFilter } from './hooks/useFilter';
import { useNavHistory } from './hooks/useNavHistory';
import { buildAssetContextMenu, type CRUDCallbacks } from './CBContextMenu';
import { CBFilterBar } from './CBFilterBar';
import { CBNavigationBar } from './CBNavigationBar';
import { CBGrid } from './CBGrid';
import { CBList } from './CBList';
import { CBColumn } from './CBColumn';
import { CBStatusBar } from './CBStatusBar';
import { CBToolbar } from './CBToolbar';
import type { CBAsset, CBViewMode } from './types';
import './content-browser.css';

function packAssetToCBAsset(pa: PackAsset, index: number): CBAsset {
  return {
    type: 'asset',
    guid: pa.guid,
    kind: pa.kind,
    name: pa.name,
    payload: pa.payload,
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
  const nav = useNavHistory();
  const filter = useFilter();
  const sort = useSort();

  const reload = useCallback(() => {
    const slug = getSceneId();
    if (!slug || slug === 'default') return;
    setLoading(true);
    void loadGameAssets(slug).then(assets => {
      setAllAssets(assets.map(packAssetToCBAsset));
      setLoading(false);
    });
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const assetsInPath = useMemo(() => {
    if (!nav.currentPath) return allAssets;
    const prefix = nav.currentPath;
    return allAssets.filter(a => a.packPath.includes(prefix));
  }, [allAssets, nav.currentPath]);

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
      const slug = getSceneId();
      const fullPath = `.forgeax/games/${slug}/${parentPath ? parentPath + '/' : ''}${name}`;
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

  if (!gameSlug || gameSlug === 'default') {
    return <div className="cb-root"><div style={{ padding: 16, opacity: 0.5 }}>No game open</div></div>;
  }

  return (
    <div className="cb-root" onClick={handleContainerClick} onWheel={handleWheel}>
      <CBToolbar currentPath={nav.currentPath} onReload={reload} />
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
  );
}
