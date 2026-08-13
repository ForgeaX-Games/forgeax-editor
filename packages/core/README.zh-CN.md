# `@forgeax/editor-core`

> forgeax editor 核心逻辑层：EditSession 单一真相源（scene-as-asset）、EditorBus 命令总线、undo/redo、组件 schema 注册表、跨窗同步、动画、材质图、资源、预设。

## 视口网格偏好

Edit 主视口网格属于 editor chrome，不是 scene-pack 数据、document undo 条目或 Play World 组件。View、Settings 和 AI caller 都使用现有 Gateway session operation：

```ts
gateway.dispatch({
  kind: 'setViewportPreferences',
  patch: { gridVisible: true },
}, 'ai');
```

最小可发现 schema 是 `patch.gridVisible: boolean`，默认值是 `true`。它是 session preference，不创建 grid-specific action、catalog 或 shadow store。`gateway.listOps()` 是 live discovery surface；调用方应先读取当前 `setViewportPreferences` descriptor，再由 View、Settings 或 AI 使用同一个 operation。

参数无效、renderer 不可用或 carrier 正在恢复时，Gateway 返回既有 structured error envelope：`code`、`expected`、`actual`、`hint`、`retryable` 和 `recoveryActions`。恢复步骤是重新发现 live operation、读取 diagnostics snapshot、等待 ready state，再通过同一 operation 重试。不要用截图推断 readiness，也不要创建第二个 operation catalog。

## 最小 AI 路径

资源能力沿一条可发现路径流动：producer token → `assetCatalog({ compatibleWith })` → `describeComponent('ParticleEffectPlayer')` → 通用 `bindAssetRef`。调用方不读取源文件，也不猜测具体资产类型。

`ParticleEffectPlayer` schema 包含 `effect`、`playing`、`seed` 和 `timeScale`。`gateway.listOps()` 暴露通用 bind 的 `assetType`、`guids` 和 `requestId`；`runtime-ui-diagnostics.schema.json` 定义机器可读 readiness 与 structured error。导入 terminal result 只报告 `committed-awaiting-reload`，不把 commit 伪装成 visible-ready。

`gateway.listOps()` 是 live capability projection，不是静态承诺。每个 descriptor 与当前 applier 合并并报告 `availability`；Runtime registration 发布递增 revision，owner 卸载后 executor 从 projection 消失。调用方必须在 revision 变化后重新发现。

<details>
<summary>错误、恢复与边界</summary>

- `asset-compatibility-token-unknown` 表示没有 producer schema 声明 token；先读取 `describeComponent`，不要把空数组当成功。
- loader、revision、render 和 stale-handle 失败返回稳定的 `code`、`expected`、`actual`、`hint` 和 `retryable`，按 recovery actions 重新查询、重试、Stop/Play 或 reopen。
- readiness 是 `requestId + assetGuid + revision` 的有界 projection；Edit 与 Play World handle 不可互换。
- 视觉证据属于验证阶段；Core 提供机器事实，不以 toast、console 或截图替代状态合同。
</details>

## 资产影响读取

`EditGateway.assetImpact({ operation, guid })` 或 `assetImpact({ operation, sourcePath })` 是只读、AI 可用的 delete、move、reimport 影响预览。它从 engine producer catalog 的 `relations` 派生直接与传递引用，不创建第二个依赖索引；没有 producer relations 的 catalog row 才回退到 legacy `refs`。只能传入一个 selector，检查 `resolution`、`targets`、`directReferencers`、`transitiveReferencers`、`blocking` 和 `confirmation.required`，然后调用既有 Gateway write operation。

## 导入示例

```ts
import {
  EditorBus,
  createEditSession,
  applyCommand,
  childrenOf,
  type EditSession,
  type EditorCommand,
  type EntityId,
} from '@forgeax/editor-core';
```

## exports 子入口

| 入口 | 说明 |
|:--|:--|
| `.` | 所有核心类型与函数 |
| `./diagnostics` | Diagnostics snapshot/query 类型与纯 bounded projection |
| `./package.json` | 包元信息 |

