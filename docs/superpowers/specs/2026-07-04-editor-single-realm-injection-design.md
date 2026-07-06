# 编辑器单 realm 收敛：注入装配 + 引擎入 host

> Design spec · 2026-07-04 · 关联知识库 [[editor-panel-realm-architecture]]（`.forgeax-harness/knowledge-base/wiki/`）§7 决策收口。

## 1. 背景与问题

编辑器当前把最重的隔离机制 **iframe-per-panel** 无差别套在所有面板上：

- 引擎只在 `/editor/` iframe 里 `bootEditor()` 创建 World（`edit-runtime/src/main.tsx:176`）。
- host 窗口（studio / standalone shell）**不 boot 引擎**——它把 viewport 和 ~9 个编辑器面板都渲染成 iframe（`standalone/main.tsx:95`、`interface/.../EditorPanelFrame.tsx:64`）。
- 面板 iframe 带 `?panel=X` 走 popout 分支，`doc.world = null`（**dead-world**），只能通过 BroadcastChannel 收全量快照，读实体走模块级 `_popoutCache` 影子副本。

由此逼出的债（知识库 §1-§6 已代码核对）：

1. **dead-world NPE 常态**：任一读取器漏判 dead-world 直读 `doc.world.get()` 即崩（#5/#10）。
2. **通用 Inspector × 贫化快照冲突**：Inspector UI 已能遍历所有组件所有字段，但喂它的 `buildWorldState` 只灌 Transform（`store.ts:1386`）——点带 MeshFilter/DirectionalLight 的实体只看得到 Transform。
3. **O(world) 性能雷**：`initMain`（`store.ts:1571`）把 `broadcastSnapshot` 挂在 bus/selection/gizmo 上，无节流；改一个字段（含拖动每帧）→ DFS 整个 World + structuredClone 深拷 + 广播 ~9 iframe。大关卡拖动 = 主线程冻结。
4. **平行资产发现**：资产面板不读 AssetRegistry，`loadGameAssets`/`loadMetaAssets`（`assets.ts`）重扫磁盘手写 JSON.parse——同一份磁盘资产两套解析、靠碰运气一致（#6、placeholder cube 同源）。

**根因唯一**：面板被 iframe 隔离、够不着引擎运行时，于是被迫在编辑器侧重造引擎已有能力。违反 architecture-principles §1（SSOT）+ AGENTS.md 反模式 #1。

## 2. 目标 / 非目标

### 目标

把编辑器收敛成**单 realm、引擎在 host 窗口 in-process boot、所有面板经注入槽装配、直读活 `bus.doc.world`/`registry`**。删除所有为跨 iframe 说话而造的代码。

可见成果：
- Inspector 点任意实体**能看到全部组件全部字段**（引擎有啥显示啥，免费）。
- 拖动物体不再全量广播（去掉 O(world) 雷，成本回落到 O(改动)）。
- 资产面板直读 registry，两套资产真相塌成一套（SSOT 恢复）。
- 引擎/registry/显存各一份；~9 iframe → 单 realm。

### 非目标（YAGNI）

- **不做弹出窗口**：门留着（知识库 §3/§6 分层留作将来），但本轮 `getPopoutPanel`/`DetachedPanel` 及整条快照同步**彻底删除**，不留开关。将来弹出按分层重做（纯元数据用 delta 投影；要渲染的用命令复制+快照兜底 / 预览小 world），届时只给同一批面板换跨-realm 数据后端，面板本身不改。
- **不动 play-runtime**：独立 thick host，经 VAG 协议通信，与本次 realm 收敛正交。
- **不做 Web Worker / OffscreenCanvas 线程隔离**：列为 B 之后的独立优化（这才是真线程隔离，iframe 从未提供）。

## 3. 架构

### 3.1 一份引擎搬家 + 一个注入槽

