import type { SplashThemeId } from './types';

/**
 * Theme registry — keep this list in sync with the CSS classes in index.html
 * (`.fgx-boot.t-classic-lime`, `.fgx-boot.t-neon-pulse`). Adding a third theme
 * is one entry here + one CSS block there + one option in SettingsSection.
 */
export interface SplashTheme {
  id: SplashThemeId;
  label: string;
  /** i18n key for `label` (namespace `themes.`); consumer may call t(labelKey). */
  labelKey: string;
  /** Hex used by SettingsSection's preview swatch. */
  swatch: string;
  desc: string;
  /** i18n key for `desc` (namespace `themes.`); consumer may call t(descKey). */
  descKey: string;
}

export const SPLASH_THEMES: SplashTheme[] = [
  {
    id: 'classic-lime',
    label: 'Classic Lime',
    labelKey: 'themes.classicLime.label',
    swatch: '#d4ff48',
    desc: 'Current style · lime accent + horizontal progress bar',
    descKey: 'themes.classicLime.desc',
  },
  {
    id: 'neon-pulse',
    label: 'Neon Pulse',
    labelKey: 'themes.neonPulse.label',
    swatch: '#7dd3fc',
    desc: 'Radial pulse animation + full-screen logo + arc progress bar',
    descKey: 'themes.neonPulse.desc',
  },
];

export function themeById(id: SplashThemeId): SplashTheme {
  return SPLASH_THEMES.find((t) => t.id === id) ?? SPLASH_THEMES[0]!;
}
