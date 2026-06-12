# forgeax-editor

> forgeax editor monorepo — 5 个 workspace 包，构成完整的 forgeax editor（Edit / Play 双模式）。

## 包列表

| 包 | 用途 |
|:--|:--|
| [`@forgeax/editor-core`](./packages/editor-core/) | 核心逻辑层 — SceneDocument、EditorBus、undo/redo、schema、sync-channel、动画、材质图、资源、预设 |
| [`@forgeax/editor-shared`](./packages/editor-shared/) | 跨层共享运行时 — zustand store、实体操作、右键菜单、dock 桥接、面板 manifest SSOT |
| [`@forgeax/editor-panels`](./packages/editor-panels/) | 8 个业务面板（Hierarchy、Inspector、Assets、History、Capabilities、Material、Timeline、MaterialGraph）+ 面板组件注入 |
| [`@forgeax/editor-edit-runtime`](./packages/edit-runtime/) | Edit 模式主入口 — 引擎 boot + 相机 + dock shell + EditorApp |
| [`@forgeax/editor-play-runtime`](./packages/play-runtime/) | Play 模式厚 host — FPS 捕获、physics gate、pack-index、诊断遮罩、VAG_CONSOLE 桥接 |

## 依赖结构

```
editor-core  ←── editor-shared  ←── editor-panels  ←── editor-edit-runtime
    ↑                                                    
    └── editor-play-runtime          (iframe VAG_* 协议)
```

## 开发命令

```bash
# 安装依赖
bun install

# 类型检查
bun run typecheck

# 检查依赖环
bun run lint:dep

# 启动 Edit mode（端口 15280）
bun -F @forgeax/editor-edit-runtime dev

# 启动 Play mode（端口 15173）
bun -F @forgeax/editor-play-runtime dev
```

> [!NOTE]
> forgeax-editor 是独立 git 仓（`https://github.com/ForgeaXGame/forgeax-editor`），以 git submodule 形式接入 studio 仓的 `packages/editor`。5 个包均通过 `exports` 直接指向源入口（`./src/index.ts`），无 tsup build 步骤——由消费方的 bundler（vite）当场编译。

## known limitations (baseline as of 2026-06-13)

These capabilities carry over from P2 and are explicitly documented as
**not passing under the current sandbox/standalone test environment**.
They are tracked for a future full-studio regression sweep.

| Capability | What it tests | Status | Constraint |
|:--|:--|:--|:--|
| AC-15B panel-mount e2e (P2 G-4) | panel mount on standalone chrome surface | deferred — `test.skip` in `standalone-chrome.spec.ts` | requires full studio harness with `ANTHROPIC_API_KEY` and running `forgeax-server` on :18900; unreachable under standalone/sandbox |
| AC-16 producer-side z.infer fixup | producer-call-site strong type equivalence | deferred — P2 AC-16 carry-over from implement R3 reviewer accept-risk | requires `protocol.ts` SSOT relocation + full `z.infer` re-application across all producer call sites; tracked as OQ-1 for P3 |

These are not regressions — they were never green in the standalone
configuration. They will be re-validated once a `forgeax-server` instance
with valid credentials is available in the test environment, or when the
P3 SSOT-relocation loop closes the OQ-1 gap.

## troubleshooting

| 症状 | 原因 | 解决 |
|:--|:--|:--|
| `bun install` 报 `unresolved workspace` | engine submodule 未拉取或 `workspace:*` pin 失效 | 确认本仓与 engine submodule 的相对路径正确；stacks 通过父仓的 bun workspaces glob 解析 |
| `bun run typecheck` 失败 | 某个包的依赖未安装或类型不匹配 | 先 `bun install`，再 `bun run typecheck` |
| `bun run lint:dep` 报 no-circular | 新增了跨包 import 打破 DAG | 检查 `.dependency-cruiser.cjs` 规则；确保 DAG 为 `core ← shared ← panels ← edit-runtime` |
| 端口 15280 或 15173 被占用 | 另一个 vite 实例未停止 | `bash stop.sh`（studio 仓）或手动 `kill` 对应 PID |