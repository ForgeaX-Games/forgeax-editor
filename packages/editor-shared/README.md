# @forgeax/editor-shared

> Cross-layer shared runtime services and panel manifest for the forgeax editor.
> Breaks the dep cycle between editor-core, editor-panels, and editor-edit-runtime.

## Import

```ts
import {
  bus, dispatch, useSelection, useDocVersion,  // zustand store
  deleteEntityCascade, groupSelected,           // entity ops
  showContextMenu, type MenuItemDef,            // context menu
  focusPanel, openSourcePanel,                  // dock bridge
  EDITOR_PANELS, type EditorPanelId,            // panel manifest
} from '@forgeax/editor-shared';
```

## Exports

| Subpath | Contents |
|:--|:--|
| `.` | store (bus, dispatch, selection hooks, scene persistence), entity ops, context menu service, dock bridge, panel manifest (EDITOR_PANELS + EditorPanelId) |

## Dependencies

```
engine ← core ← shared ← panels ← edit-runtime / play-runtime
```

## troubleshooting

| Symptom | Cause | Fix |
|:--|:--|:--|
| `bun run typecheck` fails with `Cannot find module '@forgeax/editor-shared'` | Missing `bun install` or workspace resolution | `bun install` from forgeax-editor root |
| Import cycle detected by depcruise | A new dependency edge was added that forms a cycle | Check `.dependency-cruiser.cjs` no-circular rule; ensure imports follow the DAG above |