// useCBData — remote-catalog + disk-tree fetch loop for the Content Browser.
//
// Owns three pieces of live async state:
//   1. allAssets    — engine AssetRegistry.listCatalog() projection (asset SSOT).
//   2. diskTree     — /api/files/tree of the current game (surfaces empty dirs
//                     and non-registry-backed source files).
//   3. loading      — mirrors the first async apply in reload().
//
// Also wires the 200ms debounced `assetsChanged` PanelBridge subscription that
// re-invokes reload + fetchDiskDirs on any editor-side asset write. Kept in
// ONE hook so ContentBrowser.tsx is free of raw async plumbing.

import { useCallback, useEffect, useState } from 'react';
import { gateway, getSceneId, panelBridge, resolveGamePath } from '@forgeax/editor-core';
import type { CBAsset } from '../types';
import {
  registryEntryToCBAsset,
  type DiskTreeNode,
  type RegistryCatalogEntry,
} from '../content-browser-format';

interface RegistrySurface {
  listCatalog?: () => readonly RegistryCatalogEntry[];
  refreshCatalog?: () => Promise<boolean>;
}

export interface CBDataResult {
  allAssets: CBAsset[];
  loading: boolean;
  reload: () => void;
  diskTree: DiskTreeNode | null;
  fetchDiskDirs: () => Promise<void>;
}

export function useCBData(gameSlug: string): CBDataResult {
  const [allAssets, setAllAssets] = useState<CBAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [diskTree, setDiskTree] = useState<DiskTreeNode | null>(null);

  const reload = useCallback(() => {
    const slug = getSceneId();
    if (!slug || slug === 'default') return;
    setLoading(true);
    // The engine AssetRegistry is the SSOT — asset panel truth = engine truth.
    //
    // refreshCatalog first: listCatalog() is a sync cache read. On single-realm
    // boot the Assets tab is inactive, so ContentBrowser mounts AFTER
    // host-session's one-shot broadcastAssetsChanged (and
    // installAssetCatalogRefresh is wired even later). Without an explicit
    // refresh here the first mount sees an empty packIndexCache forever.
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

  // Disk tree: fetch the real game tree so empty dirs and source files are
  // visible beside registry-backed assets.
  const fetchDiskDirs = useCallback(async () => {
    if (!gameSlug || gameSlug === 'default') return;
    try {
      const treePath = resolveGamePath('');
      const r = await fetch(`/api/files/tree?root=${encodeURIComponent(treePath)}&optional=1`, { cache: 'no-store' });
      if (!r.ok) return;
      const j = (await r.json()) as { tree?: DiskTreeNode | null };
      setDiskTree(j.tree ?? null);
    } catch { /* silent */ }
  }, [gameSlug]);

  useEffect(() => { void fetchDiskDirs(); }, [fetchDiskDirs]);

  useEffect(() => {
    // 200ms debounce — merge consecutive in-process assetsChanged signals into
    // one reload + fetchDiskDirs. 'directory-only' hint skips reload (no pack
    // change). This is PanelBridge, not a same-window VAG postMessage copy: the
    // editor is single-realm and assetsChanged is a notification, not an op.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = panelBridge.on('assetsChanged', ({ hint }) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
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

  return { allAssets, loading, reload, diskTree, fetchDiskDirs };
}
