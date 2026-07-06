# Editor 代码组织结构分析报告

> 以 `forgeax-engine`（38 包，约定高度统一）为基准，系统对照 `forgeax-editor` 自有 5 包
> （`editor-core / editor-shared / editor-panels / edit-runtime / play-runtime`）+ 顶层 `src/`。
> 日期：2026-07-04

---

## 0. 结论速览

editor 的分层 DAG（`core ← shared ← panels ← edit-runtime`）和"薄顶层 + 注入 seam"骨架是**健康**的，
CI 也把关键不变量（无环、api-seam、单 world、sync-channel drift）钉死了。真正的优化空间集中在
**约定一致性**，而非架构：同一个概念在 editor 内部有 2–4 种写法，而 engine 对同一概念只有 1 种。

| 维度 | engine（基准） | editor（现状） | 差距 |
|:--|:--|:--|:--:|
| 目录名 ↔ 包名映射 | 全一致（`ecs`→`engine-ecs`） | `edit-runtime`→`editor-edit-runtime`（掉前缀） | 🔴 |
| 测试位置 | `__tests__/` 主 + 少量 colocated | 4 种并存 | 🔴 |
| 文件命名 | kebab 主 + 单函数文件 camel | 混入 `actionBridge`/`CtxMenu` 例外 | 🟡 |
| 每包基建文件 | README/tsconfig/tsup/vitest 近 100% | README+tsconfig 有；无 tsup（无构建）；vitest 缺 | 🟡 |
| index.ts barrel | 分层受众化、curated | core 做到；play/shared 极薄；无统一风格 | 🟡 |
| 大文件分解 | runtime 大但按 systems/components 拆 | `store.ts` 1797、`main.tsx` 1652 单文件 | 🟡 |
| 头注释锚点密度 | 全文件 `// @forgeax/x — role (plan-id)` | entry/逻辑做到；最大文件与 UI 常缺 | 🟡 |
| `test` script / `sideEffects` | 全包统一 | shared/play 缺 test；runtime 缺 sideEffects | 🟢 |

> [!NOTE]
> engine `exports`→`dist/`（有 tsup 构建），editor `exports`→`src/`（无构建，消费方 vite 直编）。
> 这是**设计差异不是缺陷**——editor 的 "clone 即跑 / 零构建" 是 CI 门禁承诺，不应向 engine 看齐加构建步。

---

## 1. 🔴 目录名与包名不一致（最该修）

engine 铁律：**目录名 = 包名去掉 `@forgeax/engine-` 前缀**，38 包无一例外。

editor 破了这条：

```
editor-core     -> @forgeax/editor-core            ✅
editor-shared   -> @forgeax/editor-shared          ✅
editor-panels   -> @forgeax/editor-panels          ✅
edit-runtime    -> @forgeax/editor-edit-runtime    ❌ 目录掉了 editor- 前缀
play-runtime    -> @forgeax/editor-play-runtime    ❌ 同上
```

后果：`bun -F @forgeax/editor-edit-runtime dev` 与目录 `packages/edit-runtime` 对不上，
心智负担 + grep 断裂。**两种收敛方向二选一：**

- **A（改目录，推荐）**：`edit-runtime`→`editor-edit-runtime`、`play-runtime`→`editor-play-runtime`，
  与 engine 规则完全对齐。代价：改 workspace glob、`.gitmodules` 无关、若干脚本路径。
- **B（改包名）**：包名改成 `@forgeax/editor-runtime` / `@forgeax/play-runtime`。破坏性更大（顶层 `edit.ts`/`play.ts` 的 import 说明符要动），不推荐。

---

## 2. 🔴 测试位置四种并存

engine 是"`__tests__/` 为主 + 极少数 colocated"的**双轨**，且用**语义化后缀**区分测试类型
（`.unit.test.ts` / `.test-d.ts` 类型级 / `.property.test.ts` / `.dawn.test.ts` 真 GPU）。

editor 目前**四种混用**，且无后缀语义：

