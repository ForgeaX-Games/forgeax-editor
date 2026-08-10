// useAssetBrowserSnapshot — React lifecycle adapter for core's canonical
// AssetBrowserReadModel. It owns subscription/debounce only; catalog/tree/meta
// join semantics remain in editor-core.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CatalogDelta } from '@forgeax/engine-types';
import {
  createAssetBrowserReadModel,
  getViewportRuntimeClientSnapshot,
  gateway,
  panelBridge,
  queryViewportRuntimeProjection,
  resolveGamePath,
  subscribeViewportRuntimeClient,
} from '@forgeax/editor-core';
import type { AssetBrowserCatalogRoot, AssetBrowserRegistry, AssetBrowserRegistryEntry, AssetBrowserSnapshot } from '@forgeax/editor-core';

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
  reconcile: () => void;
}

export interface AssetBrowserDeltaState<Row extends { readonly guid: string }> {
  readonly rows: readonly Row[];
  readonly selection: unknown;
  readonly expandedTree: unknown;
  readonly filter: unknown;
  readonly sort: unknown;
  readonly panelRealm: object;
  readonly stale: boolean;
  readonly reconcileRequired: boolean;
  readonly rowRenderCounts?: ReadonlyMap<string, number>;
}

/** Fold one Catalog delta without rebuilding unrelated browser rows or UI context. */
export function applyAssetBrowserDelta<Row extends { readonly guid: string }>(
  state: AssetBrowserDeltaState<Row>,
  delta: CatalogDelta,
): AssetBrowserDeltaState<Row> {
  const degraded = delta.authority === 'degraded';
  if (degraded) return { ...state, stale: true, reconcileRequired: true };
  if (delta.added.length === 0 && delta.changed.length === 0 && delta.removed.length === 0) return state;
  const byGuid = new Map(state.rows.map((row) => [row.guid.toLowerCase(), row]));
  const changedGuids = new Set<string>();
  for (const row of [...delta.added, ...delta.changed]) {
    const guid = row.guid.toLowerCase();
    byGuid.set(guid, row as unknown as Row);
    changedGuids.add(guid);
  }
  for (const guid of delta.removed) {
    byGuid.delete(guid.toLowerCase());
    changedGuids.add(guid.toLowerCase());
  }
  const originalGuids = new Set(state.rows.map((row) => row.guid.toLowerCase()));
  const rows = state.rows
    .filter((row) => byGuid.has(row.guid.toLowerCase()))
    .map((row) => byGuid.get(row.guid.toLowerCase()) ?? row);
  for (const row of byGuid.values()) if (!originalGuids.has(row.guid.toLowerCase())) rows.push(row);
  const rowRenderCounts = state.rowRenderCounts === undefined
    ? undefined
    : new Map([...state.rowRenderCounts].map(([guid, count]) => [guid, count + (changedGuids.has(guid.toLowerCase()) ? 1 : 0)]));
  return {
    ...state,
    rows,
    stale: false,
    reconcileRequired: false,
    ...(rowRenderCounts === undefined ? {} : { rowRenderCounts }),
  };
}

export function useAssetBrowserSnapshot(
  gameSlug: string,
  catalogRoots: readonly AssetBrowserCatalogRoot[],
): UseAssetBrowserSnapshotResult {
  const [registryRevision, setRegistryRevision] = useState(0);
  const remoteEntries = useRemoteAssetCatalog();
  const remoteRegistry = useMemo<AssetBrowserRegistry | undefined>(() => remoteEntries === undefined
    ? undefined
    : { listCatalog: () => remoteEntries }, [remoteEntries]);
  // The outer shell may still carry a bootstrap Gateway for chrome commands;
  // it is never the asset authority while the Runtime projection is present.
  const registry = remoteRegistry
    ?? gateway.doc.registry as AssetBrowserRegistry | undefined;
  const model = useMemo(() => {
    if (!gameSlug || gameSlug === 'default' || !registry) return null;
    return createAssetBrowserReadModel({
      fetch: globalThis.fetch.bind(globalThis),
      registry,
      resolveGamePath,
      catalogRoots,
    });
  }, [catalogRoots, gameSlug, registry, registryRevision]);
  const [snapshot, setSnapshot] = useState<AssetBrowserSnapshot>(() => model?.snapshot() ?? EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(() => {
    if (!model) return;
    setLoading(true);
    void model.refresh().finally(() => setLoading(false));
  }, [model]);

  const reconcile = useCallback(() => {
    if (!model) return;
    setLoading(true);
    void model.reconcile().finally(() => setLoading(false));
  }, [model]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const offBridge = panelBridge.on('assetsChanged', ({ hint }) => {
      if (!model) {
        setRegistryRevision(revision => revision + 1);
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        setLoading(true);
        void model.refresh(hint).finally(() => setLoading(false));
      }, 200);
    });
    if (!model) {
      setSnapshot(EMPTY_SNAPSHOT);
      setLoading(false);
      return () => {
        offBridge();
        if (timer) clearTimeout(timer);
      };
    }
    setSnapshot(model.snapshot());
    const offModel = model.subscribe(setSnapshot);
    reload();
    return () => {
      offModel();
      offBridge();
      if (timer) clearTimeout(timer);
    };
  }, [model, reload]);

  return { snapshot, loading, reload, reconcile };
}

function useRemoteAssetCatalog(): readonly AssetBrowserRegistryEntry[] | undefined {
  const connection = useSyncExternalStore(
    subscribeViewportRuntimeClient,
    getViewportRuntimeClientSnapshot,
    getViewportRuntimeClientSnapshot,
  );
  const [entries, setEntries] = useState<readonly AssetBrowserRegistryEntry[] | undefined>();
  const signatureRef = useRef('');
  useEffect(() => {
    if (connection.status !== 'ready') {
      signatureRef.current = '';
      setEntries(undefined);
      return;
    }
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const envelope = await queryViewportRuntimeProjection<{ readonly entries: readonly AssetBrowserRegistryEntry[] }>({ kind: 'assets.catalog' });
        if (disposed) return;
        const next = envelope.status === 'ready' ? envelope.value.entries : envelope.status === 'empty' ? [] : undefined;
        const signature = next === undefined ? '' : JSON.stringify(next);
        if (signature !== signatureRef.current) {
          signatureRef.current = signature;
          setEntries(next);
        }
      } catch {
        if (!disposed) setEntries(undefined);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 250);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [connection.runtime?.runtimeId, connection.runtime?.runtimeGeneration, connection.status]);
  return entries;
}
