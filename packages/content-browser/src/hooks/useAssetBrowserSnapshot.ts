// useAssetBrowserSnapshot — React lifecycle adapter for core's canonical
// AssetBrowserReadModel. It owns subscription/debounce only; catalog/tree/meta
// join semantics remain in editor-core.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createAssetBrowserReadModel,
  gateway,
  panelBridge,
  resolveGamePath,
} from '@forgeax/editor-core';
import type { AssetBrowserCatalogRoot, AssetBrowserRegistry, AssetBrowserSnapshot } from '@forgeax/editor-core';

const EMPTY_SNAPSHOT: AssetBrowserSnapshot = Object.freeze({
  generation: 0,
  files: Object.freeze([]),
  directories: Object.freeze([]),
  assets: Object.freeze([]),
  sources: Object.freeze([]),
  diagnostics: Object.freeze([]),
});

export interface UseAssetBrowserSnapshotResult {
  snapshot: AssetBrowserSnapshot;
  loading: boolean;
  reload: () => void;
}

export function useAssetBrowserSnapshot(
  gameSlug: string,
  catalogRoots: readonly AssetBrowserCatalogRoot[],
): UseAssetBrowserSnapshotResult {
  const registry = gateway.doc.registry as AssetBrowserRegistry | undefined;
  const model = useMemo(() => {
    if (!gameSlug || gameSlug === 'default' || !registry) return null;
    return createAssetBrowserReadModel({
      fetch: globalThis.fetch.bind(globalThis),
      registry,
      resolveGamePath,
      catalogRoots,
    });
  }, [catalogRoots, gameSlug, registry]);
  const [snapshot, setSnapshot] = useState<AssetBrowserSnapshot>(() => model?.snapshot() ?? EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(() => {
    if (!model) return;
    setLoading(true);
    void model.refresh().finally(() => setLoading(false));
  }, [model]);

  useEffect(() => {
    if (!model) {
      setSnapshot(EMPTY_SNAPSHOT);
      setLoading(false);
      return;
    }
    setSnapshot(model.snapshot());
    const offModel = model.subscribe(setSnapshot);
    reload();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const offBridge = panelBridge.on('assetsChanged', ({ hint }) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        setLoading(true);
        void model.refresh(hint).finally(() => setLoading(false));
      }, 200);
    });
    return () => {
      offModel();
      offBridge();
      if (timer) clearTimeout(timer);
    };
  }, [model, reload]);

  return { snapshot, loading, reload };
}
