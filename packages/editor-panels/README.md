# `@forgeax/editor-panels`

> forgeax editor 业务面板清单 — 8 个可停靠面板组件（Hierarchy、Inspector、Assets、History、Capabilities、Material、Timeline、MaterialGraph）及面板 manifest 单一真相源。

## 导入示例

```ts
// 面板 manifest（推荐用法）
import { EDITOR_PANELS, type EditorPanelId } from '@forgeax/editor-panels/panels';

// 面板组件
import { HierarchyPanel, InspectorPanel } from '@forgeax/editor-panels';
```

## exports 子入口

| 入口 | 导出 | 说明 |
|:--|:--|:--|
| `.` | `HierarchyPanel`, `InspectorPanel`, `AssetsPanel`, `HistoryPanel`, `CapabilitiesPanel`, `MaterialPanel`, `MaterialGraphPanel`, `TimelinePanel`, `EDITOR_PANELS`, `EditorPanelId` | 面板组件 + manifest |
| `./panels` | `EDITOR_PANELS`（常量数组）, `EditorPanelId`（联合类型） | 面板 manifest SSOT — 所有需要面板 ID 的消费方统一从此入口导入，不再手写 `['hierarchy', ...]` |

### `EDITOR_PANELS` 常量

```ts
export const EDITOR_PANELS = [
  'hierarchy',
  'inspector',
  'assets',
  'history',
  'capabilities',
  'material',
  'timeline',
  'matgraph',
] as const;
```

### `EditorPanelId` 类型

```ts
export type EditorPanelId = (typeof EDITOR_PANELS)[number];
// = 'hierarchy' | 'inspector' | 'assets' | 'history'
//   | 'capabilities' | 'material' | 'timeline' | 'matgraph'
```

## troubleshooting

| 症状 | 原因 | 解决 |
|:--|:--|:--|
| `Module '"@forgeax/editor-panels/panels"' has no exported member 'EDITOR_PANELS'` | `src/manifest.ts` 未导出 | 检查 `src/manifest.ts` 是否保留 `export const EDITOR_PANELS = [...]` |
| 面板 ID 列表与 `sync-channel` 不一致 | 另一处隐式握手未清理 | `EDITOR_PANELS` 是本包 SSOT — `editor-core/sync-channel.ts` 的 `SyncPanelId` 从此 re-export |