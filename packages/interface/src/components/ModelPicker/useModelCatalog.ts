import { useEffect, useState } from 'react';
import { listModels, type ModelCatalogEntry } from '../../lib/model-config';

// Window-level memo so Composer + TopBar + ModelLab share one fetch.
// list_models hits ~/.forgeax/key/models.json + LiteLLM /v1/models with a 60s
// TTL upstream, but the browser-side hop should still be deduped across the 3
// surfaces that all mount at app boot.
let cached: ModelCatalogEntry[] | null = null;
let inflight: Promise<ModelCatalogEntry[]> | null = null;
const subscribers = new Set<(list: ModelCatalogEntry[]) => void>();

async function fetchOnce(force = false): Promise<ModelCatalogEntry[]> {
  if (cached && !force) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const list = await listModels();
      cached = list;
      for (const cb of subscribers) cb(list);
      return list;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export interface ModelCatalogState {
  models: ModelCatalogEntry[] | null;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useModelCatalog(): ModelCatalogState {
  const [models, setModels] = useState<ModelCatalogEntry[] | null>(cached);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const sub = (list: ModelCatalogEntry[]) => { if (!cancelled) setModels(list); };
    subscribers.add(sub);
    if (!cached) {
      fetchOnce()
        .then((list) => { if (!cancelled) { setModels(list); setError(null); } })
        .catch((e) => { if (!cancelled) setError((e as Error).message); });
    }
    return () => { cancelled = true; subscribers.delete(sub); };
  }, []);
  const refresh = async () => {
    try {
      await fetchOnce(true);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return { models, error, refresh };
}

export function _resetModelCatalogCache(): void {
  cached = null;
  inflight = null;
}
