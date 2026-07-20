# `@forgeax/editor-panels`

> forgeax editor 业务面板清单 — 8 个可停靠面板组件（Hierarchy、Inspector、Assets、History、Capabilities、Material、Timeline、MaterialGraph）及面板组件注入。

## 导入示例

```ts
// 面板 manifest（SSOT 在 @forgeax/editor-shared，此处 re-export）
import { EDITOR_PANELS, type EditorPanelId } from '@forgeax/editor-panels';

// 面板组件
import { HierarchyPanel, InspectorPanel } from '@forgeax/editor-panels';

// 面板组件查找表
import { EDITOR_PANEL_COMPONENTS } from '@forgeax/editor-panels';
```

## exports 子入口

| 入口 | 导出 | 说明 |
|:--|:--|:--|
| `.` | `HierarchyPanel`, `InspectorPanel`, `AssetsPanel`, `HistoryPanel`, `CapabilitiesPanel`, `EDITOR_PANELS`, `EditorPanelId`, `EDITOR_PANEL_COMPONENTS` | 面板组件 + manifest re-export + 组件查找表 |
| `./panels` | `EDITOR_PANELS`（常量数组）, `EditorPanelId`（联合类型） | 面板 manifest（re-export from `@forgeax/editor-shared`） |

### `EDITOR_PANELS` 常量

```ts
export const EDITOR_PANELS = [
  'hierarchy',
  'inspector',
  'assets',
  'history',
  'capabilities',
  'timeline',
  'matgraph',
] as const;  // SSOT in @forgeax/editor-shared, re-exported here
```

### `EditorPanelId` 类型

```ts
export type EditorPanelId = (typeof EDITOR_PANELS)[number];
// = 'hierarchy' | 'inspector' | 'assets' | 'history'
//   | 'capabilities' | 'timeline' | 'matgraph'
```

## troubleshooting

| 症状 | 原因 | 解决 |
|:--|:--|:--|
| `Module '"@forgeax/editor-panels/panels"' has no exported member 'EDITOR_PANELS'` | `src/manifest.ts` 未从 shared re-export | 检查 `manifest.ts` 是否 `export { EDITOR_PANELS } from '@forgeax/editor-shared'` |
| 面板 ID 列表与 `sync-channel` 不一致 | core 的 sync-channel.ts 内联了复制 | sync-channel.ts 内联了面板列表以断 core↔shared 环——新增面板时需同时更新 `@forgeax/editor-shared/src/manifest.ts` 与 `editor-core/src/sync-channel.ts` |