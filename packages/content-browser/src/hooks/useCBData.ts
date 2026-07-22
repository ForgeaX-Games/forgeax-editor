// useCBData — compatibility adapter from the canonical core read model to the
// Content Browser's existing render-friendly data shape. Network/tree/sidecar
// semantics live in useAssetBrowserSnapshot + editor-core.

import { useMemo } from 'react';
import { resolveGamePath } from '@forgeax/editor-core';
import type { AssetBrowserCatalogRoot, AssetBrowserSnapshot } from '@forgeax/editor-core';
import type { CBAsset } from '../types';
import { registryEntryToCBAsset, type DiskTreeNode } from '../content-browser-format';
import { useAssetBrowserSnapshot } from './useAssetBrowserSnapshot';

export interface CBDataResult {
  allAssets: CBAsset[];
  loading: boolean;
  reload: () => void;
  diskTree: DiskTreeNode | null;
  fetchDiskDirs: () => Promise<void>;
}

function relativeDir(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function snapshotToDiskTree(snapshot: AssetBrowserSnapshot, gameSlug: string): DiskTreeNode | null {
  if (!gameSlug || gameSlug === 'default') return null;
  const rootPath = resolveGamePath('');
  if (!snapshot.files.length && !snapshot.directories.length) return null;
  const root: DiskTreeNode = { type: 'dir', name: gameSlug, path: rootPath, children: [] };
  const nodes = new Map<string, DiskTreeNode>([['', root]]);

  const ensureDir = (path: string, diskPath: string): DiskTreeNode => {
    const existing = nodes.get(path);
    if (existing) return existing;
    const parentPath = relativeDir(path);
    const parent = ensureDir(parentPath, diskPath.replace(/\\[^/]+$/, ''));
    const node: DiskTreeNode = {
      type: 'dir',
      name: path.slice(path.lastIndexOf('/') + 1),
      path: diskPath,
      children: [],
    };
    parent.children?.push(node);
    nodes.set(path, node);
    return node;
  };

  for (const directory of snapshot.directories) ensureDir(directory.path, directory.diskPath);
  for (const file of snapshot.files) {
    const parent = ensureDir(relativeDir(file.path), file.diskPath.replace(/\\[^/]+$/, ''));
    parent.children?.push({ type: 'file', name: file.name, path: file.diskPath });
  }
  return root;
}

export function useCBData(
  gameSlug: string,
  catalogRoots: readonly AssetBrowserCatalogRoot[],
): CBDataResult {
  const { snapshot, loading, reload } = useAssetBrowserSnapshot(gameSlug, catalogRoots);
  const allAssets = useMemo<CBAsset[]>(
    // The read model's sourcePath is intentionally projected for UI navigation
    // (e.g. catalog/assets → assets). CRUD must retain the original catalog
    // address, otherwise standalone's `<slug>/<rel>` file backend rejects a
    // projected path such as `assets/Fox.glb.meta.json`.
    () => snapshot.assets.map((asset, index) => registryEntryToCBAsset({
      ...asset,
      relativeUrl: asset.storageRelativeUrl,
      sourcePath: asset.storageSourcePath ?? asset.sourcePath,
      refs: asset.refs,
    }, index)),
    [snapshot.assets],
  );
  const diskTree = useMemo(() => snapshotToDiskTree(snapshot, gameSlug), [gameSlug, snapshot]);
  return {
    allAssets,
    loading,
    reload,
    diskTree,
    fetchDiskDirs: async () => { await reload(); },
  };
}
