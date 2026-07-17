# Editor UI Primitives Plan

> 日期：2026-07-17  
> 状态：规划建议  
> 范围：`forgeax-editor` 内部 UI 原语包，不包含 Studio shell / `interface` 组件迁移。

---

## 0. 结论

`editor` 应新增一个自有 UI 原语包：`@forgeax/editor-ui`。

> [!IMPORTANT]
> `@forgeax/design` 是共享视觉契约；`@forgeax/interface/src/components/ui/*` 不是 editor 的组件库。
> editor 要使用 shadcn 风格原语时，应在 editor 内部拥有源码，而不是 deep import interface 的 UI 组件。

目标形态：

```txt
@forgeax/design
  ↑
@forgeax/editor-ui
  ↑
@forgeax/editor-content-browser
@forgeax/editor-panels
@forgeax/editor-edit-runtime
```

`@forgeax/editor-ui` 是 **React UI-only primitives package**：只放无业务语义的原语组件，不放 editor 业务逻辑，不依赖 `editor-core`。

---

## 1. 为什么需要独立 `editor-ui`

| 选择 | 结论 | 原因 |
|:--|:--|:--|
| 放进 `editor-core` | ❌ | `editor-core` 是 headless editor kernel，不能引入 React / Radix / Tailwind UI 依赖 |
| 放进 `edit-runtime` | ❌ | `panels` / `content-browser` 不能反向依赖 runtime 层 |
| 复用 `interface/components/ui` | ❌ | 破坏 submodule 独立性，把 editor 绑到 interface 源码布局和组件 API |
| 新建 `@forgeax/editor-ui` | ✅ | 保持 DAG，editor 拥有自己的 shadcn 源码，同时共享 design token |

---

## 2. 包结构

```txt
packages/editor/packages/ui/
  package.json
  tsconfig.json
  src/
    index.ts
    lib/
      utils.ts
    components/
      button.tsx
      input.tsx
      textarea.tsx
      checkbox.tsx
      radio-group.tsx
      switch.tsx
      select.tsx
      label.tsx
      tooltip.tsx
```

建议导出：

```json
{
  "name": "@forgeax/editor-ui",
  "exports": {
    ".": "./src/index.ts",
    "./button": "./src/components/button.tsx",
    "./input": "./src/components/input.tsx",
    "./textarea": "./src/components/textarea.tsx",
    "./checkbox": "./src/components/checkbox.tsx",
    "./radio-group": "./src/components/radio-group.tsx",
    "./switch": "./src/components/switch.tsx",
    "./select": "./src/components/select.tsx",
    "./label": "./src/components/label.tsx",
    "./tooltip": "./src/components/tooltip.tsx"
  }
}
```

---

## 3. 依赖规则

| 包 | 允许依赖 | 禁止依赖 |
|:--|:--|:--|
| `@forgeax/editor-ui` | `react`, `@radix-ui/*`, `lucide-react`, `clsx`, `tailwind-merge`, `class-variance-authority`, `@forgeax/design` | `@forgeax/editor-core`, `@forgeax/editor-panels`, `@forgeax/editor-edit-runtime`, `@forgeax/interface/src/components/ui/*` |
| `@forgeax/editor-panels` | `@forgeax/editor-core`, `@forgeax/editor-content-browser`, `@forgeax/editor-ui` | direct Radix/shadcn copies unless promoting into `editor-ui` |
| `@forgeax/editor-content-browser` | `@forgeax/editor-core`, `@forgeax/editor-ui` | interface UI internals |
| `@forgeax/editor-edit-runtime` | `@forgeax/editor-core`, `@forgeax/editor-panels`, `@forgeax/editor-ui` | owning generic primitives |

> [!NOTE]
> `editor-ui` should not depend on `editor-core`. A Button, Select, Switch, or Input should not know what an Entity, Scene, Gateway, or Asset is.

---

## 4. Style Contract