```
今天:  host shell ──iframe──> /editor/?viewportOnly (引擎 ×1)
                  ──iframe×9─> /editor/?panel=X       (dead-world, 无引擎)

目标:  host window
        ├─ interface DockShell
        │    定义 renderEditorPanel 槽（中立 ReactNode，零 editor/engine import）
        └─ host 入口 (studio / standalone)
             import 引擎 + editor-panels 的 PANEL_COMPONENTS，注入:
             viewport + hierarchy + inspector + assets ...
             → 全是同进程 React 组件；一个 World / 一个 registry / 一份显存
             → 与 chat / dashboard 在一个扁平 dock 里自由交错
```

引擎**总量不变**：今天 1 份（在 iframe），目标 1 份（在 host）——搬家，非复制。dead-world 的影子副本（`_popoutCache`）与弹出的 N× 显存复制被删 → 净减。唯一真代价：host 入口 bundle 带上引擎（WebGPU/wasm），是打包体积/构建问题，**非依赖环**。

### 3.2 依赖环：注入正是解药

环的形状是 import 环 `studio → interface → editor → interface`，只在"谁静态 import 谁"层面成立。依赖倒置破它：

- interface **只定义槽** `renderEditorPanel?: (id: string) => ReactNode`，类型中立，永不 import editor/engine。
- **host**（studio / standalone，最外层入口，无人 import 它）才 import editor 的 `PANEL_COMPONENTS` + 引擎，塞进槽。
- 与现有 `renderChat` / `renderEdit` 同款（`interface/.../panelRenderers.ts`）——已验证零环。

host import 引擎不成环。引擎进 host bundle ≠ 引擎进 interface。

### 3.3 组合性边界（已与用户确认）

单 realm 后所有面板（含 viewport、chat、dashboard）在**同一个扁平 dockview** 里，可任意拖拽/分屏/嵌套——包括"chat 嵌进 editor 一个角落"。这正是引擎入 host（而非留在 iframe）换来的：iframe 是一个不可切分的连续矩形，做不到跨-realm 交错。

### 3.4 崩溃隔离

丢掉 iframe 的崩溃/内存隔离，用 React error boundary 近似（`panelRegistry.tsx:101` 的 `withBoundary` 已在用，非新增代价）。error boundary 与 dock 布局正交，对组合灵活性零影响；平时透明，仅在 render 抛异常那一帧渲染 fallback，非热路径，性能噪声级。

## 4. 组件与数据流

### 4.1 注入槽（interface 侧，破环关键）

`interface/src/components/DockShell/panelRenderers.ts` 新增：

```ts
/** 渲染一个编辑器子面板（ep:*）为同进程 React 组件。host 从 editor-panels 的
 *  PANEL_COMPONENTS 注入；interface 永不 import editor。省略 → 中立占位。 */
renderEditorPanel?: (id: string) => ReactNode;
```

`panelRegistry.tsx` 的 `PANEL_COMPONENTS[ep:*]` 从 `() => <EditorPanelFrame panelId={id}/>` 改为 `() => renderEditorPanel?.(id) ?? <placeholder/>`（经 `usePanelRenderers()`），沿用 `ChatPanelSlot` 同款。

### 4.2 引擎 in-process boot（host 侧）

`bootEditor()` 的世界/渲染器创建逻辑抽成 host 可调用的组件（viewport 组件），host 装配时在同进程执行一次，World/registry 注入 `bus.doc`。host 入口（`standalone/main.tsx`、studio）：

- import `@forgeax/editor` 的 `PANEL_COMPONENTS` + viewport 组件 + 引擎。
- 构造 `PanelRenderers`：`renderEditorPanel: (id) => createElement(PANEL_COMPONENTS[id])`、`renderEdit: () => <ViewportComponent/>`（不再是 iframe）。
- 经 `PanelRenderersProvider` 注入。

### 4.3 面板直读活 World

`entity-state.ts` 的 `ent*` 门面删除 dead-world 分支，只留活 World 路径（`session.world.get(...)`）。面板组件本就是纯 React + `bus` 单例（`Hierarchy.tsx` 不知道自己在不在 iframe），单 realm 后直接命中活 World，无需改面板业务代码。

### 4.4 资产面板直读 registry

`ContentBrowserV2.tsx:72` 的 `loadGameAssets`/`loadMetaAssets` 改为读 `bus.doc.registry`（引擎已建 guid→handle 索引）。缩略图路径按 registry 已有信息解析。

