# `@forgeax/editor-content-browser`

> forgeax editor 内容浏览器 — 资源浏览子应用。以往内嵌在 `editor-panels/src/content-browser/`（2.8k 行，比 8 个正牌 panel 加起来还大），现抽出为独立包，让 `editor-panels` 回归纯粹的「面板包」。

## AI 最小命题

Content Browser 只消费 core 的 producer facts：producer token →
`assetCatalog({ compatibleWith })` → `describeComponent('ParticleEffectPlayer')`
→ generic `bindAssetRef`。人类 AssetPicker 与 AI query 读取同一个 core
projection，因此不在本包维护 `particle-effect` 或其他 concrete-kind switch。

```ts
const assets = gateway.assetCatalog({ compatibleWith: 'ParticleEffectAsset' });
if (assets.ok) {
  console.table(assets.assets.map(({ guid, name }) => ({ guid, name })));
}
```

`IMPORT_FORMATS` 的事实 owner 是 `@forgeax/editor-core` 的 scan surface；本包
只消费并展示它。`.particle.json` 的 source cook 位于 build-side importer，
Content Browser 与 runtime 都通过 cooked GUID/Pack v2 读取，不在 UI 内重写
converter 或建立第二个 registry。

<details>
<summary>错误、恢复与边界</summary>

- `asset-compatibility-token-unknown` 是结构化失败，显示 hint 并引导调用 `describeComponent`；禁止用空列表隐藏 schema 缺失。
- readiness 的 `committed-awaiting-reload`、`resident-ready`、`simulation-ready`、`render-ready` 与 `visible-ready` 属于 core 的 correlated projection，本包不创建本地 run store。
- Edit/Play world 不是同一批 live handles；浏览器只展示 catalog identity 与 producer metadata。visual evidence 由 verify 阶段采集。
</details>

## 职责

资源浏览器的完整功能域：网格 / 列表 / 分栏三种视图、过滤 / 排序 / 导航历史 / 多选 / 收藏 / 缩略图 hooks、拖拽生成、导入管线（FBX / glTF cook 经 editor-core）。它以一个 panel 的形式呈现（Assets 面板 lazy-import 本包的 `ContentBrowser`），但代码量与内聚度已是独立包级别。

## 导入示例

```ts
// Assets 面板通过 lazy import 消费本包（唯一入口）
const ContentBrowser = lazy(() =>
  import('@forgeax/editor-content-browser').then(m => ({ default: m.ContentBrowser }))
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

## Imported source lifecycle projection

The browser is a read projection over the immutable Catalog. It discovers source operations from the
Gateway manifest, renders `sourceKey`, revision, current/LKG, lifecycle, diagnostics, and structured
discard impact, then dispatches the selected canonical operation through the same Gateway door as AI.
It does not open Meta files, call DDC, maintain a second Catalog, or infer identity from paths.

The UI must keep `current` and `lastKnownGood` visible when a cook fails. Confirmation is required for
`discardSourceOverridesAndReimport`; a stale revision or missing source key routes back to preflight.
Timeouts and Catalog gaps route to `catalog.reconcile`, while retryable cook/validation failures use
`run.retry` with a new request id. Error handling branches on stable fields, never message text.