Components should use semantic Tailwind classes, not hard-coded product colors:

```txt
bg-background
text-foreground
text-muted-foreground
border-input
bg-popover
text-popover-foreground
focus:ring-ring
bg-accent
text-accent-foreground
text-destructive
```

Resolution chain:

```txt
editor-ui className
  -> @forgeax/design Tailwind preset
  -> --fx-* bridge variables
  -> --color-* semantic tokens
  -> --prim-* primitive tokens
```

`@forgeax/design` remains the only shared visual contract.

---

## 5. Tailwind Integration

Editor should add an editor-root Tailwind config once `editor-ui` starts using shadcn classes:

```ts
import animate from 'tailwindcss-animate'
import { createForgeaxPreset } from './packages/interface/packages/design/preset'

export default {
  presets: [createForgeaxPreset()],
  content: [
    './standalone/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
    './packages/ui/src/**/*.{ts,tsx}',
    './packages/content-browser/src/**/*.{ts,tsx}',
    './packages/panels/src/**/*.{ts,tsx}',
    './packages/edit-runtime/src/**/*.{ts,tsx}',
  ],
  corePlugins: { preflight: false },
  plugins: [animate],
}
```

CSS entry:

```css
@import '@forgeax/design/tokens.css';

@tailwind base;
@tailwind components;
@tailwind utilities;
```

> [!WARNING]
> Keep `preflight: false` during migration. Existing editor chrome still relies on `theme.css`; Tailwind reset must not silently rewrite toolbar / DockShell / panel behavior.

---

## 6. First Primitive Set

| Primitive | Implementation base | First likely consumers |
|:--|:--|:--|
| `Input` | native input + token classes | `Inspector`, `Launcher`, asset metadata forms |
| `Textarea` | native textarea + token classes | long string fields / notes |
| `Checkbox` | Radix Checkbox + lucide Check | boolean component fields |
| `RadioGroup` | Radix RadioGroup | mode choice / exclusive options |
| `Switch` | Radix Switch | binary settings where toggle UX is clearer |
| `Select` | Radix Select + lucide Chevron / Check | enum fields, asset filters, launcher options |
| `Label` | Radix Label | form control accessibility |
| `Tooltip` | Radix Tooltip | dense editor controls |

---

## 7. Import Style

Business packages should import via package subpaths:

```tsx
import { Input } from '@forgeax/editor-ui/input';
import { Checkbox } from '@forgeax/editor-ui/checkbox';
import { Switch } from '@forgeax/editor-ui/switch';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@forgeax/editor-ui/select';
```

Avoid:

```tsx
import { Select } from '../../ui/src/components/select';
import { Select } from '@forgeax/interface/components/ui/select';
```

---

## 8. Migration Plan

- [ ] M1: Create `@forgeax/editor-ui` skeleton with `cn()`, `Button`, `Input`, `Label`.
- [ ] M2: Add `Checkbox`, `RadioGroup`, `Switch`, `Select`, `Textarea`, `Tooltip`.
- [ ] M3: Add Tailwind preset/content wiring and a scoped CSS entry.
- [ ] M4: Migrate low-risk `Inspector` fields first: string, number, bool, enum.
- [ ] M5: Migrate `Launcher`, `AssetInspector`, and Content Browser filters.
- [ ] M6: Leave `ViewportBar` / `GameOverlay` on `theme.css` until there is a clear reuse benefit.
- [ ] M7: Add a boundary lint rule: `editor-ui` must not import editor domain/runtime packages or interface UI internals.

---

## 9. Non-goals

| Non-goal | Reason |
|:--|:--|
| Replace all `theme.css` immediately | High blast radius; viewport chrome is specialized |
| Build a shared ForgeaX component library in `interface` | Violates current shadcn ownership stance |
| Put editor operations into UI components | UI primitives must remain stateless/domain-free |
| Force all business components to use shadcn at once | Incremental migration keeps editor stable |

