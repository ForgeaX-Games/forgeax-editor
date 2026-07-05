# `@forgeax/editor-content-browser`

> forgeax editor 内容浏览器 — 资源浏览子应用。以往内嵌在 `editor-panels/src/content-browser/`（2.8k 行，比 8 个正牌 panel 加起来还大），现抽出为独立包，让 `editor-panels` 回归纯粹的「面板包」。

## 职责

资源浏览器的完整功能域：网格 / 列表 / 分栏三种视图、过滤 / 排序 / 导航历史 / 多选 / 收藏 / 缩略图 hooks、拖拽生成、导入管线（FBX / glTF cook 经 editor-core）。它以一个 panel 的形式呈现（Assets 面板 lazy-import 本包的 `ContentBrowserV2`），但代码量与内聚度已是独立包级别。

## 导入示例

```ts
// Assets 面板通过 lazy import 消费本包（唯一入口）
const ContentBrowserV2 = lazy(() =>
  import('@forgeax/editor-content-browser').then(m => ({ default: m.ContentBrowserV2 }))
);

// 子组件 / hooks / 类型
import { CBGrid, CBList, useFilter, type CBAsset } from '@forgeax/editor-content-browser';
```

## 依赖

- `@forgeax/editor-core` — 资源操作（rename/duplicate/delete/createDirectory）、cook、GUID、path-resolver、ApiClient seam。**只经 editor-core 触达引擎，本包不直接 import 任何 `@forgeax/engine-*`。**
- `@tanstack/react-virtual` — 虚拟滚动（CBGrid / CBList / CBColumn）。

## DAG 位置

`engine ← editor-core ← editor-content-browser ← editor-panels ← edit-runtime`

与 `editor-panels` 同层依赖 `editor-core`；`editor-panels` 的 Assets 面板反过来依赖本包（lazy import）。
