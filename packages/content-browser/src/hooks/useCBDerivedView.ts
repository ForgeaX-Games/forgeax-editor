// useCBDerivedView — memoized selectors that transform the raw catalog + disk
// tree + user state into what the Content Browser renders.
//
// All the useMemo chains that used to sit inline in ContentBrowser.tsx live
// here so the component file is short and the memo dep-DAG is inspectable in
// one place. Asset/tree/sidecar acquisition is owned by the core read model;
// this hook only derives the render projection and preserves UI state.

import { useCallback, useMemo } from 'react';
import { resolveGamePath } from '@forgeax/editor-core';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { deriveContentView } from '../folder-view';
import { catalogPathToRoot, type CatalogAssetRoot } from '../catalog-root';
import { resolveViewMode, type CBViewMode2 } from '../view-mode';
import {
  dirOfPath,
  fileFamilyOfWithAssets,
  fileKindLabel,
  normalizeGameRelativePath,
  type DiskTreeNode,
  type SourceTreeNode,
} from '../content-browser-format';
import type { CBAsset, CBFile, CBFolder, CBViewItem } from '../types';
import type { FavoritesAPI } from './useFavorites';
import type { FilterAPI } from './useFilter';
import type { SortAPI } from './useSort';
import type { NavHistoryAPI } from './useNavHistory';

export interface CBDerivedViewInputs {
  allAssets: CBAsset[];
  gameSlug: string;
  diskTree: DiskTreeNode | null;
  catalogAssetRoots: readonly CatalogAssetRoot[];
  favorites: FavoritesAPI;
  favoritesOnly: boolean;
  filter: FilterAPI;
  sort: SortAPI;
  nav: NavHistoryAPI;
  expandedPacks: Set<string>;
}

export interface CBDerivedView {
  scopedAssets: { asset: CBAsset; rel: string }[];
  relByAssetGuid: Map<string, string>;
  diskFiles: CBFile[];
  viewMode: CBViewMode2;
  sourceTree: SourceTreeNode[];
  foldersInPath: CBFolder[];
  visibleFoldersInPath: CBFolder[];
  filesInPath: CBFile[];
  sortedAssets: CBAsset[];
  registryOnlyAssets: CBAsset[];
  viewItems: CBViewItem[];
}

