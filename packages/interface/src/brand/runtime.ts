/**
 * Module-scope brand runtime.
 *
 * The vite plugin injects `window.__BRAND__` inline in `index.html` BEFORE
 * the `main.tsx` module fetch starts, so `getBrandSync()` is safe to call at
 * import time (provider-badge.ts and friends do exactly this).
 *
 * If `window.__BRAND__` is missing (e.g. the user stripped the inline script,
 * or unit tests), `getBrandSync()` falls back to a hard-coded ForgeaX stub so
 * UI code never throws. The fallback intentionally mirrors
 * `brand/defaults.forgeax.json` — keep it in sync if you ever change the
 * canonical defaults.
 */

import type { BrandConfig, BrandRuntime } from './types';

const FALLBACK: BrandConfig = {
  id: 'forgeax',
  schemaVersion: 1,
  product: {
    name: 'ForgeaX Studio',
    shortName: 'forgeax',
    tagline: 'AI-first game dev shell — open desktop edition',
  },
  assistant: {
    name: 'Forge',
    avatarSrc: null,
    cardName: { zh: '主线制作人', en: 'Lead Producer' },
  },
  splash: {
    title: 'ForgeaX · Studio',
    subtitle: 'booting shell…',
    theme: 'classic-lime',
  },
  providers: {
    native: { id: 'forgeax', label: 'forgeax', title: 'ForgeaX native CLI provider' },
  },
  links: {
    repoUrl: 'https://github.com/ForgeaX-Games/forgeax-studio',
    communityUrl: 'https://forge.games',
  },
  assets: {
    favicon: 'assets/favicon.svg',
    logo: 'assets/logo.svg',
  },
};

const FALLBACK_RUNTIME: BrandRuntime = {
  config: FALLBACK,
  source: { kind: 'default' },
  assetBaseUrl: '/brand/',
};

export function getBrandRuntimeSync(): BrandRuntime {
  if (typeof window !== 'undefined' && window.__BRAND__) {
    return window.__BRAND__;
  }
  return FALLBACK_RUNTIME;
}

export function getBrandSync(): BrandConfig {
  return getBrandRuntimeSync().config;
}

export function getBrandAssetUrl(asset: 'favicon' | 'logo' | 'avatar'): string | null {
  const rt = getBrandRuntimeSync();
  const map: Record<typeof asset, string | null | undefined> = {
    favicon: rt.config.assets?.favicon,
    logo: rt.config.assets?.logo,
    avatar: rt.config.assistant.avatarSrc,
  };
  const rel = map[asset];
  if (!rel) return null;
  // assets is published under `<base>/<asset-relative>` by the vite plugin.
  const base = rt.assetBaseUrl.endsWith('/') ? rt.assetBaseUrl : `${rt.assetBaseUrl}/`;
  return `${base}${rel.replace(/^\.?\/+/, '')}`;
}
