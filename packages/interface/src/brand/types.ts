/**
 * Brand pack — interface-side type mirror.
 *
 * Structurally identical to `packages/server/src/brand/types.ts`. Kept as a
 * standalone copy because vite + react interface is a separate package and
 * does not depend on server. If you change a field, update both files (and
 * `brand/schema.json` + `brand/defaults.forgeax.json`).
 */

export const BRAND_SCHEMA_VERSION = 1 as const;

export type SplashThemeId = 'classic-lime' | 'neon-pulse';

export interface BrandConfig {
  id: string;
  schemaVersion: typeof BRAND_SCHEMA_VERSION;
  product: {
    name: string;
    shortName: string;
    tagline: string;
  };
  assistant: {
    name: string;
    avatarSrc?: string | null;
    personaOverride?: {
      zh?: string | null;
      en?: string | null;
    };
    cardName?: {
      zh?: string;
      en?: string;
    };
  };
  splash: {
    title: string;
    subtitle: string;
    theme: SplashThemeId;
  };
  providers: {
    native: {
      id: string;
      label: string;
      title: string;
    };
  };
  links: {
    repoUrl: string;
    communityUrl: string;
    docsUrl?: string | null;
    issuesUrl?: string | null;
  };
  assets?: {
    favicon?: string | null;
    logo?: string | null;
    appleTouchIcon?: string | null;
  };
}

export type BrandSource =
  | { kind: 'env'; name: string }
  | { kind: 'symlink'; target: string }
  | { kind: 'default' }
  | { kind: 'override-dir'; dir: string };

export interface BrandRuntime {
  config: BrandConfig;
  source: BrandSource;
  /** URL prefix served by vite (dev) / the server (`/brand/assets/` proxy). */
  assetBaseUrl: string;
}

declare global {
  interface Window {
    __BRAND__?: BrandRuntime;
  }
}
