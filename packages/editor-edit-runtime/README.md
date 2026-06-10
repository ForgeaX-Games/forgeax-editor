# `@forgeax/editor-edit-runtime`

> forgeax editor Edit 模式运行时 — 引擎启动 + 相机 + 天光 + seed + sync + dock shell（DockManager、DetachedPanel）+ zustand store + EditorApp shell 快捷键 + 右键菜单服务。

## 导入示例

```ts
import {
  bus,
  dispatch,
  EditorApp,
  DockManager,
  DetachedPanel,
  createEngineSync,
  setupEditorSkylight,
  createViewport,
} from '@forgeax/editor-edit-runtime';
```

> [!NOTE]
> 大部分导出来自一个共享的 zustand store（`store.ts`），它是 app-level singleton。在单个 Edit mode iframe 内多次 import 同一 store 不会创建多实例。

## exports 子入口

| 入口 | 说明 |
|:--|:--|
| `.` | Store、操作、UI 组件、引擎集成、dock shell |
| `./package.json` | 包元信息 |

## troubleshooting

| 症状 | 原因 | 解决 |
|:--|:--|:--|
| `useDocVersion` 返回不更新 | store listener 未注册到 bus | 确认调用了 `onSelectionChange` / `onGizmoModeChange` 等注册函数 |
| 剪贴板操作报错 `undefined` | `copySelected` 依赖 DOM `navigator.clipboard` | 确保在安全上下文（HTTPS 或 localhost）中运行 |