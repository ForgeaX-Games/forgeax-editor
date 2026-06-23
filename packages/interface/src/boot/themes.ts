import type { SplashThemeId } from './types';

/**
 * Theme registry — keep this list in sync with the CSS classes in index.html
 * (`.fgx-boot.t-classic-lime`, `.fgx-boot.t-neon-pulse`). Adding a third theme
 * is one entry here + one CSS block there + one option in SettingsSection.
 */
export interface SplashTheme {
  id: SplashThemeId;
  label: string;
  /** Hex used by SettingsSection's preview swatch. */
  swatch: string;
  desc: string;
}

export const SPLASH_THEMES: SplashTheme[] = [
  {
    id: 'classic-lime',
    label: 'Classic Lime',
    swatch: '#d4ff48',
    desc: '现有风格 · lime 强调色 + 横向进度条',
  },
  {
    id: 'neon-pulse',
    label: 'Neon Pulse',
    swatch: '#7dd3fc',
    desc: '径向脉冲动画 + 全屏 logo + 弧形进度条',
  },
];

export function themeById(id: SplashThemeId): SplashTheme {
  return SPLASH_THEMES.find((t) => t.id === id) ?? SPLASH_THEMES[0]!;
}
