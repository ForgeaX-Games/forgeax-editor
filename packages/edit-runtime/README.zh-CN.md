# `@forgeax/editor-edit-runtime`

> ForgeaX 编辑模式权威 Runtime：在一个可替换 carrier realm 中启动 Gateway、Edit/Play World、AssetRegistry、GPU canvas、相机和引擎拥有的 VFX Runtime。carrier 可以是 iframe、browser page 或 Tauri WebView；外层 panel 只消费 projection 并派发 Runtime operation。

> [!IMPORTANT]
> Runtime 服务（zustand store、实体操作、右键菜单、dock 桥接、面板 manifest）由 `@forgeax/editor-core` 持有。如需使用 `bus`、`dispatch`、`useSelection` 等，应从 `@forgeax/editor-core` 导入。

## 导入示例

```ts
import {
  ViewportBar,
  createViewport,
  applyScriptChange,
  initHotReload,
} from '@forgeax/editor-edit-runtime';

import { ViewportComponent } from '@forgeax/editor-edit-runtime/viewport/viewport-component';
import { initHostSession, configureHostSession } from '@forgeax/editor-edit-runtime/host-boot';
import { bus, dispatch, useSelection } from '@forgeax/editor-core';
```

## exports 子入口

| 入口 | 说明 |
|:--|:--|
| `.` | UI 组件、引擎集成和热重载 |
| `./host-boot` | host 会话装配，复用单 realm host 入口 |
| `./viewport/viewport-component` | 一个 Runtime realm 内的 canvas、World、renderer、camera |
| `./package.json` | 包元信息 |

## VFX 生命周期合同

Edit 侧由 `ViewportComponent` 创建且只创建一个 `VfxRuntimeHost`。host 的 `feature` 在 `createApp` 前注入；成功后先绑定持久 Edit World 与共享 `AssetRegistry`，再在每次 Play 中绑定全新的 Play World。GPU 模拟、资源 registry 和实体身份仍由 engine 所有，编辑器只读取 camera、委托生命周期，并把 Renderer 的 `renderFeatureDiagnostics()` 投影到既有 diagnostics gateway。

### World 与身份边界

| 对象 | 所有者 | 生命周期 | 约束 |
|:--|:--|:--|:--|
| Edit World | Edit viewport / `WorldManager` | viewport 会话 | 持久编辑世界；Play 期间不被 Play handle 替换 |
| Play World | `RunLifecycle` / `assemblePlayWorld` | 单次 Play | 每次 Play 新建，Stop 后丢弃；不写回 Edit World |
| `VfxRuntimeHost` | `ViewportComponent` | viewport 会话 | Edit 与每次 Play 复用同一实例；`attachWorld` / `detachWorld` 必须幂等 |
| `AssetRegistry` | renderer / engine | host 会话 | Edit 与 Play 使用同一 renderer assets fact，不在编辑器侧复制 registry |
| `EntityHandle` | 对应 ECS World | 对应 World / epoch | 不跨 World、Play/Stop 边界复用；失效后重新查询 active World |

## Viewport Runtime transport

同一个 `ViewportComponent` 运行在 iframe、browser page 或 Tauri WebView 中时，仍是 Gateway、EditWorld 与 Registry 的唯一 owner。所有 carrier 都承载现有 `editor-transport/v1`，不创建第二套操作表。

| Carrier | 物理形态 | Transport | 切换约束 |
|:--|:--|:--|:--|
| `iframe` | docked shell iframe | source/origin + challenge 校验后转移 `MessagePort` | 默认路径 |
| `browser-page` | `window.open` popup | 同源、generation-fenced `BroadcastChannel` | 旧 Runtime 先 flush/stop，再启动 popup |
| `tauri-webview` | Tauri v2 `WebviewWindow` | 同一条 generation-fenced `BroadcastChannel` | 旧 Runtime 先 flush/stop，再启动 WebView |

Broadcast carrier 只改变传输介质；请求仍交给同一个 `createViewportRuntimeTransportService`，不会复制 Gateway、projection、operation manifest 或 World。projection envelope 携带 `runtimeId`、`runtimeGeneration` 与 revision，并区分 `ready`、`empty`、`unavailable` 和 `faulted`。World、Renderer、Registry、DOM 节点和函数闭包都不跨 Realm 传输；shell 只投影 Runtime `discover` 返回的 operation。

Runtime operation discovery 遵循统一 applier registry 的 live projection。未挂载的 static catalog entry 明确报告 `unavailable`；下游 registration 在 revision 变化时出现并在 disposal 时消失。carrier generation 拆除时 transport 同时释放 subscription 与 selector，重连 panel 不会保留 stale capability。

### Replaceable preview executor lease

