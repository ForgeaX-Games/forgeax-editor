# `@forgeax/editor-edit-runtime`

> forgeax editor Edit 模式运行时 — 引擎 in-process 启动（ViewportComponent）+ 相机 + 天光 + seed + host-boot 会话装配。单 realm 收敛后不再有 iframe/popout 壳。

> [!IMPORTANT]
> Runtime 服务（zustand store、实体操作、右键菜单、dock 桥接、面板 manifest）已迁移至 `@forgeax/editor-shared`。如需使用 `bus`、`dispatch`、`useSelection` 等，应从 `@forgeax/editor-shared` import。

## 导入示例

```ts
// UI 组件 + 引擎集成（本包）
import {
  ViewportBar,
  ViewportHints,
  setupEditorSkylight,
  createViewport,
  applyScriptChange,
  initHotReload,
} from '@forgeax/editor-edit-runtime';

// 单 realm 装配：host 经子入口 import viewport 组件 + host-boot 会话
import { ViewportComponent } from '@forgeax/editor-edit-runtime/engine/viewport-component';
import { initHostSession, configureHostSession } from '@forgeax/editor-edit-runtime/host-boot';

// Runtime 服务（从 shared）
import { bus, dispatch, useSelection } from '@forgeax/editor-shared';
```

## exports 子入口

| 入口 | 说明 |
|:--|:--|
| `.` | UI 组件（ViewportBar、ViewportHints）、引擎集成（setupEditorSkylight、createViewport）、热重载（applyScriptChange、initHotReload） |
| `./surface` | EditSurface（宿主壳） |
| `./host-boot` | host 会话装配（initHostSession、configureHostSession）—— 单 realm host 入口复用 |
| `./engine/viewport-component` | ViewportComponent —— in-process 引擎 viewport（canvas+world+renderer+camera） |
| `./package.json` | 包元信息 |

## troubleshooting

| 症状 | 原因 | 解决 |
|:--|:--|:--|
| `useDocVersion` 返回不更新 | store listener 未注册到 bus | 确认调用了 `onSelectionChange` / `onGizmoModeChange` 等注册函数（均在 `@forgeax/editor-shared`） |
| `Cannot find module 'bus' from '@forgeax/editor-edit-runtime'` | Runtime 服务已迁移至 shared | 改为 `import { bus } from '@forgeax/editor-shared'` |
| 剪贴板操作报错 `undefined` | `copySelected` 依赖 DOM `navigator.clipboard` | 确保在安全上下文（HTTPS 或 localhost）中运行 |