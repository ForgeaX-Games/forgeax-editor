import { useEffect, useState } from 'react';
import {
  listModelsWithMeta,
  type CatalogDriverMeta,
  type ModelCatalogEntry,
  type ModelCatalogWithMeta,
} from '../../lib/model-config';

// Window-level memo so Composer + TopBar + ModelLab share one fetch.
// list_models hits ~/.forgeax/key/models.json + LiteLLM /v1/models with a 60s
// TTL upstream, but the browser-side hop should still be deduped across the 3
// surfaces that all mount at app boot.
//
// 缓存单位是整份 payload(models + driver 元数据):内核目录路径的空态/徽章
// 需要 driver.source/error,不能在这一层丢掉。
const cached = new Map<string, ModelCatalogWithMeta>();
const inflight = new Map<string, Promise<ModelCatalogWithMeta>>();
const subscribers = new Map<string, Set<(payload: ModelCatalogWithMeta) => void>>();

function cacheKey(providerId?: string | null): string {
  return providerId?.trim() || 'gateway';
}

function subscriberSet(key: string): Set<(payload: ModelCatalogWithMeta) => void> {
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  return set;
}

async function fetchOnce(providerId?: string | null, force = false): Promise<ModelCatalogWithMeta> {
  const key = cacheKey(providerId);
  const hit = cached.get(key);
  if (hit && !force) return hit;
  const current = inflight.get(key);
  if (current) return current;
  const next = (async () => {
    try {
      const payload = await listModelsWithMeta(providerId);
      cached.set(key, payload);
      for (const cb of subscriberSet(key)) cb(payload);
      return payload;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, next);
  return next;
}

export interface ModelCatalogState {
  models: ModelCatalogEntry[] | null;
  /** 内核目录路径的回退链元数据(gateway 路径为 undefined)。 */
  driver: CatalogDriverMeta | null;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useModelCatalog(providerId?: string | null): ModelCatalogState {
  const key = cacheKey(providerId);
  const [payload, setPayload] = useState<ModelCatalogWithMeta | null>(cached.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const sub = (p: ModelCatalogWithMeta) => { if (!cancelled) setPayload(p); };
    const subs = subscriberSet(key);
    subs.add(sub);
    const hit = cached.get(key);
    if (hit) setPayload(hit);
    else {
      fetchOnce(providerId)
        .then((p) => { if (!cancelled) { setPayload(p); setError(null); } })
        .catch((e) => { if (!cancelled) setError((e as Error).message); });
    }
    return () => { cancelled = true; subs.delete(sub); };
  }, [key, providerId]);
  const refresh = async () => {
    try {
      await fetchOnce(providerId, true);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return { models: payload?.models ?? null, driver: payload?.driver ?? null, error, refresh };
}

export function _resetModelCatalogCache(): void {
  cached.clear();
  inflight.clear();
}

/**
 * Force-refresh every catalog the app currently holds — call after an LLM
 * credential change (new key / base-url can change which models the proxy
 * exposes, e.g. switching LiteLLM proxies). Refetches each known (providerId)
 * tuple with `force` and pushes the fresh list to all mounted consumers via
 * their subscriber callbacks, so the picker updates without a page reload.
 *
 * Covers both cached and actively-subscribed keys; nothing to refresh (no
 * picker mounted yet) → no-op, the next mount fetches fresh anyway. The
 * default gateway key ('gateway') maps back to `undefined` providerId.
 */
export async function refreshAllModelCatalogs(): Promise<void> {
  const keys = new Set<string>([...cached.keys(), ...subscribers.keys()]);
  await Promise.all(
    [...keys].map((k) =>
      fetchOnce(k === 'gateway' ? undefined : k, true).catch(() => ({ models: [] as ModelCatalogEntry[] })),
    ),
  );
}
