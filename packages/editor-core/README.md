# `@forgeax/editor-core`

> forgeax editor 核心逻辑层 — SceneDocument 单一真相源、EditorBus 命令总线、undo/redo、组件 schema 注册表、跨窗同步、动画、材质图、资源、预设。

## 导入示例

```ts
import {
  EditorBus,
  createDocument,
  applyCommand,
  childrenOf,
  type SceneDocument,
  type EditorCommand,
  type EntityId,
} from '@forgeax/editor-core';
```

## exports 子入口

| 入口 | 说明 |
|:--|:--|
| `.` | 所有核心类型与函数（见上方 import 示例） |
| `./package.json` | 包元信息 |

## troubleshooting

| 症状 | 原因 | 解决 |
|:--|:--|:--|
| `Module '"@forgeax/editor-core"' has no exported member 'X'` | 导出未从子模块 re-export 到 `src/index.ts` | 检查 `src/index.ts` 是否缺该导出的 re-export 行 |
| 使用了 `EditorPanelId` 但此处不导出 | `EditorPanelId` 的 SSOT 在 `@forgeax/editor-panels/panels` | 改为 `import { type EditorPanelId } from '@forgeax/editor-panels/panels'` |