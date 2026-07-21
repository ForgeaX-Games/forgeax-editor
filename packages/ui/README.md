# @forgeax/editor-ui

Editor-owned React UI primitives.

This package is intentionally domain-free. It may depend on React, Radix,
lucide, CVA, and shared design tokens. It must not depend on editor-core,
editor-panels, edit-runtime, or interface component source.

## Import contract

Editor packages should import public subpaths:

```tsx
import { Input } from '@forgeax/editor-ui/input';
import { IconButton } from '@forgeax/editor-ui/icon-button';
import { Switch } from '@forgeax/editor-ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@forgeax/editor-ui/select';
```

Do not deep import `@forgeax/interface/src/components/ui/*`.

Use `IconButton` for icon-only controls such as dialog close buttons and toolbar
actions. Do not hand-roll clickable icon `<button>` styles inside composed
components.

## Style contract

Components use semantic Tailwind classes such as `bg-popover`, `border-input`,
`text-muted-foreground`, and `focus:ring-ring`. The consuming editor bundle must:

1. import `@forgeax/design/tokens.css`;
2. use `createForgeaxPreset()` from `@forgeax/design/preset`;
3. include `packages/ui/src/**/*.{ts,tsx}` in Tailwind content;
4. keep Tailwind preflight disabled while `theme.css` is still active.

## Overlays

Mount `EditorOverlayProvider` once near the editor app root:

```tsx
import { EditorOverlayProvider } from '@forgeax/editor-ui/overlays';

export function EditorRoot() {
  return <EditorOverlayProvider>{/* app */}</EditorOverlayProvider>;
}
```

Then app code can call service APIs:

```ts
import { confirm } from '@forgeax/editor-ui/confirm';
import { prompt } from '@forgeax/editor-ui/prompt';
import { toast } from '@forgeax/editor-ui/toast';

const ok = await confirm({ title: 'Delete node?', destructive: true });
const name = await prompt({ title: 'Rename node', defaultValue: 'Player' });
toast.success('Saved');
```
