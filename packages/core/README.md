# `@forgeax/editor-core`

> forgeax editor 核心逻辑层 — EditSession 单一真相源（scene-as-asset）、EditorBus 命令总线、undo/redo、组件 schema 注册表、跨窗同步、动画、材质图、资源、预设。

## Minimal AI path

Asset capabilities flow through one discoverable path: producer token →
`assetCatalog({ compatibleWith })` → `describeComponent('ParticleEffectPlayer')`
→ generic `bindAssetRef`. Callers neither inspect source nor guess concrete asset kinds:

```ts
const component = gateway.describeComponent('ParticleEffectPlayer');
const candidates = gateway.assetCatalog({ compatibleWith: 'ParticleEffectAsset' });
if (component.ok && candidates.ok) {
  await gateway.dispatch({
    kind: 'bindAssetRef',
    entity,
    component: component.name,
    field: 'effect',
    assetType: 'ParticleEffectAsset',
    guids: candidates.assets.map((asset) => asset.guid),
    requestId: 'bind-particle-1',
  }, 'ai');
}
```

The authored `ParticleEffectPlayer` schema contains `effect`, `playing`, `seed`, and
`timeScale`. `gateway.listOps()` exposes the generic bind's `assetType`, `guids`, and
`requestId`; `runtime-ui-diagnostics.schema.json` defines machine-readable readiness
and structured error fields. A successful import terminal result reports only
`committed-awaiting-reload`, together with `requestId`, `assetGuid`,
`committedRevision`, `residentRevision`, and `hint`; it never presents a commit as
visible-ready.

`gateway.listOps()` is a live capability projection, not a static promise. Every
descriptor joins its catalog contract with the currently registered applier and
reports `availability`; downstream Runtime registrations publish a monotonically
increasing revision through `operationCapabilitySnapshot()` and
`subscribeOperationCapabilities()`. Unmounting an owner removes its executor from
the projection. Consumers must rediscover after a revision change instead of caching
boot-time operation availability.

Described downstream appliers may also declare `operationRun` metadata. When
such an executor returns a Promise, the canonical Gateway derives the
`requestId` from the live descriptor, creates the one authoritative
`OperationRun`, and does not report success until the downstream completion is
terminal. This is the generic seam used by replaceable preview executors; it is
not a VFX-specific allowlist and downstream hosts must not create a second run
journal.

<details>
<summary>Errors, recovery, and boundaries</summary>

- `asset-compatibility-token-unknown` means no producer schema declared the token. Read `describeComponent` first; do not treat an empty array as success.
- Loader, revision, render, and stale-handle failures return stable `code`, `expected`, `actual`, `hint`, and `retryable` fields. Follow recovery actions to re-query, retry, Stop/Play, or reopen.
- Readiness is a bounded projection for one `requestId + assetGuid + revision`. Edit- and Play-world handles are not interchangeable, and background work never rewrites a terminal run.
- Visual evidence belongs to verification. Core exposes machine-readable facts instead of substituting toasts, console output, or screenshots for state.
</details>

## Asset impact reads

`EditGateway.assetImpact({ operation, guid })` or `assetImpact({ operation, sourcePath })` is the
read-only, AI-usable preview for asset `delete`, `move`, and `reimport`. It derives direct and
transitive referencers from the engine producer catalog's `relations` on every call; it does not
create a second dependency index. A catalog row with no producer relations falls back to its legacy
`refs` field. Pass exactly one selector, inspect `resolution`, `targets`, `directReferencers`,
`transitiveReferencers`, `blocking`, and `confirmation.required`, then invoke the existing Gateway
write operation. The preview itself never mutates the document, catalog, or source files.

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
| `./diagnostics` | Diagnostics snapshot/query types and the pure bounded query projection |
| `./package.json` | 包元信息 |

## Asset source workflow

AI and UI callers share the same Gateway path: `listOps()` → `previewAssetSourceMutation` →
`saveAssetSourceOverride` or `reimportAsset` → `waitOperationRun(requestId)`. Use
`discardSourceOverridesAndReimport` only after preflight returns the impact set and its
`confirmationToken`. The stable identity tuple is `guid` + `scope.sourceKey` + `expectedRevision`;
the Catalog is the read SSOT and no caller reads DDC or edits Meta files directly.

Operation runs expose `accepted`/`running`, terminal `succeeded`/`failed`/`cancelled`, and Gateway
read methods `getOperationRun`, `waitOperationRun`, and `subscribeOperationRun`. Recovery actions are
`asset.preflight`, `run.get`, `run.wait`, `run.retry`, and `catalog.reconcile`. Branch on the public
error `code`, `phase`, `expected`, `actual`, `retryable`, and `recoveryActions`; never parse `hint` or
`message`.

| Error index | Recovery |
|:--|:--|
| `asset-source-key-*`, `asset-meta-revision-conflict`, `asset-confirmation-*` | Re-run preflight with the current Catalog fact |
| `asset-validation-failed`, `asset-cook-failed`, `run-cancelled-before-cas` | Retry with a new request id when `retryable` |
| `asset-publish-observation-timeout`, `asset-catalog-subscription-gap` | Reconcile Catalog, then read the existing run |
| `asset-operation-cas-committed` | Read the terminal run; do not duplicate the mutation |

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
