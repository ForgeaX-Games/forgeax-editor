# Editor 包边界与语义分析报告

> 聚焦"包命名语义是否准确、边界划分是否合理、大小是否失衡、是否有僵尸包"。
> 与同日的《代码组织结构分析报告》互补(那份讲一致性,这份讲边界)。
> 日期：2026-07-04

---

## 0. 一句话结论

editor 现有 5 包里,**只有 `editor-core` 和 `play-runtime` 的名字与内容名实相符**。其余三个都有问题:
`editor-shared` 已空心化成僵尸别名包、`editor-panels` 名不副实(最大内容不是 panel)、
`edit-runtime` 语义过载(engine boot + chrome + 一堆 viewport 组件混在一起)。

---

## 1. 体量地图(先看数据)

| 包 | 源码 LOC | 文件数 | 名字承诺 | 实际内容 | 名实相符? |
|:--|--:|--:|:--|:--|:--:|
| `editor-core` | **6993** | 40 | "核心逻辑" | session/store/scene/assets/protocol/schema… | ✅ 相符(但语义庞杂,见 §4) |
| `editor-panels` | **4554** | 54 | "业务面板" | 8 panel 仅 1828 行 + content-browser **2319** + asset-inspector 346 | ❌ 最大块不是 panel |
| `edit-runtime` | **5784** | 26 | "Edit 模式入口" | engine boot 1652 + viewport 955 + surface 954 + 一堆组件 | ⚠️ 语义过载 |
| `play-runtime` | 1362 | 5 | "Play 模式 thick host" | main/PlaySurface/guid-adapter | ✅ 相符 |
| `editor-shared` | **246** | 3 | "跨层共享" | 纯别名转发 + 一个 i18n(461 行含 json) | ❌ 僵尸包 |

> 直观失衡:`editor-shared`(246) 与 `edit-runtime`(5784) 差 **23 倍**。而 `editor-shared` 里几乎没有"自己的"代码。

---

## 2. 🧟 `editor-shared` 已是僵尸别名包

它的 `index.ts` 头注释自己承认:

> "After Wave A cleanup, editor-shared is a pass-through barrel. All business source files
> moved to editor-core. The package is kept for backward compat so existing consumers keep
> their import paths unchanged (plan-strategy §2 D-7)."

**实测**:
- 246 行里,`index.ts`(134)= 纯 `export … from '@forgeax/editor-core'`;`manifest.ts`(1 行)= 转发。
- **唯一原创内容是 `i18n/`**(index 111 行 + en/zh 各 175 行 json)。
- 运行时依赖只有 `@forgeax/editor-core` + `react`——没有任何 core 之外的东西,说明它能被无损吸收。
- 被 3 个包 import(edit-runtime / editor-panels / core 自己),但导入的**每一个符号都源自 core**;
  只有 `useTranslation`(i18n)是它自己的。

**问题本质**:它现在的语义 = "core 的别名 + 一坨 i18n",这不是一个包该有的语义。它存在的唯一理由是
"consumer 的 import 路径不用改",这是**迁移期的临时脚手架,不是稳定架构**。

### 处置建议(二选一)

- **方案 A — 消解(推荐)**:
  1. `i18n/` 移入 `editor-core/src/i18n/`(或独立成 `editor-i18n`,若想让 core 保持无 React 依赖)。
  2. 全仓 `@forgeax/editor-shared` → `@forgeax/editor-core`、`@forgeax/editor-shared/i18n` → 新位置。
     (约 30 处 import,机械 sed + typecheck。)
  3. 删除 `packages/editor-shared`,DAG 从 4 层降到 3 层(`core ← panels ← edit-runtime`),
     `lint:dep` 图更简单。
  - ⚠️ 注意:`useTranslation` 用到 `react`,若 core 想保持"纯逻辑无 React",则 i18n 应去 panels 或新建 `editor-i18n`,而非塞进 core。

- **方案 B — 正名为 i18n 包**:若短期不想动 30 处 import,至少把它**改名为 `editor-i18n`**,
  只保留 i18n,删掉所有别名转发(让 consumer 直接从 core 拿)。名字终于名实相符。

无论哪个,现状"叫 shared 实为 alias"必须终结——它误导每个新读者去 shared 找共享逻辑,却什么都找不到。

---

## 3. 📦 `editor-panels` 名不副实

"panels" 承诺"业务面板",但内容拆开看:

```
8 个正牌 panel(顶层 .tsx)         1828 LOC   ← 名字指的就是这些
content-browser/(mini-app)         2319 LOC   ← 比所有 panel 加起来还大!
asset-inspector/(15 个预览器)       346 LOC
```

**`content-browser` 是一个独立子应用**:自带 9 个 `CB*` 组件、`hooks/`、import-pipeline、
feature-flags、自己的 css。它是"资源浏览器"这个完整功能域,恰好**以一个 panel 的形式呈现**,
但代码量和内聚度都已经是独立包级别。把它埋在 `editor-panels/src/content-browser/` 里,
让"panels 包"名义上的主体(8 个 panel)反而成了少数派。

### 建议

- **抽出 `content-browser` 为独立包 `editor-content-browser`**(2319 行,足够独立),
  或至少在文档里明确"panels 包 = 8 panel + 内容浏览器子应用 + 资源预览器"三块,别让名字骗人。
- `asset-inspector`(346 行,15 个小预览器)体量小、内聚,留在 panels 合理。
- 若抽出 content-browser,`editor-panels` 回归纯粹的 ~2200 行"面板包",名实相符。

---