Preview canvas 与 Shell panel 同域，但 command 仍是 canonical Runtime operation。forward carrier handshake 成功后，Shell 转移一个经 source、origin、Runtime identity、generation 和 one-shot challenge 认证的第二个 `MessagePort`。reverse port 只承载按 `kind + assetGuid + generation` 绑定的通用 executor lease，不承载第二套 capability catalog 或 raw World/controller reference。

VFX workbench 在 lease 存活期间绑定 `vfx.preview.play`、`pause`、`reset`、`seek`、`setEmitterMask`、`frameBounds` 和 `setBoundsVisible`。Human toolbar handler 与 AI caller 都使用 `dispatchViewportRuntimeOperation`。断开、资产替换或 generation 变化会移除这些 applier，并用 structured stale/disconnected failure 拒绝进行中的操作。Preview pause 冻结 mini-world scheduler，不改 authored `ParticleEffectPlayer.playing`。

## Play dirty policy

`play` 是 Gateway session operation。可选 `dirtyPolicy` 为 `last-saved`、`save-then-play` 或 `cancel`；人类 UI projection 与 AI dispatch 使用同一 operation 和 persistence 的 `gateway.hasPendingDiskSave()` 读取。`save-then-play` 等待 canonical Gateway save 完成后再加载最新 `SceneAsset`。

## Source publication and Play barrier

Edit Runtime 通过 Gateway operation run 与 Catalog projection 观察 imported source publication。最短路径是 discover → preview → submit → wait → reconcile/retry；Runtime 不成为第二个 Meta、DDC、Catalog 或 run owner。当前 projection 成功后，fresh Edit reopen 与 Play 必须暴露相同的 `guid`、`sourceKey` 和 revision。所有 source error 都是结构化的 `code`、`phase`、`expected`、`actual`、`retryable` 和 `recoveryActions`，不从 UI message 解码。

## 故障排查

| 症状 | 原因 | 解决 |
|:--|:--|:--|
| `useDocVersion` 不更新 | store listener 没有注册到 bus | 确认调用 `onSelectionChange` / `onGizmoModeChange` 等 core 函数 |
| `Cannot find module 'bus'` | Runtime 服务由 editor-core 持有 | 从 `@forgeax/editor-core` 导入 `bus` |
| VFX readiness 不可用 | host 没绑定当前 World，或 renderer assets 尚未 ready | 检查 `createApp(features)`、Edit `attachWorld` 与 Play `attachWorld`，不要在 UI 创建第二个 host |
| Stop 后出现 stale/cross-world handle | 保存了旧 Play handle | 重新查询 `gateway.activeWorld` / selection，不要转换数字 handle |
| 剪贴板操作报 `undefined` | `copySelected` 依赖 DOM `navigator.clipboard` | 确保运行在 HTTPS 或 localhost 安全上下文 |

## Infinite grid carrier evidence

无限网格是 Edit-only RenderFeature projection。`gridVisible` 从 core Viewport Preferences projection 读取，并通过 `gateway.listOps()` 中 live 的 `setViewportPreferences` descriptor 发现。Runtime 不添加 grid action、第二个 capability catalog、scene entity 或 preview-world copy。

Game display、Clean Preview、Play 和资产预览是派生的非 Edit phase。它们隐藏 feature，但不改写 authored 或 session preference。Play 把同一个 runtime host 绑定到全新的 Play World；Stop 先 detach，再销毁该 World 并回到 Edit。carrier 断开、stale 或 recovering 时，返回既有 structured diagnostics envelope 与 recovery actions；调用方重新发现 operation、读取 diagnostics、等待 ready generation，再通过 Gateway 重试。

两个可见 hard gate 使用独立 evidence path：

| Carrier | 权威 locator | 证据边界 |
|:--|:--|:--|
| standalone `:15290` | `iframe[title="ForgeaX Viewport Runtime"]`，URL 含 `/editor/` | 可见 shell action 与该 frame 的 canvas、Gateway、diagnostics 和 artifacts |
| Studio `:18920` | Studio shell 内现有 Editor Runtime `/editor/` frame | Studio 自己的可见 action、canvas、diagnostics 和 artifacts；绝不复用 standalone evidence |

证据对控件采用 DOM-first，并记录 candidate Editor SHA、Engine pin、operation schema、structured diagnostics、action locator、expectation IDs 以及独立 PNG/log/metrics 路径。只有确认 authoritative carrier 且完成真实 UI action path 后才能截图。端口 readiness、API-only dispatch、raw preview 和 shell mirror 都不能证明网格。M0 Engine seam 仍是 conditional：只有可复现的 public seam 失败才能转给 Engine owning layer 做通用修复；Editor raw-device 或 backend-specific workaround 不是有效恢复路径。
