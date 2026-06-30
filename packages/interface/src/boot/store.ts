/**
 * Boot splash config store.
 *
 * Source of truth lives in two places:
 *  - localStorage `forgeax.boot.splash.v1` — read synchronously by the inline
 *    bootstrap in index.html BEFORE React mounts, so the chosen theme paints
 *    on the first frame.
 *  - `<projectRoot>/.forgeax/boot-splash.json` — persisted server-side so AI
 *    in ChatPanel can `curl POST /api/boot-splash` and the change carries
 *    across browsers / clean localStorage.
 *
 * On Settings panel mount we GET /api/boot-splash and reconcile to localStorage
 * (server wins). On any save in Settings we write localStorage AND POST to the
 * server. The inline bootstrap only ever reads localStorage — server fetch
 * during boot is too slow.
 */

import { useEffect, useSyncExternalStore } from 'react';
import {
  DEFAULT_SPLASH,
  SPLASH_STORAGE_KEY,
  isValidSplashConfig,
  type SplashConfig,
} from './types';

let cached: SplashConfig = DEFAULT_SPLASH;
let initialized = false;
const listeners = new Set<() => void>();

function readLocal(): SplashConfig {
  if (typeof window === 'undefined') return DEFAULT_SPLASH;
  try {
    const raw = window.localStorage.getItem(SPLASH_STORAGE_KEY);
    if (!raw) return DEFAULT_SPLASH;
    const parsed = JSON.parse(raw) as unknown;
    return isValidSplashConfig(parsed) ? parsed : DEFAULT_SPLASH;
  } catch {
    return DEFAULT_SPLASH;
  }
}

function writeLocal(c: SplashConfig): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SPLASH_STORAGE_KEY, JSON.stringify(c));
  } catch {
    /* localStorage may throw in privacy mode — silently ignore, server still holds the truth */
  }
}

function emit(): void {
  for (const fn of listeners) fn();
}

function ensureInit(): void {
  if (initialized) return;
  initialized = true;
  cached = readLocal();
}

export const bootSplashStore = {
  get(): SplashConfig {
    ensureInit();
    return cached;
  },
  set(next: SplashConfig): void {
    ensureInit();
    cached = next;
    writeLocal(next);
    emit();
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

/**
 * React hook exposing the current splash config + a setter. Setter writes
 * localStorage immediately AND fires a POST to /api/boot-splash so AI's
 * server-side view stays in sync. Server failure is silent — the user can
 * still iterate locally; AI just won't see the change until next save.
 */
export function useSplashConfig(): [SplashConfig, (next: SplashConfig) => void] {
  const value = useSyncExternalStore(
    bootSplashStore.subscribe,
    bootSplashStore.get,
    bootSplashStore.get,
  );

  // On first mount, reconcile from server (server wins if it has a saved file).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch('/api/boot-splash');
        if (!r.ok) return;
        const j = (await r.json()) as { config?: SplashConfig | null };
        if (cancelled) return;
        if (j.config && isValidSplashConfig(j.config)) {
          bootSplashStore.set(j.config);
        }
      } catch {
        /* server down — keep local copy */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const setter = (next: SplashConfig): void => {
    bootSplashStore.set(next);
    // Fire-and-forget server save. AI reads from the same endpoint, so this
    // keeps server side in sync. Errors don't block the UI.
    void fetch('/api/boot-splash', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    }).catch(() => { /* offline / server down */ });
  };

  return [value, setter];
}
