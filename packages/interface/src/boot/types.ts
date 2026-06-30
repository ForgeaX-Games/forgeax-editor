/**
 * Boot splash config — small enough to live in localStorage AND server-side
 * `.forgeax/boot-splash.json`. Schema versioned so future fields don't break
 * older saves (load() drops anything with `v !== current` back to defaults).
 *
 * The inline splash bootstrap in `index.html` reads the localStorage entry
 * BEFORE React loads, so this shape must stay JSON-serializable and free of
 * any TS-side dependencies.
 */

export const SPLASH_SCHEMA_VERSION = 1 as const;

export type SplashThemeId = 'classic-lime' | 'neon-pulse';

export interface SplashConfig {
  v: typeof SPLASH_SCHEMA_VERSION;
  theme: SplashThemeId;
  title: string;
  subtitle: string;
  showProgressBar: boolean;
  showBusInventory: boolean;
}

export const DEFAULT_SPLASH: SplashConfig = {
  v: SPLASH_SCHEMA_VERSION,
  theme: 'classic-lime',
  title: 'forgeax · Studio',
  subtitle: 'booting shell…',
  showProgressBar: true,
  showBusInventory: false,
};

export const SPLASH_STORAGE_KEY = 'forgeax.boot.splash.v1';

export function isValidSplashConfig(x: unknown): x is SplashConfig {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    o.v === SPLASH_SCHEMA_VERSION &&
    (o.theme === 'classic-lime' || o.theme === 'neon-pulse') &&
    typeof o.title === 'string' &&
    typeof o.subtitle === 'string' &&
    typeof o.showProgressBar === 'boolean' &&
    typeof o.showBusInventory === 'boolean'
  );
}
