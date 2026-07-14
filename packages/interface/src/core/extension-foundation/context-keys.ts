// packages/interface/src/core/extension-foundation/context-keys.ts
import type { Cleanup } from './types';

export interface ContextKeysApi {
  get<T = unknown>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  onChange(key: string, listener: (value: unknown) => void): Cleanup;
}

export function createContextKeys(): ContextKeysApi {
  const values = new Map<string, unknown>();
  const listeners = new Map<string, Set<(v: unknown) => void>>();

  return {
    get<T>(key: string): T | undefined { return values.get(key) as T | undefined; },
    set<T>(key: string, value: T): void {
      const prev = values.get(key);
      if (Object.is(prev, value)) return;
      values.set(key, value);
      const set = listeners.get(key);
      if (!set) return;
      for (const l of Array.from(set)) {
        try { l(value); } catch (err) {
          console.error(`[extension-foundation] contextKeys "${key}" listener threw`, err);
        }
      }
    },
    onChange(key, listener) {
      let set = listeners.get(key);
      if (!set) { set = new Set(); listeners.set(key, set); }
      set.add(listener);
      return () => { set!.delete(listener); if (set!.size === 0) listeners.delete(key); };
    },
  };
}
