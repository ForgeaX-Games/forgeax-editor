# `@forgeax/editor-core`

> forgeax editor 核心逻辑层 — EditSession 单一真相源（scene-as-asset）、EditorBus 命令总线、undo/redo、组件 schema 注册表、跨窗同步、动画、材质图、资源、预设。

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
| `.` | 所有核心类型与函数（见上方 import 示例） |
| `./package.json` | 包元信息 |

## troubleshooting

Gateway failures expose the shared structured envelope from
`@forgeax/editor-product`: stable `code`, `hint`, `retryable`, recovery actions,
operation/request correlation, and payload-derived object references. Branch on
those fields; the human-readable hint is never a protocol discriminator. Entity
references may include a world-bound locator, but locating must go through the
exported `validateEntityObjectRef()` gate so stale handles cannot silently
resolve to a recycled or cross-world entity.

The read-only `gateway.diagnostics.snapshot()` projection joins existing facts
without making console output authoritative: bounded trace roots, ledger-owned
scan diagnostics, the asset-error bus, and the Gateway `OperationRun` snapshot.
Each source reports its retention and latest-wins dedupe policy, including
producer eviction counts where the owner exposes them. Consumers should read
the source-specific arrays and branch on structured fields rather than scrape
logs.

For one AI-friendly bounded list, use `gateway.diagnostics.query({ query,
sources, severities, limit })`. It is a pure projection over the same snapshot,
returns stable item IDs plus `subjectRef`/`objectRefs`, retryability, recovery
actions, and explicit `matched`/`truncated` facts. The Capabilities panel uses
the same query helper; it does not maintain a parallel diagnostic index.

| 症状 | 原因 | 解决 |
|:--|:--|:--|
| `Module '"@forgeax/editor-core"' has no exported member 'X'` | 导出未从子模块 re-export 到 `src/index.ts` | 检查 `src/index.ts` 是否缺该导出的 re-export 行 |
| 使用了 `EditorPanelId` 但此处不导出 | `EditorPanelId` 的 SSOT 在 `@forgeax/editor-panels/panels` | 改为 `import { type EditorPanelId } from '@forgeax/editor-panels/panels'` |