export function useCBDerivedView(inputs: CBDerivedViewInputs): CBDerivedView {
  const { allAssets, gameSlug, diskTree, catalogAssetRoots, favorites, favoritesOnly, filter, sort, nav, expandedPacks } = inputs;
  const { t } = useTranslation();

  // Scope the catalog to THIS game's declared asset roots. Each kept entry
  // carries its game-relative path (`assets/characters/x.pack.json`), which
  // drives both the folder tree and path navigation. Foreign entries (no
  // `<slug>` segment) and out-of-root entries (e.g. scenes/) are dropped, so
  // the Asset panel never exposes folders outside `forgeax-games/<slug>/<root>`.
  const scopedAssets = useMemo(() => {
    const out: { asset: CBAsset; rel: string }[] = [];
    for (const a of allAssets) {
      // External/imported assets belong to their engine-owned sidecar. The
      // author source remains a sibling file; for UI this is especially
      // important: `hud.meta.json` owns the UI asset while `.ui.html/.ui.css`
      // are only authoring inputs.
      const rel = catalogPathToRoot(a.kind === 'ui' ? a.packPath : (a.sourcePath ?? a.packPath), gameSlug, catalogAssetRoots);
      if (!rel) continue;
      out.push({ asset: a, rel });
    }
    return out;
  }, [allAssets, gameSlug, catalogAssetRoots]);

  const assetsByRel = useMemo(() => {
    const map = new Map<string, CBAsset[]>();
    for (const scoped of scopedAssets) {
      const list = map.get(scoped.rel) ?? [];
      list.push(scoped.asset);
      map.set(scoped.rel, list);
    }
    return map;
  }, [scopedAssets]);

  const relByAssetGuid = useMemo(() => {
    const map = new Map<string, string>();
    for (const scoped of scopedAssets) map.set(scoped.asset.guid, scoped.rel);
    return map;
  }, [scopedAssets]);

  const diskFiles = useMemo<CBFile[]>(() => {
    if (!diskTree) return [];
    const gameRootPath = resolveGamePath('');
    const files: CBFile[] = [];
    const walk = (node: DiskTreeNode) => {
      const rel = normalizeGameRelativePath(node.path, gameRootPath, gameSlug);
      if (node.type === 'file' && rel) {
        // #292: fall back to the `<rel>.meta.json` sidecar so meta-backed disk
        // files still surface their engine asset(s).
        const assets = assetsByRel.get(rel) ?? assetsByRel.get(`${rel}.meta.json`) ?? [];
        // Scene family is derived from the catalog `kind`, not the filename, so
        // it stays aligned with findAllScenePacks / getSceneList.
        const family = fileFamilyOfWithAssets(node.name, assets);
        files.push({
          type: 'file',
          path: rel,
          diskPath: node.path,
          name: node.name,
          family,
          assets,
          kindLabel: fileKindLabel(t, family),
          isFavorite: favorites.isFavorite({ kind: 'path', path: rel }),
        });
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(diskTree);
    return files.sort((a, b) => a.path.localeCompare(b.path));
    // Depend on `favorites.isFavorite` (a useCallback stable per favorites-array),
    // NOT the whole `favorites` API object — useFavorites returns a fresh object
    // literal every render, so depending on it would rebuild this list (and every
    // CBFile object in it) on EVERY render, defeating the leaf memo downstream.
  }, [assetsByRel, diskTree, favorites.isFavorite, gameSlug, t]);

  const diskDirs = useMemo(() => {
    if (!diskTree) return [];
    const gameRootPath = resolveGamePath('');
    const dirs: string[] = [];
    const walk = (node: DiskTreeNode) => {
      const rel = normalizeGameRelativePath(node.path, gameRootPath, gameSlug);
      if (node.type === 'dir' && rel) dirs.push(rel);
      for (const child of node.children ?? []) walk(child);
    };
    walk(diskTree);
    return dirs.sort();
  }, [diskTree, gameSlug]);

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

  const viewMode: CBViewMode2 = useMemo(
    () => resolveViewMode(nav.currentPath, catalogAssetRoots),
    [nav.currentPath, catalogAssetRoots],
  );

  const sourceTree = useMemo<SourceTreeNode[]>(() => {
    if (diskTree) {
      const gameRootPath = resolveGamePath('');
      const fromDisk = (node: DiskTreeNode): SourceTreeNode | null => {
        const rel = normalizeGameRelativePath(node.path, gameRootPath, gameSlug);
        if (!rel && node !== diskTree) return null;
        if (node.type === 'file') {
          const assets = assetsByRel.get(rel) ?? assetsByRel.get(`${rel}.meta.json`) ?? [];
          const family = fileFamilyOfWithAssets(node.name, assets);
          return {
            type: 'file',
            path: rel,
            diskPath: node.path,
            name: node.name,
            childCount: assets.length,
            isFavorite: favorites.isFavorite({ kind: 'path', path: rel }),
            family,
            assets,
            children: [],
          };
        }
        const children = (node.children ?? [])
          .map(fromDisk)
          .filter((child): child is SourceTreeNode => Boolean(child));
        if (!rel) return children.length === 1 ? (children[0] ?? null) : {
          type: 'folder',
          path: '',
          diskPath: node.path,
          name: node.name,
          childCount: scopedAssets.length,
          isFavorite: false,
          children,
        };
        return {
          type: 'folder',
          path: rel,
          diskPath: node.path,
          name: node.name,
          childCount: scopedAssets.reduce(
            (count, scoped) => (scoped.rel === rel || scoped.rel.startsWith(`${rel}/`) ? count + 1 : count),
            0,
          ),
          isFavorite: favorites.isFavorite({ kind: 'path', path: rel }),
          children,
        };
      };
      const root = fromDisk(diskTree);
      return root?.path ? [root] : (root?.children ?? []);
    }

    const byPath = new Map<string, SourceTreeNode>();
    for (const path of packDirs) {
      byPath.set(path, {
        type: 'folder',
        path,
        diskPath: resolveGamePath(path),
        name: path.split('/').pop() ?? path,
        isFavorite: favorites.isFavorite({ kind: 'path', path }),
        childCount: scopedAssets.reduce(
          (count, scoped) => (scoped.rel === path || scoped.rel.startsWith(`${path}/`) ? count + 1 : count),
          0,
        ),
        children: [],
      });
    }

    const roots: SourceTreeNode[] = [];
    for (const node of byPath.values()) {
      const slash = node.path.lastIndexOf('/');
      const parentPath = slash > 0 ? node.path.slice(0, slash) : '';
      const parent = parentPath ? byPath.get(parentPath) : undefined;
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }

    const sortTree = (nodes: SourceTreeNode[]) => {
      nodes.sort((a, b) => a.name.localeCompare(b.name));
      for (const node of nodes) sortTree(node.children);
    };
    sortTree(roots);
    return roots;
    // Same rationale as diskFiles: depend on the stable `isFavorite` fn, not the
    // fresh-every-render API object.
  }, [assetsByRel, diskTree, favorites.isFavorite, gameSlug, packDirs, scopedAssets]);

  // UE-parity: a folder shows its IMMEDIATE subfolders + the assets sitting
  // directly in it (non-recursive). Folders are derived from the same rels the
  // source panel uses — no new persisted data format.
  const { folders: foldersInPath, assets: assetsInPath } = useMemo(
    () => deriveContentView({
      scopedAssets,
      packDirs,
      currentPath: nav.currentPath,
      isFavoriteFolder: path => favorites.isFavorite({ kind: 'path', path }),
    }),
    [scopedAssets, packDirs, nav.currentPath, favorites.isFavorite],
  );

  const visibleFoldersInPath = useMemo(
    () => {
      const q = filter.searchQuery.trim().toLowerCase();
      return foldersInPath
        .filter(() => filter.matchesFolder())
        .filter(folder => !favoritesOnly || folder.isFavorite)
        .filter(folder => {
          if (!q) return true;
          const folderPrefix = `${folder.path}/`;
          return (
            folder.name.toLowerCase().includes(q) ||
            folder.path.toLowerCase().includes(q) ||
            diskFiles.some(file => file.path.startsWith(folderPrefix) && (
              file.name.toLowerCase().includes(q) ||
              file.path.toLowerCase().includes(q) ||
              file.assets.some(asset => asset.name.toLowerCase().includes(q) || asset.kind.toLowerCase().includes(q))
            )) ||
            scopedAssets.some(({ asset, rel }) => rel.startsWith(folderPrefix) && (
              rel.toLowerCase().includes(q) ||
              asset.name.toLowerCase().includes(q) ||
              asset.kind.toLowerCase().includes(q)
            ))
          );
        });
    },
    [diskFiles, favoritesOnly, filter.matchesFolder, filter.searchQuery, foldersInPath, scopedAssets],
  );

  // Filter + sort apply to assets only; folders always render first (UE-style),
  // sorted by name (deriveContentView already sorts them).
  const favoriteFilteredAssets = useMemo(
    () => assetsInPath.filter(asset => !favoritesOnly || favorites.isFavorite({ kind: 'asset', guid: asset.guid })),
    [assetsInPath, favorites.isFavorite, favoritesOnly],
  );
  const filteredAssets = useMemo(() => filter.applyFilters(favoriteFilteredAssets), [filter, favoriteFilteredAssets]);
  const sortedAssets = useMemo(() => sort.sortItems(filteredAssets), [sort, filteredAssets]);

  const holdsFavoriteAsset = useCallback(
    (file: CBFile) => file.assets.some(asset => favorites.isFavorite({ kind: 'asset', guid: asset.guid })),
    [favorites.isFavorite],
  );

  // The grid reaches an asset only THROUGH its file (see viewItems), so under
  // "favorites only" a pack must also survive when it merely HOLDS a favorited
  // asset — otherwise starring a material would hide the material.
  const filesInPath = useMemo(() => {
    const q = filter.searchQuery.trim().toLowerCase();
    return diskFiles
      .filter(file => dirOfPath(file.path) === nav.currentPath)
      .filter(file => filter.matchesFile(file))
      .filter(file => !favoritesOnly || file.isFavorite || holdsFavoriteAsset(file))
      .filter(file => !q || file.name.toLowerCase().includes(q) || file.assets.some(asset => asset.name.toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [diskFiles, favoritesOnly, filter.matchesFile, filter.searchQuery, holdsFavoriteAsset, nav.currentPath]);

  // A file kept only for its contents lists just the favorited ones; a file that
  // is ITSELF the favorite lists all of them (the pack is what was starred).
  const nestedAssetsOf = useCallback((file: CBFile): CBAsset[] => (
    favoritesOnly && !file.isFavorite
      ? file.assets.filter(asset => favorites.isFavorite({ kind: 'asset', guid: asset.guid }))
      : file.assets
  ), [favorites.isFavorite, favoritesOnly]);

  const diskFilePaths = useMemo(() => new Set(diskFiles.map(file => file.path)), [diskFiles]);
  // Registry-only assets have no disk file, hence no file family — an active
  // family filter (spec is file-family based) can never match them, so drop
  // them whenever any filter is engaged.
  const registryOnlyAssets = useMemo(() => {
    if (filter.activeFilterCount > 0) return [];
    return sortedAssets.filter(asset => {
      const rel = scopedAssets.find(scoped => scoped.asset.guid === asset.guid)?.rel;
      return !rel || !diskFilePaths.has(rel);
    });
  }, [diskFilePaths, filter.activeFilterCount, scopedAssets, sortedAssets]);

  // Single ordered array shared by the view AND multi-select — handleClick
  // resolves items by flat index, so both must see the same order.
  //
  // viewMode === 'asset': folders + disk files + auto-expanded pack sub-assets.
  //
  // viewMode === 'file': folders + raw disk files; pack/meta files with
  // sub-assets can be manually toggled open via the chevron or double-click.
  const viewItems = useMemo<CBViewItem[]>(() => {
    const items: CBViewItem[] = [...visibleFoldersInPath];

    for (const file of filesInPath) {
      items.push(file);
      const expanded = viewMode === 'asset' || expandedPacks.has(file.path);
      if (!expanded || (file.family !== 'pack' && file.family !== 'meta' && file.family !== 'ui')) continue;
      items.push(...nestedAssetsOf(file));
    }
    items.push(...registryOnlyAssets);

    return items;
  }, [expandedPacks, filesInPath, nestedAssetsOf, registryOnlyAssets, viewMode, visibleFoldersInPath]);

  return {
    scopedAssets,
    relByAssetGuid,
    diskFiles,
    viewMode,
    sourceTree,
    foldersInPath,
    visibleFoldersInPath,
    filesInPath,
    sortedAssets,
    registryOnlyAssets,
    viewItems,
  };
}
