# @forgeax/design

The ForgeaX/ForgeaX **design system SSOT**. React-free. Shared by the host
(`packages/interface`) and every workbench plugin so they speak one visual
language **without sharing a component bundle**.

> This package holds *data* (tokens + a Tailwind preset + theme helpers), not
> components. shadcn components live in each project's own `src/components/ui/`
> (the shadcn way). They stay visually consistent because everyone imports the
> same tokens + preset from here. See the rearch plan doc `04-SHARED-UI-PACKAGE`.

## What's inside

| File | Purpose |
|---|---|
| `tokens.css` | Single CSS entrypoint: primitives → semantic → `--fx-*` bridge. Import once per bundle. |
| `styles/primitive.css` | Raw scale values (`--prim-*`). |
| `styles/semantic.css` | Semantic tokens (`--color-*`) + back-compat aliases. |
| `styles/fx-bridge.css` | Short `--fx-*` namespace the Tailwind preset reads. |
| `preset.ts` | `createForgeaxPreset()` — bridges `--fx-*` / `--radius-*` into Tailwind's color + radius scale. |
| `theme.ts` | `applyTheme()` / `readTheme()` — dual-marks `data-theme` + `.dark`. |

## Usage

```ts
// tailwind.config.ts
import { createForgeaxPreset } from '@forgeax/design/preset'
import animate from 'tailwindcss-animate'

export default {
  presets: [createForgeaxPreset()],
  plugins: [animate],
  content: ['./src/**/*.{ts,tsx,html}', './index.html'],
}
```

```ts
// app entry
import '@forgeax/design/tokens.css'
import { applyTheme } from '@forgeax/design/theme'
applyTheme('dark')
```

Consumers must have `tailwindcss` and `tailwindcss-animate` installed (declared
here as optional peers).
