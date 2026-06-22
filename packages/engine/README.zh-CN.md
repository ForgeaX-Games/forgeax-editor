<!-- LANG-SWITCH -->
**Language**: **简体中文** · [English](README.md)

> [!IMPORTANT]
> README 维护两份语言版本（[`README.md`](README.md) 主版本 · [`README.zh-CN.md`](README.zh-CN.md) 镜像），**任何改动须同时同步两份**。

---

# forgeax-engine

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](./tsconfig.base.json)
[![WebGPU](https://img.shields.io/badge/WebGPU-native-005A9C?logo=webgpu&logoColor=white)](./packages/rhi)

> **AI-first TypeScript 游戏引擎，目标超越 Three.js。**

引擎的第一用户不是人类开发者——是 **AI agent**。AI-friendly 与 human-friendly 冲突时，**AI 胜出**。详见 [AI 用户宪章](.claude/skills/forgeax-closed-loop/agents/ai-user-charter.md)。

## 设计宗旨

| 原则 | 含义 |
|---|---|
| **可机读 > 散文叙述** | API 通过 schema / manifest / 结构化类型自描述，AI 不读教程也能正确调用 |
| **显式失败 > 静默行为** | `Result<T, E>` + `.code` / `.expected` / `.hint`，禁止字符串传语义、禁止静默吞错 |
| **一致抽象 > 暴露实现** | 统一接口优先，性能 opt-in |
| **上下文经济** | API 表面积小、命名自解释、类型即文档 |

## 布局

两条独立依赖链：**runtime 根 = `@forgeax/engine-runtime`**，**build-time 根 = `@forgeax/engine-vite-plugin-shader`**。AI 用户通过 IDE 在 `@forgeax/engine-` 前缀下自动发现包家族。

| 路径 | 内容 |
|:--|:--|
| [`packages/`](packages/) | 引擎包（runtime / build-time 双链、RHI dual-impl、inspector、Rust wasm crate） |
| [`apps/`](apps/) | Demo / smoke / parity-bench 应用 |
| [`.knowledge-base/wiki/`](.knowledge-base/wiki/) | 设计基线（RHI / shader 策略、vs-threejs 路线 SSOT） |
| [`.claude/skills/`](.claude/skills/) | AI 协作 skill 集（charter + 闭环工作流） |
| [`.forgeax-harness/`](.forgeax-harness/) | 闭环工件（每个 feat/bug 的 plan / research / verify） |
| `forgeax-engine-assets/` | git submodule——二进制证据（private，工件旁挂仓） |

包级契约、错误 union、RHI 形态约束、度量登记、smoke gate、演进规则统一落在 [AGENTS.md](./AGENTS.md)。README 刻意保持精简。

## 快速开始

> [!IMPORTANT]
> 需要 **Node ≥ 22.13.0**、**pnpm ≥ 11.1.3**、**Bun ≥ 1.2.0**（SSOT：`.nvmrc` / `.pnpm-version` / `.bun-version`）。首次 clone 使用 `git clone --recurse-submodules <url>`。

```bash
pnpm install && pnpm -r build
pnpm test
pnpm dev                              # → http://localhost:5173
```

命令清单、smoke gate、Bun 管线、Rust toolchain 详见 [AGENTS.md §Commands](./AGENTS.md#commands)。

## License

Apache-2.0，完整文本见 [LICENSE](./LICENSE)。
