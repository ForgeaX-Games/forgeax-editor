// packages/interface/src/core/extension-foundation/storage.ts
//
// JSON-codec localStorage wrapper. Consumers pass string keys (they SHOULD
// come from lib/storageKeys.ts SSOT — this layer is agnostic to the naming
// scheme).

export interface StorageApi {
  get<T>(key: string): T | null;
  set<T>(key: string, value: T): void;
  remove(key: string): void;
}

export function createStorageApi(logger: {
  warn: (msg: string, ...rest: unknown[]) => void;
} = console): StorageApi {
  return {
    get<T>(key: string): T | null {
      if (typeof window === 'undefined') return null;
      const raw = window.localStorage.getItem(key);
      if (raw === null) return null;
      try { return JSON.parse(raw) as T; }
      catch (err) { logger.warn(`[storage] "${key}" corrupt JSON, returning null`, err); return null; }
    },
    set<T>(key: string, value: T): void {
      if (typeof window === 'undefined') return;
      window.localStorage.setItem(key, JSON.stringify(value));
    },
    remove(key: string): void {
      if (typeof window === 'undefined') return;
      window.localStorage.removeItem(key);
    },
  };
}