| 位置 | 出现在 |
|:--|:--|
| `src/__tests__/*.test.ts` | 全部 5 包（主流） |
| `src/*.test.ts`（源文件旁） | `editor-core/protocol.test.ts`、`edit-runtime/EditSurface.test.ts` |
| 顶层 `test/`（单数，无下划线） | 仅 `edit-runtime`（anim/dock-tree/matgraph/sync-channel/viewport 5 个） |
| 顶层 `src/core/*.test.ts` | 顶层 `src/core/protocol.test.ts` |

**建议：** 统一到 `src/__tests__/`。`edit-runtime/test/` 5 个文件迁入 `src/__tests__/`；
`protocol.test.ts`/`EditSurface.test.ts` 迁入各自 `__tests__/`。若要保留类型级测试，引入 engine 的
`.test-d.ts` 后缀。这是纯机械迁移、零逻辑风险。

---

## 3. 🟡 文件命名例外

editor 主约定与 engine 一致（kebab 逻辑 + PascalCase 组件 + camel `use*` hook），但有零星越界：

- `editor-core/src/actionBridge.ts`、`contextMenuService.tsx` — 唯二 camelCase 逻辑文件（应 `action-bridge.ts` / `context-menu-service.tsx`）。
- `editor-core/src/CtxMenu.tsx` — 用组件式 PascalCase 命名一个 core 工具文件。
- **跨包同概念反向大小写**：`editor-panels` 用 `Inspector.tsx`（Pascal），
  但 `edit-runtime/src/panels/` 用 `inspector.tsx`/`systems-panel.tsx`（小写 kebab）。同为 panel，两套写法。
- 组件前缀不统一：`content-browser` 用缩写 `CB*`（CBGrid/CBToolbar…），`asset-inspector` 用全词 `AssetPreview*`。
- **版本后缀 smell**：`ContentBrowserV2.tsx` —— 若已无 V1，去掉 `V2`；engine 无任何 `*V2` 文件。

engine 对 camelCase 文件名的**唯一**豁免是"文件即单个 camel 工厂函数"（`createRenderer.ts`）。
editor 的 `actionBridge` 不属此类，建议归一到 kebab。

---

## 4. 🟡 大文件分解

engine 的 runtime 更大，但用 `systems/`、`components/`、`geometry/`、`ibl/` 按概念多寡拆子目录，
单文件很少破千（除测试）。editor 有两个明显超标单体：

| 行数 | 文件 | 建议 |
|--:|:--|:--|
| **1797** | `editor-core/src/store.ts` | zustand store 承载 selection/持久化/asset ops/sync init（约 70 个导出）。按 slice 拆：`store/selection.ts`、`store/scene.ts`、`store/assets.ts`、`store/sync.ts`，`store/index.ts` 组合。 |
| **1652** | `edit-runtime/src/main.tsx` | engine boot + React chrome 挂载揉在一起。拆出 `boot/engine-boot.ts` 与 `main.tsx`（纯挂载）。 |
| 955 | `edit-runtime/src/engine/viewport.ts` | 已在 `engine/` 下，可接受 |
| 954 | `edit-runtime/src/EditSurface.tsx` | 观察 |
| 527 | `editor-core/src/protocol.ts` | 16 个 VAG schema SSOT，体量固有，不动 |

前两个是数量级离群点（~2–3× 次高），优先。

---

## 5. 🟡 editor-core/src 扁平度

`editor-core/src` = **38 个平铺文件 + 仅 1 个只装 1 文件的 `components/`**。
engine 的做法是"概念多了才起子目录"。editor-core 里已有清晰的概念簇可收拢：

```
scene-pack / scene-types / schema / spawn-asset-ref / mesh-original-materials   → scene/
assets / drag-asset-spawn / fbx-cook / gltf-cook / discoverer(-errors)          → assets/
edit-session / edit-mode / ops / pack-ops / open-project / document             → session/
protocol / sync-channel / net / bus / dock-bridge                              → io/  (或 protocol/)
euler-quat / color-utils / path-resolver / fetch-reader / run-conditions        → util/
```