## 4. ⚠️ `editor-core` 语义庞大(你说的"命名庞大"的主因)

6993 行、40 个平铺文件,"core" 这个名字什么都装得下,但也因此**什么都没说清**。里面其实是
**5 个可辨识的子系统**挤在一个平面命名空间:

| 子系统 | 文件 | 性质 |
|:--|:--|:--|
| Session / 编辑循环 | edit-session, edit-mode, ops, pack-ops, open-project, document | 编辑器状态机 |
| Store / 总线 | store(1797!), bus, sync-channel, net, dock-bridge | 运行时状态 + IPC |
| Scene / 持久化 | scene-pack, scene-types, schema, spawn-asset-ref, mesh-original-materials | 场景序列化 |
| Assets / 导入 | assets, discoverer(-errors), fbx-cook, gltf-cook, drag-asset-spawn | 资源管线 |
| Protocol / seam | protocol(527), api-client, presets, run-conditions | 对外契约 |
| 工具 | euler-quat, color-utils, path-resolver, fetch-reader | 杂项 |

**两种视角:**
- **保守(推荐先做)**:不拆包,但在 `editor-core/src/` 下按上表起子目录(engine 就是这么干的——
  runtime 用 `systems/`/`components/` 分面)。既降检索成本,又不动 DAG。同时把 1797 行的 `store.ts`
  按 slice 拆(selection/scene/assets/sync)。
- **激进(视演进决定)**:若 session、scene-pack、protocol 这些子系统未来要被 play-runtime 或外部单独复用,
  再考虑拆成 `editor-session` / `editor-scene` / `editor-protocol`。**现在不建议**——过早拆包会制造
  更多跨包 import 和 DAG 约束。先用目录分面验证边界,边界稳定了再决定要不要升级成包。

> 命名原则:`core` 作为"其它包都依赖的地基"是站得住的,问题不在名字本身,而在它**装了太多平级概念却不分面**。
> 先分面(目录),让 `core` 名副其实地成为"分好层的地基",而不是"杂物间"。

---

## 5. ⚠️ `edit-runtime` 语义过载

名字是"Edit 模式入口",但它实际扛了三件事:
- **engine boot**(`main.tsx` 1652 行——引擎初始化 + React chrome 挂载揉一起)
- **viewport 子系统**(`engine/viewport.ts` 955、`EditSurface.tsx` 954、ViewportBar/Chrome/Clip/Hints…)
- **runtime 专属 panels**(`src/panels/` —— 与 `editor-panels` 包重名但内容不同,§见组织报告)

"runtime = 入口"应该是**薄的组装层**,但这里有 5784 行,比 `editor-panels` 还大。

### 建议

- 把 `main.tsx` 拆成 `boot/engine-boot.ts`(引擎初始化) + `main.tsx`(纯 React 挂载),让入口回归薄。
- `engine/` 下的 viewport 群已成子系统,可考虑其内聚度是否够格上升——但优先级低于把 boot 拆薄。
- `src/panels/`(3 个 runtime 专属 panel)与 `editor-panels` 包**重名易混**,建议改名 `runtime-panels/`
  或明确注释二者分工。

---

## 6. 收敛蓝图(名实相符的目标态)

```
现状(5 包, 语义模糊)                目标态(4 包, 名实相符)
─────────────────────              ─────────────────────
editor-core     (杂物间 6993)   →  editor-core     (分面地基, 内部 session/scene/assets/io/util 子目录)
editor-shared   (僵尸别名 246)  →  ✂ 消解: i18n 归位, 别名删除, DAG 4→3 层
editor-panels   (名不副实 4554) →  editor-panels   (纯 8 panel + asset-inspector, ~2200)
                                +  editor-content-browser (抽出的 2319 行子应用)  [可选]
edit-runtime    (过载 5784)     →  edit-runtime    (薄入口, boot 拆出)
play-runtime    (相符 1362)     →  play-runtime    (不动)
```

### 优先级

```
P0 — 终结僵尸包(语义硬伤, 收益最大)
  1. 消解 editor-shared: i18n 归位 + 别名 import 全量替换 + 删包    §2
     (DAG 4→3 层, 少一个误导性包名)

P1 — 名实相符(中等风险, 分次做)
  2. 抽出 content-browser 为独立包(或至少文档正名)                §3
  3. editor-core 按 5 子系统起子目录 + 拆 store.ts                 §4
  4. edit-runtime 拆薄 main.tsx 的 boot                            §5

P2 — 视演进再定
  5. 是否把 core 的 session/scene/protocol 升级为独立包(暂缓)      §4
```

> [!IMPORTANT]
> **勿动的既有设计**(重构时误伤会破坏 CI 承诺):
> - `EDITOR_PANELS` 在 core/manifest 与 sync-channel 的**故意重复**(避 shared→core 环,`lint:sync-channel` 守)。
>   注意:消解 shared 后这条约束**反而简化**了,但重构时要同步更新 lint 脚本对 shared 的引用。
> - 顶层 `src/index.ts` 的相对路径 import(绕 bun `file:` 解析)。
> - `exports`→`src/`、零构建 clone 即跑。

---

## 7. 与你直觉的对应

你说的三点,数据全部证实:
1. **"包命名语义庞大、不够准确契合"** → `core`(杂物间)、`panels`(名不副实)、`shared`(名为共享实为别名)三处。
2. **"有的包很大有的很小"** → shared(246) vs edit-runtime(5784),差 23×;且大的过载、小的空心。
3. **"有的已经没用了"** → `editor-shared` 正是——它自己的注释都写着"kept for backward compat"。
