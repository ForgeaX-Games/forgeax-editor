<!-- LANG-SWITCH -->
**Language**: **English** · [简体中文](README.zh-CN.md)

> [!IMPORTANT]
> README is maintained in two languages ([`README.md`](README.md) canonical · [`README.zh-CN.md`](README.zh-CN.md) mirror). **Any change must update both in the same commit.**

---

# forgeax-engine

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](./tsconfig.base.json)
[![WebGPU](https://img.shields.io/badge/WebGPU-native-005A9C?logo=webgpu&logoColor=white)](./packages/rhi)

> **AI-first TypeScript game engine, built to surpass Three.js.**

The primary user of this engine is not a human developer — it is an **AI agent**. Whenever AI-friendly and human-friendly conflict, **AI wins**. See the [AI User Charter](.claude/skills/forgeax-closed-loop/agents/ai-user-charter.md).

## Design creed

| Principle | Meaning |
|---|---|
| **Machine-readable > prose** | API self-describes via schema / manifest / structured types; an AI can call it correctly without reading a tutorial |
| **Explicit failure > silent behavior** | `Result<T, E>` with `.code` / `.expected` / `.hint`; no string-encoded semantics, no swallowed errors |
| **Uniform abstraction > leaked internals** | One interface up front, performance knobs opt-in |
| **Context economy** | Small API surface, self-explanatory names, types are the documentation |

## Layout

Two independent dependency chains: **runtime root = `@forgeax/engine-runtime`**, **build-time root = `@forgeax/engine-vite-plugin-shader`**. AI users discover the family via IDE autocomplete on the `@forgeax/engine-` prefix.

| Path | Contents |
|:--|:--|
| [`packages/`](packages/) | Engine packages (runtime / build-time chains, RHI dual-impl, inspector, Rust wasm crate) |
| [`apps/`](apps/) | Demo + smoke + parity-bench applications |
| [`.forgeax-harness/knowledge-base/wiki/`](.forgeax-harness/knowledge-base/wiki/) | Design baselines (RHI / shader strategy, vs-threejs roadmap SSOT) |
| [`.claude/skills/`](.claude/skills/) | Agentic collaboration skills (charter + closed-loop workflows) |
| [`.forgeax-harness/`](.forgeax-harness/) | Closed-loop artefacts (plan / research / verify per feat/bug) |
| `forgeax-engine-assets/` | Git submodule — binary evidence (private, artefact sidecar) |

Package-level contracts, error unions, RHI form rules, metric registry, smoke gate, and evolution rules all live in [AGENTS.md](./AGENTS.md). The README is intentionally thin.

## Quick start

> [!IMPORTANT]
> Requires **Node ≥ 22.13.0**, **pnpm ≥ 11.1.3**, **Bun ≥ 1.2.0** (SSOT: `.nvmrc` / `.pnpm-version` / `.bun-version`). First-time clone: `git clone --recurse-submodules <url>`.

```bash
pnpm install && pnpm build            # tsup (.mjs) + tsc -b (.d.ts)
pnpm test
pnpm dev                              # → http://localhost:5173
```

Commands, smoke gate, Bun pipeline, Rust toolchain — see [AGENTS.md §Commands](./AGENTS.md#commands).

## License

Apache-2.0. See [LICENSE](./LICENSE).
