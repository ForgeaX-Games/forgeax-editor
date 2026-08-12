# `@forgeax/editor-panels`

> forgeax editor 业务面板清单 — 8 个可停靠面板组件（Hierarchy、Inspector、Assets、History、Capabilities、Material、Timeline、MaterialGraph）及面板组件注入。

## AI 最小命题

Inspector 的 generic `AssetPicker` 与 AI 使用同一条发现路径：producer token →
`assetCatalog({ compatibleWith })` → `describeComponent('ParticleEffectPlayer')`
→ generic `bindAssetRef`。Picker 不知道 `particle-effect` kind，也不复制
producer mapping；它只把字段的 `shared<T>` token 交给 Gateway。

```tsx
<AssetPicker
  assetType="ParticleEffectAsset"
  currentGuid={currentGuid}
  onPick={(guid) => void gateway.dispatch({
    kind: 'bindAssetRef', entity, component: 'ParticleEffectPlayer', field: 'effect',
    assetType: 'ParticleEffectAsset', guids: [guid], requestId: 'bind-particle-1',
  }, 'human')}
  onClose={() => setPickerOpen(false)}
/>
```

`ParticleEffectPlayer` 的 schema/manifest 公开四个 authored fields：`effect`、
`playing`、`seed`、`timeScale`。bind descriptor 还公开 `requestId` correlation；
成功后面板读取 terminal result 与 readiness projection，而不是把按钮完成或
toast 视为 visible-ready。

<details>
<summary>错误、恢复、world boundary 与 visual evidence</summary>

- 未知 token 显示 structured `code` 与 `hint`，恢复动作是先读取 component schema，再重新执行 generic query；不增加 VFX 专用 panel 或 document op。
- `committed-awaiting-reload` 只表示 catalog commit；后续 readiness 必须保持同一 request、asset 与 revision。stale handle 需要在当前 world 重新查询。
- 所有变更仍经 EditGateway；面板不直接写 World、EditSession、store 或 Pack。visual evidence、PNG 与 falsification 属于 verify/judgment，不是 panel 状态 owner。
</details>

## 导入示例

```ts
// 面板 manifest（SSOT 在 @forgeax/editor-core，此处 re-export）
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
| `./panels` | `EDITOR_PANELS`（常量数组）, `EditorPanelId`（联合类型） | 面板 manifest（re-export from `@forgeax/editor-core`） |

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
] as const;  // SSOT in @forgeax/editor-core, re-exported here
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
| `Module '"@forgeax/editor-panels/panels"' has no exported member 'EDITOR_PANELS'` | `src/manifest.ts` 未从 editor-core re-export | 检查 `manifest.ts` 是否 `export { EDITOR_PANELS } from '@forgeax/editor-core'` |
| 面板 ID 列表与 `manifest.ts` 不一致 | 读取了错误的 owner 或保留了旧复制 | `packages/core/src/manifest.ts` 是唯一 SSOT；新增面板时只更新该文件，并让此包继续 re-export |

## Diagnostics projection

`CapabilitiesPanel` renders the bounded, read-only `gateway.diagnostics.query()` projection through `diagnostics-view-model.ts`; the view model uses the same core query helper as AI callers. It provides source/severity/text filters, structured detail copy, and action buttons for locate, retry, and source reveal. The panel never implements a repair: the edit-runtime composition root installs the snapshot subscription and dispatches those actions through the existing Gateway operations (`setFolderSelection`, `setAssetSelectionOne`, `revealInFileManager`, and `retryOperationRun`).

When the host has not installed a projection source, the panel remains mountable and shows no diagnostics. This keeps the panel package testable without a World or a second diagnostic store.
