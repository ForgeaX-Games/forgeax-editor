/**
 * Tailwind preset that bridges the ForgeaX/ForgeaX design tokens (`--fx-*`,
 * `--radius-*` from `tokens.css`) into Tailwind's semantic color/radius scale.
 *
 * Consumers spread this into their own `tailwind.config.ts`:
 *
 *   import { createForgeaxPreset } from '@forgeax/design/preset'
 *   import animate from 'tailwindcss-animate'
 *   export default {
 *     presets: [createForgeaxPreset()],
 *     plugins: [animate],
 *     content: ['./src/**\/*.{ts,tsx,html}', './index.html'],
 *   }
 *
 * The fallback values are the current ForgeaX *dark* skin so a utility class
 * still renders sanely if `tokens.css` has not loaded yet (no white flash).
 * The live `--fx-*` value always wins when present.
 *
 * This file is intentionally dependency-free (no `tailwindcss` import) so the
 * design package typechecks in isolation. `tailwindcss-animate` is added by the
 * consumer, which is where it is installed.
 */

type ColorToken = string | { DEFAULT?: string; foreground?: string };

export interface ForgeaxPreset {
  darkMode: ['selector', string];
  theme: {
    extend: {
      colors: Record<string, ColorToken>;
      borderRadius: Record<string, string>;
    };
  };
}

export function createForgeaxPreset(): ForgeaxPreset {
  return {
    // `tokens.css` keys the dark skin off `:root` today; this selector keeps
    // Tailwind's `dark:` variant aligned for when light skins land.
    darkMode: ['selector', '[data-theme="dark"]'],
    theme: {
      extend: {
        colors: {
          border: 'var(--fx-border, #404040)',
          input: 'var(--fx-border, #404040)',
          ring: 'var(--fx-accent, #D4FF48)',
          background: 'var(--fx-bg, #0D0D0D)',
          foreground: 'var(--fx-fg, #FFFFFF)',
          muted: {
            DEFAULT: 'var(--fx-bg-elev2, #191919)',
            foreground: 'var(--fx-fg-muted, rgba(255,255,255,0.6))',
          },
          card: {
            DEFAULT: 'var(--fx-bg-elev1, #242424)',
            foreground: 'var(--fx-fg, #FFFFFF)',
          },
          popover: {
            DEFAULT: 'var(--fx-bg-elev1, #242424)',
            foreground: 'var(--fx-fg, #FFFFFF)',
          },
          accent: {
            DEFAULT: 'var(--fx-accent, #D4FF48)',
            foreground: 'var(--fx-bg, #0D0D0D)',
          },
          primary: {
            DEFAULT: 'var(--fx-accent, #D4FF48)',
            foreground: 'var(--fx-bg, #0D0D0D)',
          },
          secondary: {
            DEFAULT: 'var(--fx-bg-elev2, #191919)',
            foreground: 'var(--fx-fg, #FFFFFF)',
          },
          destructive: {
            DEFAULT: 'var(--fx-danger, #BE3636)',
            foreground: 'var(--fx-fg, #FFFFFF)',
          },
          success: { DEFAULT: 'var(--fx-success, #1B9D4B)' },
          danger: { DEFAULT: 'var(--fx-danger, #BE3636)' },
          info: { DEFAULT: 'var(--fx-info, #639CF8)' },
        },
        borderRadius: {
          lg: 'var(--radius-lg, 12px)',
          md: 'var(--radius-md, 8px)',
          sm: 'var(--radius-sm, 4px)',
        },
      },
    },
  };
}

export const forgeaxPreset = createForgeaxPreset();
