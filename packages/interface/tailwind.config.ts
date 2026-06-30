import animate from 'tailwindcss-animate'
// Relative import (not the '@forgeax/design' alias): Tailwind's config loader
// resolves modules itself and does not see Vite/tsconfig aliases.
import { createForgeaxPreset } from './packages/design/preset'

const config = {
  // The shared design preset bridges --fx-* / --radius-* into Tailwind's
  // semantic color + radius scale and sets darkMode: ['selector', '[data-theme="dark"]'].
  presets: [createForgeaxPreset()],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // Preflight is Tailwind's CSS reset; keep it OFF so the migration is purely
  // additive and the existing hand-written CSS is never zeroed out. Re-evaluate
  // at the end of the migration (see rearch plan 03 §6 / 05 §7).
  corePlugins: { preflight: false },
  plugins: [animate],
}

export default config
