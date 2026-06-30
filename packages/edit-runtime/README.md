# `@forgeax/editor-edit-runtime`

> forgeax editor Edit 模式运行时 — 引擎启动 + 相机 + 天光 + seed + sync + dock shell（DockManager、DetachedPanel）+ EditorApp shell 快捷键。

> [!IMPORTANT]
> Runtime 服务（zustand store、实体操作、右键菜单、dock 桥接、面板 manifest）已迁移至 `@forgeax/editor-shared`。如需使用 `bus`、`dispatch`、`useSelection` 等，应从 `@forgeax/editor-shared` import。

## 导入示例

```ts
// UI 组件（本包）
import {
  EditorApp,
  DockManager,
  DetachedPanel,
} from '@forgeax/editor-edit-runtime';

// 引擎集成（本包）
import {
  createEngineSync,
  setupEditorSkylight,
  createViewport,
} from '@forgeax/editor-edit-runtime';

// Runtime 服务（从 shared）
import { bus, dispatch, useSelection } from '@forgeax/editor-shared';
```

## exports 子入口

| 入口 | 说明 |
|:--|:--|
| `.` | UI 组件（DockManager、DetachedPanel、EditorApp、ViewportBar、ViewportHints）、引擎集成（createEngineSync、setupEditorSkylight、createViewport） |
| `./package.json` | 包元信息 |

## troubleshooting

| 症状 | 原因 | 解决 |
|:--|:--|:--|
| `useDocVersion` 返回不更新 | store listener 未注册到 bus | 确认调用了 `onSelectionChange` / `onGizmoModeChange` 等注册函数（均在 `@forgeax/editor-shared`） |
| `Cannot find module 'bus' from '@forgeax/editor-edit-runtime'` | Runtime 服务已迁移至 shared | 改为 `import { bus } from '@forgeax/editor-shared'` |
| 剪贴板操作报错 `undefined` | `copySelected` 依赖 DOM `navigator.clipboard` | 确保在安全上下文（HTTPS 或 localhost）中运行 |