## 资源源工作流

AI 与 UI 调用方共享 Gateway 路径：`listOps()` → `previewAssetSourceMutation` → `saveAssetSourceOverride` 或 `reimportAsset` → `waitOperationRun(requestId)`。只有 preflight 返回 impact set 与 `confirmationToken` 后，才能使用 `discardSourceOverridesAndReimport`。稳定身份元组是 `guid + scope.sourceKey + expectedRevision`；Catalog 是 read SSOT，调用方不直接读取 DDC 或编辑 Meta 文件。

Operation run 暴露 `accepted`/`running` 和 `succeeded`/`failed`/`cancelled` 终态。按公开的 `code`、`phase`、`expected`、`actual`、`retryable` 和 `recoveryActions` 分支，不要解析 `hint` 或 `message`。

| 错误索引 | 恢复 |
|:--|:--|
| `asset-source-key-*`、`asset-meta-revision-conflict`、`asset-confirmation-*` | 用当前 Catalog fact 重新运行 preflight |
| `asset-validation-failed`、`asset-cook-failed`、`run-cancelled-before-cas` | `retryable` 时用新 request id 重试 |
| `asset-publish-observation-timeout`、`asset-catalog-subscription-gap` | reconcile Catalog，再读取已有 run |
| `asset-operation-cas-committed` | 读取 terminal run，不要重复 mutation |

## Carrier 证据与 phase 隔离

网格只由权威 Edit Viewport Runtime projection。Game display、Clean Preview、Play 和资产预览派生隐藏 grid phase，但不改写 `gridVisible`；返回 Edit 后继续使用用户偏好。Play 使用全新的 Play World，Stop 返回持久 Edit World，因此网格不会进入 authored content。

standalone hard gate 是 `http://localhost:15290`，权威 runtime 是可见 shell 的 `iframe[title="ForgeaX Viewport Runtime"]`，其中 `/editor/` frame 拥有 Gateway、World、Registry 和 canvas。Studio hard gate 是 `http://localhost:18920`，必须在 Studio shell 内定位同类权威 `/editor/` runtime frame，不能复用 standalone artifacts。每份报告记录 candidate Editor SHA、Engine pin、operation schema、diagnostics、visible action trace 和独立 PNG/log/metrics 路径。端口可达或 raw preview 都不是 carrier 证据。

M0 Engine seam 是 conditional：只有可复现的 public no-vertex seam 失败，才允许 Engine owning layer 的通用修复、Engine remote-main 可达性和 Editor pin 更新。M0 通过时 Engine 保持不变；Editor 不得为任一 carrier 添加 backend-specific 或 raw-device workaround。

## 故障排查

Gateway 失败暴露稳定的 structured envelope：`code`、`hint`、`retryable`、recovery actions、operation/request correlation 和 payload-derived object references。按这些字段分支；human-readable hint 不是 protocol discriminator。实体引用必须通过 `validateEntityObjectRef()` gate 定位，避免 stale handle 静默解析到复用实体。

只读的 `gateway.diagnostics.snapshot()` projection 合并既有事实，不把 console 当作权威：bounded trace roots、ledger-owned scan diagnostics、asset-error bus 与 Gateway `OperationRun` snapshot。消费者应读取各 source 的结构化数组并按字段分支，不要抓取日志文本。

`gateway.diagnostics.query({ query, sources, severities, limit })` 提供 AI 友好的 bounded list，返回稳定 item IDs、`subjectRef`/`objectRefs`、retryability、recovery actions 以及 `matched`/`truncated`。Capabilities panel 使用同一个 query helper，不维护平行 diagnostic index。

| 症状 | 原因 | 解决 |
|:--|:--|:--|
| `Module ... has no exported member 'X'` | 导出没有从 `src/index.ts` re-export | 检查对应导出行 |
| 使用了 `EditorPanelId` 但此处不导出 | SSOT 在 `@forgeax/editor-panels/panels` | 从该入口导入 `EditorPanelId` |