不强制——engine 的 runtime 也留了 69 个 root 文件——但 editor-core 已到"翻目录找文件"的临界点，
按上面 5 簇收拢能显著降检索成本。`components/`（仅 `EditorHidden.ts`）与 `edit-runtime` 的
`components/`（仅 `dirty-indicator.tsx`）都是**单文件空目录**，要么填充要么下沉。

---

## 6. 🟡 头注释锚点密度不均

AGENTS.md 要求"稠密头注释锚定 requirements/plan ID"。engine 做到 **100% 文件**均以
`// @forgeax/engine-x — <role> (<plan-id>)` 开头。editor 有 63 个文件带 `AC-` 锚点，
但**最大的文件恰恰没有**：`store.ts`（1797 行）、`play-runtime/main.ts`（801 行）直接从 `import` 开始，
无头注释块。UI 组件 `.tsx` 也普遍只有一句功能注释而非正式 Anchors 块。

**建议：** 至少给所有 >300 行的源文件补齐 engine 式头注释块（title + 一句 role + Anchors 列表）。

---

## 7. 🟢 零散一致性（低成本快修）

- `editor-shared`、`play-runtime` 的 package.json **无 `test` script**（其余 3 包有）——补齐或显式注明无测试。
- `edit-runtime`、`play-runtime` **缺 `"sideEffects": false`**——它们有副作用入口 `main.tsx`/`main.ts`，
  实际应显式写 `"sideEffects": ["**/main.*", "**/*.css"]` 而非省略，帮助 tree-shaking。
- `play-runtime/pack-catalog.ts` **孤悬包根**（344 行），其余源码都在 `src/`——移入 `src/`。
- `edit-runtime` 树里提交了 `.vite/deps/` 构建缓存——应进 `.gitignore`。
- 文档漂移：`play-runtime` README/index 写 "~488 lines"，实际 `main.ts` 801 行。
- engine 每包有 `README.md`（34/38）承载"Charter propositions 表"；editor 每包也有 README，风格可对齐成表驱动。

---

## 8. 值得保留、勿"优化"的既有设计

以下是**刻意为之**，勿在重构时误伤：

1. 顶层 `src/index.ts` 的 `../packages/editor-shared/src/manifest` **相对路径 import**——绕开 bun `file:` 解析把整条 engine 链拖入 scope，头注释已警告勿改成常规 barrel。
2. `EDITOR_PANELS` 在 `editor-core/manifest.ts`（SSOT）与 `sync-channel.ts`（inline copy）**故意重复**，`lint:sync-channel` 守 drift——避免 shared→core 环。
3. `editor-shared` 是 **compat 别名 barrel**（几乎全 re-export editor-core），非空壳废包。
4. `exports`→`src/`、`build` no-op 是"零构建 clone 即跑"承诺，勿加 tsup。

---

## 9. 优先级建议

```
P0（一致性硬伤，机械低风险）
  1. edit-runtime/play-runtime 目录改名对齐包名        §1
  2. 测试位置统一到 src/__tests__/                     §2
  3. .vite/deps 入 gitignore；pack-catalog.ts 移入 src  §7

P1（可读性，低风险）
  4. actionBridge/CtxMenu/contextMenuService 归一 kebab §3
  5. store.ts 按 slice 拆分；main.tsx 拆 boot           §4
  6. 补 shared/play 的 test script、runtime sideEffects  §7

P2（渐进，随手做）
  7. editor-core/src 按 5 簇起子目录                    §5
  8. >300 行文件补 engine 式头注释锚点                  §6
  9. 修 play-runtime README 行数漂移；ContentBrowserV2 去版本后缀
```

> P0 全是纯移动/改名，无逻辑改动，可一次 PR 收口；P1/P2 建议分次、每次配 typecheck + `lint:dep` 验证。
