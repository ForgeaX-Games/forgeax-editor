---
name: forgeax-editor-gateway
description: >-
  所有编辑器操作经唯一 EditGateway —— dispatch（即时 op）、begin/update/commit/cancel（连续 op）、
  listOps（自省能力边界）、defineOp（铸造新 op）。三域模型（document/session/transient）由 applier
  注册表结构决定，非手贴标签。错误码结构化兜底，dispatch 返回 {ok, error} 非抛异常。
  Use when building editor tools, AI-driven editing, or extending the editor with new operations.
---

# forgeax-editor-gateway

> **所有编辑器操作经唯一 EditGateway——`dispatch` / `begin…commit` / `listOps` / `defineOp`。**
>
> 编辑器状态变更只有一扇门。人 UI handler 与 AI 代码走同一 gateway、同一 op payload、同一 applier、
> 同一 ledger——人机平等。"当你见过一个 op 怎么走，你就知道全仓状态变更怎么走。"

## 心智模型

**三域模型**：op 的域由其 applier 注册在哪张注册表决定（结构决定，非手贴标签）：

| 域 | applier 注册表 | 落账行为 | 代表性 op |
|:--|:--|:--|:--|
| `document` | `documentAppliers` | undo + ledger（可撤销） | spawnEntity / setComponent / transaction |
| `session` | `sessionAppliers` | 仅 ledger（不可撤销，但可审计） | setSelection / saveDocToDisk / play / stop |
| `transient` | `transientAppliers` | 皆无（瞬时态，不留痕） | setHoverEntity / setFieldPreview |

**即时 op** = `dispatch` 内部 begin=commit 退化。**连续 op** = `begin`（快照初值、占槽）→ `update*`（直写、不记 ledger）→ `commit`（算 from→to inverse、按域落账）。任何时候最多一个活跃 op（单槽）；第二次 begin 或场景切换/undo 触发隐式 cancel 前一个 op，旧 handle 返回 `OP_INTERRUPTED`。

## 核心 API 速查

| 入口 | 形态 | 用途 |
|:--|:--|:--|
| `gateway.dispatch(op, origin?)` | `(EditorOp, 'human'\|'ai') => DispatchResult` | 即时 op：构造 EditorOp → dispatch，按 applier 注册表定域落账 |
| `gateway.begin(op)` | `(EditorOp) => {ok:true, handle} \| {ok:false, error}` | 开始连续 op：预校验 + 快照初值、占 active-op 槽、返回 handle（含 id） |
| `gateway.update(handle, patch)` | `(OpHandle, Record<string,any>) => DispatchResult` | 累加 patch 进 begin 的 op 后直写状态 + 请求重绘（不产 ledger，不产 inverse） |
| `gateway.commit(handle)` | `(OpHandle) => DispatchResult` | 完成连续 op：算 from→to inverse、按域落账、释放槽 |
| `gateway.cancel(handle)` | `(OpHandle) => DispatchResult` | 回滚到 begin 前、不留痕、释放槽 |
| `gateway.listOps()` | `() => readonly OpEntry[]` | 自省全部已注册操作（内建 + D-11 seam 注册 + defineOp 铸造） |
| `gateway.defineOp(def)` | `(OpDefinition) => DefineResult` | 铸造新 document 域 op（id + argsSchema + plan → transaction 包装） |
| `registerSessionApplier(kind, applier, meta?)` | `(string, fn, meta?) => () => void` | D-11 下游注册 seam：edit-runtime 注册 play/stop applier，返回注销函数 |

## dispatch —— 即时操作

```ts
import { gateway } from '@forgeax/editor-core';

// 人：UI handler
gateway.dispatch({ kind: 'setSelection', id: entityId });
// origin 默认 'human'；id:null 清空选择

// AI：代码环境
gateway.dispatch({ kind: 'setSelection', id: entityId }, 'ai');
// origin='ai' → ledger entry 带 origin 标记，可审计

// 结果检查
const r = gateway.dispatch({ kind: 'spawnEntity', name: 'Light', components: {} }, 'ai');
if (!r.ok) console.error(r.error.code, r.error.hint);
// 错误不抛异常，属性访问分支
```

## begin → update → commit —— 连续操作

```ts
// gizmo 拖拽：mousedown → mousemove* → mouseup
const b = gateway.begin({ kind: 'setComponent', entity: 5, component: 'Transform', patch: { posX: 0 } });
if (!b.ok) return; // begin 失败（如实体不存在）→ {ok:false, error}
const handle = b.handle;

// 每帧拖拽（直写，不记 ledger）；update 的 partial 累加进 begin 的 op（后写覆盖）
gateway.update(handle, { patch: { posX: 1.0, posY: 0.5 } });
gateway.update(handle, { patch: { posX: 1.2, posY: 0.7 } });

// 松手落定：算 from→to inverse、一条 undo
const result = gateway.commit(handle);
// document 域 → undo + ledger（一条 undo 回滚全部拖拽）
// session 域 → 仅 ledger
```

## cancel —— 中断回滚

