/**
 * BrandProvider + useBrand — React-side brand pack consumer.
 *
 * Wraps the app in main.tsx. Inside the tree, call `useBrand()` to read the
 * active pack synchronously. Code outside React (module scope, store, vite
 * plugin) should call `getBrandSync()` from ./runtime instead.
 *
 * The provider trusts `window.__BRAND__` (injected by vite-plugin-brand at
 * dev/build time). It does not fetch /api/brand — the inline injection is
 * synchronous and avoids a flash of un-branded content.
 */

import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { BrandConfig, BrandRuntime } from './types';
import { getBrandRuntimeSync, getBrandAssetUrl } from './runtime';

const BrandContext = createContext<BrandRuntime | null>(null);

export function BrandProvider({ children }: { children: ReactNode }) {
  const value = useMemo(() => getBrandRuntimeSync(), []);
  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>;
}

export function useBrand(): BrandConfig {
  const ctx = useContext(BrandContext);
  if (ctx) return ctx.config;
  return getBrandRuntimeSync().config;
}

export function useBrandRuntime(): BrandRuntime {
  const ctx = useContext(BrandContext);
  if (ctx) return ctx;
  return getBrandRuntimeSync();
}

export function useBrandAsset(key: 'favicon' | 'logo' | 'avatar'): string | null {
  // Re-derive on every render; getBrandAssetUrl is pure and cheap.
  return getBrandAssetUrl(key);
}
