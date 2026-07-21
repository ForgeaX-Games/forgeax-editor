// useCBDerivedView — memoized selectors that transform the raw catalog + disk
// tree + user state into what the Content Browser renders.
//
// All the useMemo chains that used to sit inline in ContentBrowser.tsx live
// here so the component file is short and the memo dep-DAG is inspectable in
// one place. Also owns the .meta.json sidecar fetch that produces
// `metaAssetMap` — placed here because it depends on `diskFiles` (a derived
// value) and every consumer of metaAssetMap is derived.

import { useEffect, useMemo, useState } from 'react';
import { resolveGamePath } from '@forgeax/editor-core';
import { useTranslation } from '@forgeax/editor-core/i18n';
import { deriveContentView } from '../folder-view';
import { catalogPathToRoot, type CatalogAssetRoot } from '../catalog-root';
import { resolveViewMode, type CBViewMode2 } from '../view-mode';
import {
  dirOfPath,
  fileFamilyOf,
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
  metaSubAssetsInPath: CBAsset[];
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
      const rel = catalogPathToRoot(a.packPath, gameSlug, catalogAssetRoots);
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
        const family = fileFamilyOf(node.name);
        files.push({
          type: 'file',
          path: rel,
          diskPath: node.path,
          name: node.name,
          family,
          assets: assetsByRel.get(rel) ?? [],
          kindLabel: fileKindLabel(t, family),
          isFavorite: favorites.isFavorite(rel),
        });
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(diskTree);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }, [assetsByRel, diskTree, favorites, gameSlug, t]);

  // .meta.json sidecar fetch — a fallback to expose sub-assets when the engine
  // registry hasn't indexed the external-asset-package entries yet.
  const [metaAssetMap, setMetaAssetMap] = useState<Map<string, CBAsset[]>>(new Map());
  useEffect(() => {
    const metaFiles = diskFiles.filter(f => f.family === 'meta' && f.name.endsWith('.meta.json'));
    if (metaFiles.length === 0) {
      // Preserve empty Map identity to avoid pointless re-renders / filter rebuilds.
      setMetaAssetMap(prev => (prev.size === 0 ? prev : new Map()));
      return;
    }
    let cancelled = false;
    void (async () => {
      const result = new Map<string, CBAsset[]>();
      await Promise.all(metaFiles.map(async (mf) => {
        try {
          const r = await fetch(`/api/files/raw?path=${encodeURIComponent(mf.diskPath)}`, { cache: 'no-store' });
          if (!r.ok) return;
          const json = await r.json() as {
            kind?: string; source?: string; subAssets?: { guid: string; kind: string; sourceIndex?: number; name?: string }[];
          };
          if (json.kind !== 'external-asset-package' || !json.subAssets?.length) return;
          const sourceName = json.source ?? mf.name.replace(/\.meta\.json$/, '');
          const assets: CBAsset[] = json.subAssets.map((sub, idx) => ({
            type: 'asset' as const,
            guid: sub.guid,
            kind: sub.kind,
            name: sub.name ?? `${sourceName} · ${sub.kind}${sub.sourceIndex != null && sub.sourceIndex > 0 ? ` #${sub.sourceIndex}` : ''}`,
            payload: {},
            packPath: mf.path,
            packIndex: idx,
            refs: [],
            estimatedSize: 0,
          }));
          result.set(mf.path, assets);
        } catch { /* skip unreadable files */ }
      }));
      if (!cancelled) setMetaAssetMap(result);
    })();
    return () => { cancelled = true; };
  }, [diskFiles]);

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
          const family = fileFamilyOf(node.name);
          const assets = assetsByRel.get(rel) ?? [];
          return {
            type: 'file',
            path: rel,
            diskPath: node.path,
            name: node.name,
            childCount: assets.length,
            isFavorite: favorites.isFavorite(rel),
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
          isFavorite: favorites.isFavorite(rel),
          children,
        };
      };
      const root = fromDisk(diskTree);
      return root?.path ? [root] : (root?.children ?? []);
    }

    const favoriteSet = new Set(favorites.favorites);
    const byPath = new Map<string, SourceTreeNode>();
    for (const path of packDirs) {
      byPath.set(path, {
        type: 'folder',
        path,
        diskPath: resolveGamePath(path),
        name: path.split('/').pop() ?? path,
        isFavorite: favoriteSet.has(path),
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
  }, [assetsByRel, diskTree, favorites, gameSlug, packDirs, scopedAssets]);

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

  const visibleFoldersInPath = useMemo(
    () => {
      const q = filter.searchQuery.trim().toLowerCase();
      return foldersInPath
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
    [diskFiles, favoritesOnly, filter.searchQuery, foldersInPath, scopedAssets],
  );

  // Filter + sort apply to assets only; folders always render first (UE-style),
  // sorted by name (deriveContentView already sorts them).
  const favoriteFilteredAssets = useMemo(
    () => assetsInPath.filter(asset => {
      if (!favoritesOnly) return true;
      const rel = relByAssetGuid.get(asset.guid);
      return (rel != null && favorites.isFavorite(rel)) || favorites.isFavorite(asset.packPath);
    }),
    [assetsInPath, favorites, favoritesOnly, relByAssetGuid],
  );
  const filteredAssets = useMemo(() => filter.applyFilters(favoriteFilteredAssets), [filter, favoriteFilteredAssets]);
  const sortedAssets = useMemo(() => sort.sortItems(filteredAssets), [sort, filteredAssets]);

  // Source filenames that have a .meta.json sidecar — hidden in asset mode
  // (the sidecar's sub-assets replace them).
  const metaSidecarSources = useMemo(() => {
    const set = new Set<string>();
    for (const [metaRel, assets] of metaAssetMap) {
      if (assets.length > 0) {
        const sourceRel = metaRel.replace(/\.meta\.json$/, '');
        set.add(sourceRel);
      }
    }
    return set;
  }, [metaAssetMap]);

  const filesInPath = useMemo(() => {
    const q = filter.searchQuery.trim().toLowerCase();
    return diskFiles
      .filter(file => dirOfPath(file.path) === nav.currentPath)
      .filter(file => {
        if (viewMode === 'asset') {
          // Hide source files that have a .meta.json sidecar
          if (metaSidecarSources.has(file.path)) return false;
          // Hide raw .meta.json — their sub-assets are shown as asset tiles
          if (file.family === 'meta' && metaAssetMap.has(file.path) && (metaAssetMap.get(file.path)?.length ?? 0) > 0) return false;
        }
        return true;
      })
      .map(file => {
        // Enrich .meta.json files with parsed subAssets when registry hasn't
        // indexed them yet (assets array from assetsByRel is empty).
        if (file.family === 'meta' && file.assets.length === 0) {
          const metaAssets = metaAssetMap.get(file.path);
          if (metaAssets && metaAssets.length > 0) {
            return { ...file, assets: metaAssets };
          }
        }
        return file;
      })
      .filter(file => !favoritesOnly || file.isFavorite)
      .filter(file => !q || file.name.toLowerCase().includes(q) || file.assets.some(asset => asset.name.toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [diskFiles, favoritesOnly, filter.searchQuery, metaAssetMap, metaSidecarSources, nav.currentPath, viewMode]);

  const diskFilePaths = useMemo(() => new Set(diskFiles.map(file => file.path)), [diskFiles]);
  const registryOnlyAssets = useMemo(() => sortedAssets.filter(asset => {
    const rel = scopedAssets.find(scoped => scoped.asset.guid === asset.guid)?.rel;
    return !rel || !diskFilePaths.has(rel);
  }), [diskFilePaths, scopedAssets, sortedAssets]);

  // Meta-derived sub-assets that sit in the current directory but whose
  // .meta.json files are hidden in asset mode. Shown as standalone asset tiles
  // (UE-style: every mesh/material/texture is a first-class entry).
  const metaSubAssetsInPath = useMemo<CBAsset[]>(() => {
    if (viewMode !== 'asset') return [];
    const out: CBAsset[] = [];
    const seenGuids = new Set(sortedAssets.map(a => a.guid));
    for (const [metaRel, assets] of metaAssetMap) {
      if (dirOfPath(metaRel) !== nav.currentPath) continue;
      for (const a of assets) {
        if (!seenGuids.has(a.guid)) out.push(a);
      }
    }
    return out;
  }, [metaAssetMap, nav.currentPath, sortedAssets, viewMode]);

  // Single ordered array shared by the view AND multi-select — handleClick
  // resolves items by flat index, so both must see the same order.
  //
  // viewMode === 'asset': folders + remaining disk files (source/meta hidden)
  // + auto-expanded pack sub-assets + meta-derived sub-assets as standalone
  // tiles (the UE-style content browser).
  //
  // viewMode === 'file': folders + raw disk files; pack/meta files with
  // sub-assets can be manually toggled open via the chevron or double-click.
  const viewItems = useMemo<CBViewItem[]>(() => {
    const items: CBViewItem[] = [...visibleFoldersInPath];

    if (viewMode === 'asset') {
      for (const file of filesInPath) {
        items.push(file);
        if ((file.family === 'pack' || file.family === 'meta') && file.assets.length > 0) {
          items.push(...file.assets);
        }
      }
      items.push(...metaSubAssetsInPath);
      items.push(...registryOnlyAssets);
    } else {
      for (const file of filesInPath) {
        items.push(file);
        if ((file.family === 'pack' || file.family === 'meta') && expandedPacks.has(file.path) && file.assets.length > 0) {
          items.push(...file.assets);
        }
      }
      items.push(...registryOnlyAssets);
    }

    return items;
  }, [expandedPacks, filesInPath, metaSubAssetsInPath, registryOnlyAssets, viewMode, visibleFoldersInPath]);

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
    metaSubAssetsInPath,
    viewItems,
  };
}