```ts
const b = gateway.begin({ kind: 'setComponent', entity: 5, component: 'Transform', patch: { posX: 0 } });
if (!b.ok) return;
const handle = b.handle;
gateway.update(handle, { patch: { posX: 5.0 } });

// 用户按 undo 或场景切换
gateway.cancel(handle);
// → 回滚到 begin 前的 Transform、不留 ledger/undo 痕迹

// 旧 handle 上的后续操作
gateway.commit(handle);
// → { ok: false, error: { code: 'OP_INTERRUPTED', hint: '...' } }
```

## listOps —— 自省能力边界

```ts
const ops = gateway.listOps();
// [
//   { id: 'setSelection', domain: 'session', source: 'builtin', argsSchema: {...} },
//   { id: 'saveDocToDisk', domain: 'session', source: 'builtin', argsSchema: {...} },
//   { id: 'spawnEntity', domain: 'document', source: 'builtin', argsSchema: {...} },
//   { id: 'play',   domain: 'session', source: 'builtin', ... },  // edit-runtime boot 后才出现
//   { id: 'alignToGrid', domain: 'document', source: 'defined', argsSchema: {...} },
// ]

// AI 开工前一次性获取能力边界
const sessionOps = ops.filter(o => o.domain === 'session');
const docOps = ops.filter(o => o.domain === 'document');
```

> [!NOTE]
> **`play` / `stop` 仅在 edit-runtime 启动并注册 D-11 seam 后可用**（`registerSessionApplier`）。在 headless（无 edit-runtime，如纯 core 脚本 / 测试 / CI）环境，它们**未注册**，`dispatch({ kind: 'play' })` 返回 `UNKNOWN_OP`。开工前用 `listOps()` 探测：若结果里没有 `play`/`stop`，即当前环境不支持——不要盲发。

## defineOp —— 铸造新操作

```ts
const result = gateway.defineOp({
  id: 'alignToGrid',
  domain: 'document',
  argsSchema: {
    type: 'object',
    properties: { step: { type: 'number' } },
    required: ['step'],
  },
  plan: (query, args) => {
    // query 返回值快照行：{ entity, Transform: { posX, posY, posZ, … } }
    return query({ with: ['Transform'] }).map(e => ({
      kind: 'setComponent',
      entity: e.entity,
      component: 'Transform',
      patch: { posX: snapToGrid(e.Transform.posX, args.step) },
    }));
  },
});

// plan 作用域仅 querySnapshot + 基元构造器，无 world / EditSession
// gateway 包成一条 transaction → 整体一条 undo（复用 document.ts 既有逆序 inverse）
// 铸完即入目录：listOps() 即刻出现 { id:'alignToGrid', source:'defined' }
```

> [!IMPORTANT]
> **querySnapshot 组件白名单**：`plan` 里 `query({ with: [...] })` 目前只识别 `Transform` 与 `Entity` 两个组件 token。传入白名单外的组件名**不会报错**——该 token 被静默忽略（内部 `.filter(Boolean)`），可能返回空行或缺该字段。所以 `plan` 目前只能可靠地读 `Transform` / `Entity`；铸造依赖其它组件的操作前，先确认该组件已进白名单，否则 `query` 静默返回空、`plan` 得到空序列 → `PLAN_FAILED`。

## 错误码兜底

所有错误走 `{ ok: false, error: { code, hint } }` 返回值（非异常）。AI 以属性访问分支、按 hint 直接修正重试。

| code | 触发条件 | hint 指引 |
|:--|:--|:--|
| `UNKNOWN_OP` | dispatch 未知 op kind（未注册 applier）；含 headless 环境下的 `play`/`stop`（D-11 seam 未注册） | `no applier registered for "<kind>"; see listOps()`；`play`/`stop` 特化：提示 edit-runtime boot 后经 `registerSessionApplier` 才可用 |
| `INVALID_ARGS` | session/transient args 非法（类型不符/缺少必填字段）；defineOp 非 document 域 | `invalid args for "<kind>": <path>: <message>` |
| `OP_ID_CONFLICT` | defineOp 重复 id | `op "<id>" already exists in catalog` |
| `PLAN_FAILED` | plan 抛错/吐空或非数组 | `plan threw: <message>` / `plan returned empty or non-array` |
| `OP_INTERRUPTED` | 旧 handle 上调生命周期方法（已被隐式 cancel） | `operation was interrupted; begin a new one` |

## 门禁 B 约束

仓内 CI 强制增量门禁：`scripts/lint-op-via-gateway.mjs` 拦截任何绕过 gateway 的新增散落 store mutator。
**合规做法**：新增操作一律通过 `gateway.dispatch()` 或 `registerSessionApplier()`（D-11 seam）。
**豁免**：`ref-request.ts`（VAG postMessage）、`mesh-stats.ts`（派生统计）、`assets-changed.ts`（变更信号）、`disk-watch.ts`（基础设施 init）。

> [!CAUTION]
> 直接 import store/ 子模块 setter（如 `import { setSelection } from '../store/selection'`）在 UI 包中是**违规**——所有 UI handler 必须经 `gateway.dispatch()`。