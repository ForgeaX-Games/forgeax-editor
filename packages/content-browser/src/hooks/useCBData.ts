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

/** Normalize a storage path to `<slug>/<rel>` for the file backend.
 *  vite-plugin-pack can return paths in several non-standard forms:
 *    - relative with `../`: `../Forgeax-games/<slug>/assets/foo.mp3`
 *    - absolute: `E:/ForgeaxEditor/Forgeax-games/<slug>/assets/foo.mp3`
 *  Both standalone (`singleGameFileBackend`) and studio (`studioFileBackend`)
 *  expect a relative path rooted at the slug (e.g. `<slug>/assets/foo.mp3`).
 *
 *  **Safe**: normal relative paths already starting with `<slug>/` or `games/<slug>/`
 *  (no `..`, no drive letter) pass through unchanged. */
function normalizeStoragePath(path: string | undefined, slug: string): string | undefined {
  if (!path) return path;
  // Already a normal relative path (no `..`, no absolute drive/UNC prefix)
  const isAbsolute = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/');
  if (!isAbsolute && !path.includes('..')) return path;
  // Find the slug segment and trim everything before it
  const slugPrefix = `${slug}/`;
  const slugIndex = path.indexOf(slugPrefix);
  if (slugIndex >= 0) {
    return path.slice(slugIndex);
  }
  // Try with path separator variants (backslash on Windows)
  const slugPrefixWin = `${slug}\\`;
  const slugIndexWin = path.indexOf(slugPrefixWin);
  if (slugIndexWin >= 0) {
    return path.slice(slugIndexWin).replace(/\\/g, '/');
  }
  return path;
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
    // Additionally normalize paths that escape the slug root (e.g. `../Forgeax-games/<slug>/...`
    // → `<slug>/...`) so standalone's singleGameFileBackend can resolve them.
    () => snapshot.assets.map((asset, index) => registryEntryToCBAsset({
      ...asset,
      relativeUrl: normalizeStoragePath(asset.storageRelativeUrl, gameSlug) ?? asset.storageRelativeUrl,
      sourcePath: normalizeStoragePath(asset.storageSourcePath, gameSlug) ?? normalizeStoragePath(asset.sourcePath, gameSlug),
      refs: asset.refs,
    }, index)),
    [snapshot.assets, gameSlug],
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