## 5. 删除清单

| 区域 | 删除物 |
|:--|:--|
| `store.ts` 同步引擎 | `IS_POPOUT` 分支、`postSync` / `buildSnapshot` / `buildWorldState` / `applySnapshot` / `broadcastSnapshot` / `initMain` / `mainOnMessage`、三防回环标志（`applyingSnapshot` / `applyingExternalSel` / `broadcastProven`）、`announcePopoutClosing`、geom/hello/bye 消息处理 |
| `sync-channel.ts` | `WorldState` / `WorldEntityState` / `EditorSnapshot` / `EditorSyncMsg` / `getPopoutPanel` / `openSyncChannel` 等（整文件多数导出；保留 play-runtime 若仍需的部分——迁移时逐一核对） |
| `entity-state.ts` | `_popoutCache`、`entIsDeadWorld` 嗅探、所有 dead-world 分支 |
| `edit-runtime` | `DetachedPanel.tsx`、`main.tsx` popout 入口分支、`loadDocFromStorage` 兜底 |
| 平行资产 | `assets.ts` 的 `loadGameAssets` / `loadMetaAssets`；`ContentBrowserV2` 改直读 registry |
| `interface` | `EditorPanelFrame.tsx`；reload-coordinator 里防 9×WebGPU 串行的逻辑 |

## 6. 执行顺序（避免中途引擎×2 或 world=null 裸读）

1. **加槽 + host in-process boot viewport**：新增 `renderEditorPanel` 槽；host 能 in-process 渲染 viewport 组件（引擎在 host boot）。此刻新旧并存，引擎仍在 iframe——**尚未删**，仅新增能力。
2. **切注入 + 同步删 iframe 入口**：host 改用注入面板 + 注入 viewport，**同一步**删掉所有 `/editor/` iframe 入口（viewport 和面板一起搬，杜绝引擎×2 的半吊子态）。
3. **删同步引擎 + dead-world 分支 + 平行资产**：此时已无跨-realm 消费者，`store.ts` 同步引擎、`entity-state` dead-world 分支、`loadGameAssets` 成片删。
4. **删空壳**：`sync-channel` 多数导出、`DetachedPanel`、`EditorPanelFrame` 等。

每步之间代码可编译、可过 gate；顺序保证任一中间态不出现引擎重复或裸读 null world。

## 7. 验证 gate（闭环的"闭"）

每步后必须全绿：

- `bun run typecheck`
- `bun run lint:dep`（依赖环不回归——本方案的核心不变量）
- `bun run lint:api-seam`（backend 仍只走注入 ApiClient）
- `bun run lint:sync-channel`（EDITOR_PANELS 双份不漂移）
- `bun run selfcheck:b2`（clone→install→读写游戏无 studio，CI gate）
- E2E：`e2e/standalone-chrome.spec.ts`、`e2e/standalone-shell.spec.ts` 必绿

功能验收：
- Inspector 点带 `MeshFilter` / `DirectionalLight` 的实体 → 显示**全部组件全部字段**（dead-world 时代做不到）。
- 拖动物体 → 无全量快照广播（O(改动) 而非 O(world)）。
- 资产面板显示的资产 = 引擎能加载的（无 drift、无 placeholder cube）。

## 8. 风险与缓解

| 风险 | 缓解 |
|:--|:--|
| host 与引擎共主线程，超重帧掉 host UI | iframe 本就未提供线程隔离（同源同进程共主线程）；真隔离靠 Web Worker/OffscreenCanvas，后置为独立优化，不阻塞本轮 |
| standalone bundle 变大（带引擎） | 预期内、非架构问题；host 本就是跑编辑器的应用，carry 引擎是本分 |
| 迁移中途出现引擎×2 或裸读 null world | §6 执行顺序：viewport+面板一起搬、iframe 一步删净；每步过 typecheck + gate |
| play-runtime 误伤 | 明确非目标，不碰；删 `sync-channel` 导出时逐一核对 play-runtime 是否仍引用 |
